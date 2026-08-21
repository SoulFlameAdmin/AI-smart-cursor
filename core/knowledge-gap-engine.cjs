"use strict";
// DAVID_KNOWLEDGE_GAP_ENGINE_V20

const DEFAULT_STOPWORDS = new Set([
  "a","an","and","are","as","at","be","by","do","for","from","how","i","in",
  "is","it","make","me","of","on","or","please","the","this","to","with","you",
  "create","build","give","show","tell","use",
  "а","аз","ако","в","във","да","до","за","и","или","как","като","което",
  "коя","кой","които","ми","на","направи","не","от","по","покажи","с","със",
  "това","трябва","ще","използвай","дай","искам"
]);

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\p{L}\p{N}+#._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalize(value);
  if (!normalized) return [];
  return [...new Set(
    normalized.split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => token.length >= 3)
      .filter((token) => !DEFAULT_STOPWORDS.has(token))
  )];
}

function safeRegex(pattern, flags = "") {
  try { return new RegExp(pattern, flags); }
  catch { return null; }
}

function approvedSkill(skill) {
  if (!skill || typeof skill !== "object") return false;
  const status = normalize(skill.status || "");
  const source = normalize(skill.source || "");
  return status === "approved" || source === "builtin";
}

function matchApprovedSkill(task, skills = []) {
  const matches = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!approvedSkill(skill)) continue;
    const matcher = skill.matcher || {};

    if (matcher.type === "regex" && typeof matcher.pattern === "string") {
      const regex = safeRegex(matcher.pattern, String(matcher.flags || ""));
      if (regex && regex.test(String(task || ""))) {
        matches.push({
          skill_key: String(skill.skill_key || ""),
          title: String(skill.title || ""),
          source: String(skill.source || ""),
          status: String(skill.status || ""),
          risk_level: String(skill.risk_level || ""),
          proof: "approved_skill_regex_match"
        });
      }
      continue;
    }

    if (matcher.type === "exact" && normalize(matcher.value) === normalize(task)) {
      matches.push({
        skill_key: String(skill.skill_key || ""),
        title: String(skill.title || ""),
        source: String(skill.source || ""),
        status: String(skill.status || ""),
        risk_level: String(skill.risk_level || ""),
        proof: "approved_skill_exact_match"
      });
    }
  }
  return matches;
}

function approvedMemory(memory) {
  if (!memory || typeof memory !== "object") return false;
  const status = normalize(memory.status || "");
  if (status && !["active", "approved"].includes(status)) return false;
  if (memory.deleted_at) return false;
  if (memory.is_sensitive === true) return false;
  if (
    Object.prototype.hasOwnProperty.call(memory, "is_user_confirmed") &&
    memory.is_user_confirmed !== true
  ) return false;
  return true;
}

function memoryEvidence(task, memories = []) {
  const taskTokens = tokenize(task);
  if (taskTokens.length === 0) return [];
  const evidence = [];

  for (const memory of Array.isArray(memories) ? memories : []) {
    if (!approvedMemory(memory)) continue;
    const haystack = [
      memory.title,
      memory.content,
      memory.memory_type,
      Array.isArray(memory.tags)
        ? memory.tags.join(" ")
        : (memory.tags && typeof memory.tags === "object" ? JSON.stringify(memory.tags) : memory.tags)
    ].filter(Boolean).join(" ");

    const memoryTokens = new Set(tokenize(haystack));
    const overlap = taskTokens.filter((token) => memoryTokens.has(token));
    const coverage = overlap.length / taskTokens.length;
    const minOverlap = taskTokens.length === 1 ? 1 : 2;

    if (overlap.length >= minOverlap && coverage >= 0.34) {
      evidence.push({
        record_id: memory.id ?? memory.record_id ?? null,
        title: String(memory.title || ""),
        memory_type: String(memory.memory_type || ""),
        overlap_tokens: overlap,
        coverage: Number(coverage.toFixed(3)),
        proof: "approved_memory_token_overlap"
      });
    }
  }

  return evidence.sort((a, b) => b.coverage - a.coverage);
}

function analyzeKnowledgeGap({ task, memories = [], skills = [] } = {}) {
  const cleanTask = String(task || "").trim();
  if (!cleanTask) throw new Error("DAVID KNOWLEDGE GAP ENGINE requires a non-empty task.");

  const taskTokens = tokenize(cleanTask);
  const skillMatches = matchApprovedSkill(cleanTask, skills);
  const memoryMatches = memoryEvidence(cleanTask, memories);

  let classification = "UNKNOWN";
  let status = "KNOWLEDGE_GAP_DETECTED";
  let needsLearning = true;
  let confidence = 0.92;
  let reason = "No approved executable skill directly matches the task and approved memory does not provide sufficient evidence.";

  if (skillMatches.length > 0) {
    classification = "KNOWN";
    status = "KNOWLEDGE_AVAILABLE";
    needsLearning = false;
    confidence = 0.98;
    reason = "At least one approved executable skill directly matches the task.";
  } else if (memoryMatches.length > 0) {
    classification = "UNCERTAIN";
    status = "KNOWLEDGE_PARTIAL";
    needsLearning = true;
    confidence = 0.78;
    reason = "Approved memory contains relevant evidence, but no approved executable skill directly matches the task.";
  }

  return {
    protocol: "david_knowledge_gap_v20",
    status,
    classification,
    needs_learning: needsLearning,
    confidence,
    task: cleanTask,
    task_tokens: taskTokens,
    evidence: {
      approved_skill_matches: skillMatches,
      approved_memory_matches: memoryMatches
    },
    unknown: needsLearning ? [{
      requirement: cleanTask,
      reason: classification === "UNCERTAIN"
        ? "Relevant knowledge exists, but executable capability is not proven."
        : "Required capability/knowledge is absent from approved evidence."
    }] : [],
    known: skillMatches.map((match) => ({
      type: "skill",
      key: match.skill_key,
      title: match.title,
      proof: match.proof
    })),
    reason,
    generated_at: new Date().toISOString()
  };
}

module.exports = {
  normalize,
  tokenize,
  matchApprovedSkill,
  memoryEvidence,
  analyzeKnowledgeGap
};
