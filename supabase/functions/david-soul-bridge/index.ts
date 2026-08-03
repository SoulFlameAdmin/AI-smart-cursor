import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const DEVICE_TOKEN = Deno.env.get("DAVID_SOUL_DEVICE_TOKEN") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }

  return difference === 0;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength: number
): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || DEVICE_TOKEN.length < 32) {
    return json({ ok: false, error: "bridge_not_configured" }, 503);
  }

  const receivedToken = request.headers.get("x-david-device-token") ?? "";
  if (!(await constantTimeEqual(receivedToken, DEVICE_TOKEN))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: { op?: unknown; payload?: Record<string, unknown> };

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const op = String(body.op ?? "").trim();
  const payload = body.payload ?? {};

  try {
    if (op === "claim_soul_message") {
      const userId = String(payload.user_id ?? "").trim() || null;
      const worker = String(payload.worker ?? "david-soul-relay-v1").slice(0, 160);

      const { data, error } = await supabase.rpc(
        "claim_david_soul_message",
        {
          p_user_id: userId,
          p_worker: worker
        }
      );

      if (error) throw error;
      const message = Array.isArray(data) ? data[0] ?? null : data ?? null;

      return json({ ok: true, message });
    }

    if (op === "complete_soul_message") {
      const messageId = requiredString(payload.message_id, "message_id", 80);
      const answer = requiredString(payload.answer, "answer", 200000);
      const userId = String(payload.user_id ?? "").trim();

      let query = supabase
        .from("david_soul_messages")
        .update({
          status: "completed",
          answer,
          error: null,
          lease_until: null,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", messageId)
        .eq("status", "processing");

      if (userId) query = query.eq("user_id", userId);

      const { data, error } = await query.select("id").maybeSingle();
      if (error) throw error;
      if (!data) return json({ ok: false, error: "message_not_claimed" }, 409);

      return json({ ok: true, message_id: messageId });
    }

    if (op === "fail_soul_message") {
      const messageId = requiredString(payload.message_id, "message_id", 80);
      const errorText = requiredString(payload.error, "error", 4000);
      const userId = String(payload.user_id ?? "").trim();

      let query = supabase
        .from("david_soul_messages")
        .update({
          status: "failed",
          error: errorText,
          lease_until: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", messageId)
        .eq("status", "processing");

      if (userId) query = query.eq("user_id", userId);

      const { data, error } = await query.select("id").maybeSingle();
      if (error) throw error;
      if (!data) return json({ ok: false, error: "message_not_claimed" }, 409);

      return json({ ok: true, message_id: messageId });
    }

    if (op === "log_event") {
      // The SOUL relay does not require a separate log table to function.
      return json({ ok: true, accepted: true });
    }

    if (op === "health") {
      return json({ ok: true, service: "david-soul-bridge-v1" });
    }

    return json({ ok: false, error: "unsupported_operation" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message.slice(0, 2000) }, 500);
  }
});
