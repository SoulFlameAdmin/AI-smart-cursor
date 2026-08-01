"use strict";

function matchSkill(command, skills) {
  const sorted = [...skills].sort((a, b) => {
    const aVerified = ["approved", "local_verified"].includes(a.status) ? 1 : 0;
    const bVerified = ["approved", "local_verified"].includes(b.status) ? 1 : 0;
    if (aVerified !== bVerified) return bVerified - aVerified;
    return Number(b.version || 0) - Number(a.version || 0);
  });

  for (const skill of sorted) {
    try {
      const matcher = skill.matcher || {};
      const regex = new RegExp(matcher.pattern, matcher.flags || "iu");
      const match = regex.exec(command);

      if (!match) continue;

      const variables = {};
      const names = Array.isArray(matcher.variables)
        ? matcher.variables
        : [];

      names.forEach((name, index) => {
        variables[name] = String(match[index + 1] || "").trim();
      });

      return { skill, variables };
    } catch {
      continue;
    }
  }

  return null;
}

function renderTemplate(value, variables) {
  if (typeof value === "string") {
    return value
      .replace(/\{\{url:([a-zA-Z0-9_]+)\}\}/g, (_all, key) =>
        encodeURIComponent(variables[key] ?? "")
      )
      .replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_all, key) =>
        String(variables[key] ?? "")
      );
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplate(item, variables));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderTemplate(item, variables)
      ])
    );
  }

  return value;
}

module.exports = { matchSkill, renderTemplate };
