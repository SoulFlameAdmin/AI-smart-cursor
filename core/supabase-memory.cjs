"use strict";

const crypto = require("crypto");

const MEMORY_TABLE = "sf_twin_memories";
const MEMORY_TYPES = new Set([
  "fact",
  "lesson",
  "preference",
  "procedure",
  "skill"
]);
const MAX_MEMORY_TITLE_CHARS = 200;
const MAX_MEMORY_CONTENT_CHARS = 20000;
const MAX_CONTEXT_MEMORIES = 20;
const MAX_CONTEXT_CHARS = 12000;
const READ_FIELDS = [
  "id",
  "owner_id",
  "memory_type",
  "title",
  "content",
  "content_checksum",
  "status",
  "source",
  "evidence",
  "approval_method",
  "approved_at",
  "created_at",
  "updated_at"
].join(", ");

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}

function normalizeMemoryContent(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function boundedJson(value, fallback, maxChars = 8000) {
  let text;
  try {
    text = JSON.stringify(value ?? fallback);
  } catch {
    throw new Error("MEMORY_METADATA_NOT_SERIALIZABLE");
  }
  if (text.length > maxChars) throw new Error("MEMORY_METADATA_TOO_LARGE");
  return JSON.parse(text);
}

function assertNoSecretKeys(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|authorization|credential|private[_-]?key/i.test(key)) {
      throw new Error(`MEMORY_SECRET_KEY_REJECTED:${[...trail, key].join(".")}`);
    }
    assertNoSecretKeys(child, [...trail, key]);
  }
}

function assertNoSecretMaterial(value) {
  const text = String(value || "");
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:sk|sbp)[-_][a-z0-9._-]{20,}\b/i,
    /\beyJ[a-z0-9._-]{30,}\b/i,
    /\b(?:service[_-]?role|api[_-]?key|token|password|authorization)\b\s*[:=]\s*\S{8,}/i
  ];
  if (patterns.some((pattern) => pattern.test(text))) {
    throw new Error("MEMORY_SECRET_MATERIAL_REJECTED");
  }
}

function normalizeMemoryInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INVALID_MEMORY_INPUT");
  }
  if (input.humanApproved !== true) {
    throw new Error("HUMAN_APPROVAL_REQUIRED");
  }

  const title = String(input.title || "").trim();
  const content = normalizeMemoryContent(input.content);
  const memoryType = String(input.memoryType || "lesson").trim().toLowerCase();
  if (!title || title.length > MAX_MEMORY_TITLE_CHARS) {
    throw new Error("INVALID_MEMORY_TITLE");
  }
  if (!content || content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error("INVALID_MEMORY_CONTENT");
  }
  assertNoSecretMaterial(content);
  if (!MEMORY_TYPES.has(memoryType)) {
    throw new Error("INVALID_MEMORY_TYPE");
  }

  const source = boundedJson(input.source, {}, 4000);
  const evidence = boundedJson(input.evidence, [], 8000);
  if (!Array.isArray(evidence)) throw new Error("INVALID_MEMORY_EVIDENCE");
  assertNoSecretKeys(source);
  assertNoSecretKeys(evidence);

  return {
    title,
    content,
    memoryType,
    contentChecksum: sha256(content),
    source,
    evidence
  };
}

function buildMemoryContext(context, memories, options = {}) {
  const maxMemories = Math.max(
    1,
    Math.min(Number(options.maxMemories) || MAX_CONTEXT_MEMORIES, 50)
  );
  const maxChars = Math.max(
    1000,
    Math.min(Number(options.maxChars) || MAX_CONTEXT_CHARS, 50000)
  );
  const safe = [];
  let usedChars = 0;

  for (const row of memories || []) {
    if (!row || row.status !== "active") continue;
    const title = String(row.title || "").trim();
    const content = normalizeMemoryContent(row.content);
    const memoryType = String(row.memory_type || "lesson").trim().toLowerCase();
    const checksum = String(row.content_checksum || "").trim().toLowerCase();
    if (!title || !content || !MEMORY_TYPES.has(memoryType)) continue;
    if (!/^[0-9a-f]{64}$/.test(checksum) || sha256(content) !== checksum) continue;
    const size = title.length + content.length + memoryType.length + checksum.length;
    if (safe.length >= maxMemories || usedChars + size > maxChars) break;
    safe.push({
      record_id: String(row.id || ""),
      memory_type: memoryType,
      title,
      content,
      checksum
    });
    usedChars += size;
  }

  const base =
    context && typeof context === "object" && !Array.isArray(context)
      ? { ...context }
      : { base_context: context || null };
  if (safe.length > 0) base.approved_active_memories = safe;
  return base;
}

function verifyReadBack(row, expected) {
  if (!row || typeof row !== "object") throw new Error("MEMORY_READBACK_MISSING");
  if (!row.id) throw new Error("MEMORY_READBACK_ID_MISSING");
  if (!row.created_at || !Number.isFinite(Date.parse(row.created_at))) {
    throw new Error("MEMORY_READBACK_CREATED_AT_INVALID");
  }
  if (row.status !== "active") throw new Error("MEMORY_READBACK_STATUS_MISMATCH");
  if (row.owner_id !== expected.ownerId) throw new Error("MEMORY_READBACK_OWNER_MISMATCH");
  if (normalizeMemoryContent(row.content) !== expected.content) {
    throw new Error("MEMORY_READBACK_CONTENT_MISMATCH");
  }
  if (String(row.content_checksum || "").toLowerCase() !== expected.contentChecksum) {
    throw new Error("MEMORY_READBACK_CHECKSUM_MISMATCH");
  }
  if (sha256(row.content) !== expected.contentChecksum) {
    throw new Error("MEMORY_READBACK_HASH_VERIFICATION_FAILED");
  }
  return {
    status: "MEMORY_PROMOTED",
    table: MEMORY_TABLE,
    record_id: String(row.id),
    created_at: String(row.created_at),
    checksum: expected.contentChecksum,
    exact_match: true
  };
}

class SupabaseMemory {
  constructor({ config = {}, sendStatus, client = null, user = null } = {}) {
    this.config = config;
    this.sendStatus = sendStatus;
    this.client = client;
    this.user = user;
    this.connected = Boolean(client && user && user.id);
  }

  settings() {
    return {
      url: this.config.supabaseUrl || process.env.SUPABASE_URL || "",
      key:
        this.config.supabasePublishableKey ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        "",
      email: this.config.email || process.env.DAVID_USER_EMAIL || "",
      password: this.config.password || process.env.DAVID_USER_PASSWORD || ""
    };
  }

  isConfigured() {
    const settings = this.settings();
    return Boolean(
      settings.url && settings.key && settings.email && settings.password
    );
  }

  async initialize() {
    if (this.connected) return true;
    if (!this.isConfigured()) throw new Error("MEMORY_AUTH_NOT_CONFIGURED");

    const { createClient } = require("@supabase/supabase-js");
    const settings = this.settings();
    this.client = createClient(settings.url, settings.key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
    const response = await this.client.auth.signInWithPassword({
      email: settings.email,
      password: settings.password
    });
    if (response.error) throw response.error;
    if (!response.data?.user?.id) throw new Error("MEMORY_AUTH_USER_MISSING");
    this.user = response.data.user;
    this.connected = true;
    return true;
  }

  assertConnected() {
    if (!this.client || !this.user?.id || !this.connected) {
      throw new Error("MEMORY_NOT_CONNECTED");
    }
  }

  async fetchActiveMemories({ limit = 50 } = {}) {
    this.assertConnected();
    const response = await this.client
      .from(MEMORY_TABLE)
      .select(READ_FIELDS)
      .eq("owner_id", this.user.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(Number(limit) || 50, 100)));
    if (response.error) throw response.error;
    return (response.data || []).filter((row) => {
      const content = normalizeMemoryContent(row.content);
      return content && sha256(content) === String(row.content_checksum || "").toLowerCase();
    });
  }

  async findByChecksum(checksum) {
    const response = await this.client
      .from(MEMORY_TABLE)
      .select(READ_FIELDS)
      .eq("owner_id", this.user.id)
      .eq("content_checksum", checksum)
      .maybeSingle();
    if (response.error) throw response.error;
    return response.data || null;
  }

  async promoteApprovedMemory(input) {
    this.assertConnected();
    const normalized = normalizeMemoryInput(input);
    const expected = {
      ownerId: this.user.id,
      content: normalized.content,
      contentChecksum: normalized.contentChecksum
    };

    let row = await this.findByChecksum(normalized.contentChecksum);
    let idempotent = Boolean(row);
    const approvedAt = new Date().toISOString();

    if (row && row.status !== "active") throw new Error("MEMORY_EXISTING_NOT_ACTIVE");

    if (!row) {
      const insert = await this.client
        .from(MEMORY_TABLE)
        .insert({
          owner_id: this.user.id,
          memory_type: normalized.memoryType,
          title: normalized.title,
          content: normalized.content,
          status: "active",
          source: normalized.source,
          evidence: normalized.evidence,
          approval_method: "local_human_confirmation",
          approved_at: approvedAt,
          updated_at: approvedAt
        })
        .select(READ_FIELDS)
        .single();

      if (insert.error && insert.error.code !== "23505") throw insert.error;
      if (insert.error?.code === "23505") {
        idempotent = true;
        row = await this.findByChecksum(normalized.contentChecksum);
      } else {
        row = insert.data;
      }
    }

    const readBack = await this.client
      .from(MEMORY_TABLE)
      .select(READ_FIELDS)
      .eq("id", row?.id || "")
      .eq("owner_id", this.user.id)
      .single();
    if (readBack.error) throw readBack.error;

    return {
      ...verifyReadBack(readBack.data, expected),
      idempotent
    };
  }

  dispose() {
    this.connected = false;
    this.client = null;
    this.user = null;
  }
}

module.exports = {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_MEMORIES,
  MEMORY_TABLE,
  MEMORY_TYPES,
  SupabaseMemory,
  buildMemoryContext,
  normalizeMemoryContent,
  normalizeMemoryInput,
  sha256,
  verifyReadBack
};
