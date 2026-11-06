export const AFH_VERSION = "0.3.0";
export const SCHEMA_VERSION = 3;

export const EPISTEMIC = Object.freeze({
  DIRECT: "DIRECT_EVIDENCE",
  CORROBORATED: "CORROBORATED",
  INFERRED: "INFERRED",
  UNCERTAIN: "UNCERTAIN",
  CONTRADICTED: "CONTRADICTED",
  UNAVAILABLE: "UNAVAILABLE",
});

export const TASK_STATES = Object.freeze([
  "REQUESTED",
  "PLANNED",
  "ATTEMPTED",
  "COMPLETED",
  "VERIFIED",
  "DEFERRED",
  "BLOCKED",
  "FAILED",
  "SUPERSEDED",
  "REOPENED",
  "CONTRADICTED",
]);

export const ACTOR_KINDS = Object.freeze({
  USER: "HUMAN_USER",
  SYSTEM: "HARNESS_SYSTEM",
  AGENT: "PRIMARY_AGENT",
  SUBAGENT: "SUBAGENT",
  REVIEWER: "REVIEWER_AGENT",
  AUDITOR: "AUDITOR_AGENT",
  TOOL: "TOOL",
  MCP: "MCP_SERVER",
  HOOK: "HOOK",
  AUTOMATION: "AUTOMATION",
  CI: "CI_PROCESS",
  BACKGROUND: "BACKGROUND_PROCESS",
  SERVICE: "EXTERNAL_SERVICE",
  SESSION: "OTHER_SESSION",
  UNKNOWN: "UNKNOWN_EXTERNAL",
});

export const ARTIFACT_STATES = Object.freeze([
  "LIVE_VERIFIED",
  "LIVE_UNVERIFIED",
  "INTERMEDIATE",
  "EXPERIMENTAL",
  "SUPERSEDED",
  "DISCARDED",
  "FAILED",
  "MISSING",
  "UNKNOWN",
]);

export const DEFAULTS = Object.freeze({
  tokenBudget: 6000,
  maxRecordBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 8 * 1024 * 1024 * 1024,
  maxTotalSourceBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 250,
  previewChars: 1200,
  evidenceMode: "copy",
  includeChildren: true,
  maxChildSessions: 32,
  inlineBlobBytes: 16 * 1024,
  verificationLevel: "V0",
  graphHops: 1,
  maxGraphHops: 8,
  maxGraphNodes: 250,
});

export const SECRET_PATTERNS = Object.freeze([
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
]);
