import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  GATEWAY_VERSION,
  MAX_BODY_BYTES,
  MAX_REQUEST_KEY_CHARS,
  MAX_RESPONSE_BYTES,
  MUTATION_OPERATIONS,
  OPERATIONS,
  OPERATION_RPC,
  type GatewayOperation
} from "./contract.ts";

type JsonObject = Record<string, unknown>;

type SafeError = {
  code: string;
  status: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const operationSet = new Set<string>(OPERATIONS);

function configuredOrigins(): Set<string> {
  return new Set(
    (Deno.env.get("DAVID_GATEWAY_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "vary": "Origin"
  };

  if (origin && configuredOrigins().has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-allow-headers"] = "authorization, apikey, content-type, x-client-info";
    headers["access-control-max-age"] = "600";
  }

  return headers;
}

function json(request: Request, body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request)
  });
}

function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || configuredOrigins().has(origin);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_must_be_object`);
  }
  return value as JsonObject;
}

function assertAllowedKeys(value: JsonObject, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label}_contains_unknown_field`);
  }
}

function optionalString(value: unknown, max: number, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label}_must_be_string`);
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${label}_is_invalid`);
  return text;
}

function requiredString(value: unknown, max: number, label: string): string {
  const text = optionalString(value, max, label);
  if (!text) throw new Error(`${label}_is_required`);
  return text;
}

function optionalUuid(value: unknown, label: string): string | null {
  const text = optionalString(value, 36, label);
  if (!text) return null;
  if (!UUID_PATTERN.test(text)) throw new Error(`${label}_is_invalid`);
  return text.toLowerCase();
}

function requiredUuid(value: unknown, label: string): string {
  const text = optionalUuid(value, label);
  if (!text) throw new Error(`${label}_is_required`);
  return text;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const input = value as JsonObject;
    const output: JsonObject = {};
    for (const key of Object.keys(input).sort()) output[key] = canonicalize(input[key]);
    return output;
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeRpcData(data: unknown): unknown {
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    if (data.length === 1) return data[0];
  }
  return data;
}

function safeError(error: unknown): SafeError {
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String((error as { message?: unknown })?.message ?? "").toLowerCase();

  if (message.includes("gateway is disabled")) return { code: "gateway_disabled", status: 503 };
  if (message.includes("multi-user runtime is disabled")) return { code: "runtime_disabled", status: 503 };
  if (message.includes("rollout is closed")) return { code: "rollout_closed", status: 403 };
  if (message.includes("rollout limit")) return { code: "rollout_limit_reached", status: 429 };
  if (message.includes("identity is not provisioned")) return { code: "identity_not_provisioned", status: 409 };
  if (message.includes("idempotency key conflict")) return { code: "idempotency_key_conflict", status: 409 };
  if (message.includes("does not belong") || message.includes("not active for this user")) {
    return { code: "ownership_denied", status: 403 };
  }
  if (
    message.includes("is invalid")
    || message.includes("is required")
    || message.includes("must be")
    || message.includes("unknown field")
    || message.includes("not allowed")
  ) return { code: "invalid_request", status: 400 };

  return { code: "gateway_internal_error", status: 500 };
}

function rpcArgs(operation: Exclude<GatewayOperation, "health">, payload: JsonObject): JsonObject {
  switch (operation) {
    case "bootstrap":
    case "get_identity":
    case "list_conversations":
    case "list_threads":
      assertAllowedKeys(payload, [], "payload");
      return {};

    case "set_consent": {
      assertAllowedKeys(payload, ["twin_id", "consent_key", "consent_version", "granted", "scopes"], "payload");
      if (typeof payload.granted !== "boolean") throw new Error("granted_must_be_boolean");
      const scopes = payload.scopes ?? [];
      if (!Array.isArray(scopes) || scopes.length > 32) throw new Error("scopes_must_be_array");
      for (const scope of scopes) requiredString(scope, 80, "scope");
      return {
        p_twin_id: requiredUuid(payload.twin_id, "twin_id"),
        p_consent_key: requiredString(payload.consent_key, 80, "consent_key"),
        p_consent_version: requiredString(payload.consent_version, 40, "consent_version"),
        p_granted: payload.granted,
        p_scopes: scopes
      };
    }

    case "list_consents":
      assertAllowedKeys(payload, ["twin_id"], "payload");
      return { p_twin_id: optionalUuid(payload.twin_id, "twin_id") };

    case "register_local_conversation":
      assertAllowedKeys(payload, ["twin_id", "model_key"], "payload");
      return {
        p_twin_id: requiredUuid(payload.twin_id, "twin_id"),
        p_model_key: optionalString(payload.model_key, 120, "model_key") ?? "local"
      };

    case "create_thread":
      assertAllowedKeys(payload, ["conversation_id", "title", "client_thread_key"], "payload");
      return {
        p_conversation_id: requiredUuid(payload.conversation_id, "conversation_id"),
        p_title: optionalString(payload.title, 120, "title") ?? "Разговор с DAVID",
        p_client_thread_key: optionalString(payload.client_thread_key, 160, "client_thread_key")
      };
  }
}

function beginScope(operation: GatewayOperation, payload: JsonObject): { twinId: string | null; conversationId: string | null } {
  if (operation === "set_consent" || operation === "register_local_conversation") {
    return { twinId: requiredUuid(payload.twin_id, "twin_id"), conversationId: null };
  }
  if (operation === "create_thread") {
    return { twinId: null, conversationId: requiredUuid(payload.conversation_id, "conversation_id") };
  }
  return { twinId: null, conversationId: null };
}

Deno.serve(async (request: Request) => {
  if (!isOriginAllowed(request)) return json(request, { ok: false, error: "origin_denied" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { ok: false, error: "method_not_allowed" }, 405);

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json(request, { ok: false, error: "request_too_large" }, 413);
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return json(request, { ok: false, error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !anonKey) {
    console.error("DAVID_GATEWAY_CONFIG_MISSING");
    return json(request, { ok: false, error: "gateway_unavailable" }, 503);
  }

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData.user) return json(request, { ok: false, error: "unauthorized" }, 401);

  let operation: GatewayOperation | null = null;
  let activeRequestId: string | null = null;

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json(request, { ok: false, error: "request_too_large" }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json(request, { ok: false, error: "invalid_json" }, 400);
    }

    const body = asObject(parsed, "body");
    assertAllowedKeys(body, ["op", "payload", "request_key"], "body");
    if ("user_id" in body || "owner_id" in body) throw new Error("body_contains_unknown_field");

    const opValue = requiredString(body.op, 80, "op");
    if (!operationSet.has(opValue)) return json(request, { ok: false, error: "unknown_operation" }, 400);
    operation = opValue as GatewayOperation;

    const payload = body.payload === undefined ? {} : asObject(body.payload, "payload");
    if ("user_id" in payload || "owner_id" in payload) throw new Error("payload_contains_unknown_field");

    if (operation === "health") {
      assertAllowedKeys(payload, [], "payload");
      const { data, error } = await client.rpc("david_v2_gateway_status");
      if (error) throw error;
      return json(request, {
        ok: true,
        service: GATEWAY_VERSION,
        status: normalizeRpcData(data)
      });
    }

    const args = rpcArgs(operation, payload);
    const mutation = MUTATION_OPERATIONS.has(operation);

    if (!mutation) {
      if (body.request_key !== undefined) throw new Error("request_key_is_invalid");
      const { data, error } = await client.rpc(OPERATION_RPC[operation], args);
      if (error) throw error;
      return json(request, { ok: true, operation, data: normalizeRpcData(data) });
    }

    const requestKey = requiredString(body.request_key, MAX_REQUEST_KEY_CHARS, "request_key");
    if (requestKey.length < 8 || !REQUEST_KEY_PATTERN.test(requestKey)) throw new Error("request_key_is_invalid");

    const requestHash = await sha256(JSON.stringify(canonicalize({ operation, payload })));
    const scope = beginScope(operation, payload);
    const { data: beginData, error: beginError } = await client.rpc("david_v2_gateway_begin_my_request", {
      p_operation: operation,
      p_request_key: requestKey,
      p_request_hash: requestHash,
      p_twin_id: scope.twinId,
      p_conversation_id: scope.conversationId
    });
    if (beginError) throw beginError;

    const begin = normalizeRpcData(beginData) as JsonObject | null;
    if (!begin) throw new Error("gateway_begin_failed");
    activeRequestId = requiredUuid(begin.gateway_request_id, "gateway_request_id");

    if (begin.replay === true && begin.request_status === "completed") {
      return json(request, asObject(begin.response_body, "response_body"), Number(begin.http_status ?? 200));
    }

    if (begin.replay === true && begin.request_status === "failed") {
      return json(request, { ok: false, error: String(begin.error_code ?? "request_failed") }, Number(begin.http_status ?? 409));
    }

    if (begin.acquired !== true) {
      return json(request, { ok: false, error: "request_in_progress", request_id: activeRequestId }, 409);
    }

    const { data, error } = await client.rpc(OPERATION_RPC[operation], args);
    if (error) throw error;

    const responseBody: JsonObject = { ok: true, operation, data: normalizeRpcData(data) };
    if (new TextEncoder().encode(JSON.stringify(responseBody)).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("gateway_response_too_large");
    }

    const { error: completeError } = await client.rpc("david_v2_gateway_complete_my_request", {
      p_gateway_request_id: activeRequestId,
      p_http_status: 200,
      p_response_body: responseBody
    });
    if (completeError) throw completeError;

    return json(request, responseBody, 200);
  } catch (error) {
    const safe = safeError(error);

    if (activeRequestId) {
      const { error: failError } = await client.rpc("david_v2_gateway_fail_my_request", {
        p_gateway_request_id: activeRequestId,
        p_http_status: safe.status,
        p_error_code: safe.code
      });
      if (failError) console.error("DAVID_GATEWAY_FAIL_RECEIPT_ERROR", activeRequestId);
    }

    console.error("DAVID_GATEWAY_ERROR", operation ?? "unknown", activeRequestId ?? "none", safe.code);
    return json(request, { ok: false, error: safe.code, request_id: activeRequestId }, safe.status);
  }
});
