import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  MAX_BODY_BYTES,
  MAX_PROMPT_CHARS,
  MAX_REQUEST_KEY_CHARS,
  PROVIDER_OPERATIONS,
  PROVIDER_ROUTER_VERSION,
  PROVIDER_RPC,
  type ProviderOperation
} from "./contract.ts";

type JsonObject = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const operationSet = new Set<string>(PROVIDER_OPERATIONS);

function configuredOrigins(): Set<string> {
  return new Set(
    (Deno.env.get("DAVID_PROVIDER_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function headers(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  const value: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "vary": "Origin"
  };
  if (origin && configuredOrigins().has(origin)) {
    value["access-control-allow-origin"] = origin;
    value["access-control-allow-methods"] = "POST, OPTIONS";
    value["access-control-allow-headers"] = "authorization, apikey, content-type, x-client-info";
  }
  return value;
}

function json(request: Request, body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: headers(request) });
}

function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || configuredOrigins().has(origin);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_must_be_object`);
  }
  return value as JsonObject;
}

function assertKeys(value: JsonObject, allowed: string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new Error(`${label}_contains_unknown_field`);
  }
  if ("user_id" in value || "owner_id" in value || "email" in value) {
    throw new Error(`${label}_contains_identity_override`);
  }
  if (
    "api_key" in value ||
    "authorization" in value ||
    "cookie" in value ||
    "chat_url" in value
  ) {
    throw new Error(`${label}_contains_secret_material`);
  }
}

function text(value: unknown, max: number, label: string, required = true): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${label}_is_required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${label}_must_be_string`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${label}_is_invalid`);
  return result;
}

function uuid(value: unknown, label: string): string {
  const result = text(value, 36, label, true) as string;
  if (!UUID_PATTERN.test(result)) throw new Error(`${label}_is_invalid`);
  return result.toLowerCase();
}

function normalize(data: unknown): unknown {
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    if (data.length === 1) return data[0];
  }
  return data;
}

function safeError(error: unknown): { status: number; code: string } {
  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String((error as { message?: unknown })?.message ?? "").toLowerCase();

  if (message.includes("provider router is disabled")) return { status: 503, code: "provider_router_disabled" };
  if (message.includes("daily request limit")) return { status: 429, code: "daily_request_limit" };
  if (message.includes("active run limit")) return { status: 429, code: "active_run_limit" };
  if (message.includes("idempotency key conflict")) return { status: 409, code: "idempotency_conflict" };
  if (message.includes("does not belong") || message.includes("not enabled for this account")) {
    return { status: 403, code: "ownership_denied" };
  }
  if (
    message.includes("invalid") ||
    message.includes("required") ||
    message.includes("unknown_field") ||
    message.includes("secret_material") ||
    message.includes("identity_override")
  ) return { status: 400, code: "invalid_request" };
  return { status: 500, code: "provider_router_error" };
}

function rpcArgs(operation: Exclude<ProviderOperation, "health">, payload: JsonObject): JsonObject {
  switch (operation) {
    case "ensure_conversation":
      assertKeys(payload, ["twin_id", "provider", "model_key"], "payload");
      return {
        p_twin_id: uuid(payload.twin_id, "twin_id"),
        p_provider: text(payload.provider ?? "mock", 40, "provider", true),
        p_model_key: text(payload.model_key ?? "mock-david-v1", 120, "model_key", true)
      };

    case "create_run": {
      assertKeys(payload, ["conversation_id", "thread_id", "client_message_key", "prompt"], "payload");
      const key = text(payload.client_message_key, MAX_REQUEST_KEY_CHARS, "client_message_key", true) as string;
      if (key.length < 8 || !REQUEST_KEY_PATTERN.test(key)) throw new Error("client_message_key_is_invalid");
      return {
        p_conversation_id: uuid(payload.conversation_id, "conversation_id"),
        p_thread_id: uuid(payload.thread_id, "thread_id"),
        p_client_message_key: key,
        p_prompt: text(payload.prompt, MAX_PROMPT_CHARS, "prompt", true)
      };
    }

    case "get_run":
    case "list_run_events":
      assertKeys(payload, ["run_id"], "payload");
      return { p_run_id: uuid(payload.run_id, "run_id") };
  }
}

Deno.serve(async (request: Request) => {
  if (!allowedOrigin(request)) return json(request, { ok: false, error: "origin_denied" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(request) });
  if (request.method !== "POST") return json(request, { ok: false, error: "method_not_allowed" }, 405);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json(request, { ok: false, error: "request_too_large" }, 413);
  }

  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return json(request, { ok: false, error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!supabaseUrl || !anonKey) return json(request, { ok: false, error: "router_unavailable" }, 503);

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData.user) return json(request, { ok: false, error: "unauthorized" }, 401);

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json(request, { ok: false, error: "request_too_large" }, 413);
    }

    const body = asObject(JSON.parse(raw), "body");
    assertKeys(body, ["op", "payload"], "body");
    const opText = text(body.op, 80, "op", true) as string;
    if (!operationSet.has(opText)) return json(request, { ok: false, error: "unknown_operation" }, 400);
    const operation = opText as ProviderOperation;
    const payload = body.payload === undefined ? {} : asObject(body.payload, "payload");

    if (operation === "health") {
      assertKeys(payload, [], "payload");
      const { data, error } = await client.rpc("david_v2_gateway_status");
      if (error) throw error;
      return json(request, {
        ok: true,
        service: PROVIDER_ROUTER_VERSION,
        account_isolation_key: "auth.uid",
        provider_calls_enabled: false,
        status: normalize(data)
      });
    }

    const { data, error } = await client.rpc(PROVIDER_RPC[operation], rpcArgs(operation, payload));
    if (error) throw error;

    return json(request, {
      ok: true,
      operation,
      account_id: authData.user.id,
      data: normalize(data)
    });
  } catch (error) {
    const safe = safeError(error);
    console.error("DAVID_PROVIDER_ROUTER_ERROR", safe.code);
    return json(request, { ok: false, error: safe.code }, safe.status);
  }
});
