"use strict";

const DAVID_MARKER = /^\s*-david\b[\s:,-]*/iu;

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function parseDavidInput(value) {
  const raw = normalizeText(value);
  const isUpgradeRequest = DAVID_MARKER.test(raw);

  if (!isUpgradeRequest) {
    return {
      kind: "command",
      marker: null,
      request: raw,
      requiresTeacher: false
    };
  }

  const request = raw.replace(DAVID_MARKER, "").trim();

  return {
    kind: "upgrade_request",
    marker: "-david",
    request,
    requiresTeacher: true,
    needsClarification: request.length === 0
  };
}

module.exports = {
  DAVID_MARKER,
  normalizeText,
  parseDavidInput
};
