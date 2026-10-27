const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /(password|passphrase|secret|token|authorization|cookie|card|cvv|pin|signature|payment(data|details|credential)|bankaccount|api[_-]?key|print[_-]device[_-]key|private[_-]?key|service[_-]?role[_-]?key|checksum[_-]?key)/i;
const SENSITIVE_TEXT_PATTERN =
  /(\b[\w-]*(?:password|passphrase|token|secret|authorization|cookie|card(?:number)?|cvv|pin|signature|bank[_-]?account|api[_-]?key|print-device-key|private[_-]?key|service[_-]?role[_-]?key|checksum[_-]?key)["']?\s*[:=]\s*|\b(?:password|passphrase|secret|authorization)\s+)(?:(?:Bearer|Basic)\s+)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s;&}"']+)/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function redactLogValue(
  value: unknown,
  key?: string,
  seen = new WeakSet<object>(),
): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === 'string') {
    if (/^\s*[[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        return JSON.stringify(redactLogValue(parsed, undefined, seen));
      } catch {
        // Embedded or malformed JSON still needs text redaction.
      }
    }
    return value
      .replace(/(\b(?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`)
      .replace(SENSITIVE_TEXT_PATTERN, `$1${REDACTED}`)
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
      .replace(/(api\.telegram\.org\/bot)[^/\s?]+/gi, `$1${REDACTED}`)
      .replace(JWT_PATTERN, REDACTED);
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    return redactLogValue(
      {
        ...value,
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      undefined,
      seen,
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry, undefined, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactLogValue(entryValue, entryKey, seen),
    ]),
  );
}
