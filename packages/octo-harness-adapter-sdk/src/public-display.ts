const SENSITIVE_OUTPUT_KEY = /(?:^|[_-])(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)(?:$|[_-])/i;

export function sanitizePublicValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_OUTPUT_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactCredentialText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 16) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map(item => sanitizePublicValue(item, "", depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, sanitizePublicValue(childValue, childKey, depth + 1)]));
}

function redactCredentialText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;&]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/:\/\/[^/\s:@]+:[^@\s/]+@/g, "://[REDACTED]@");
}
