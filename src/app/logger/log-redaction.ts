const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /(password|passphrase|secret|token|authorization|cookie|card|cvv|pin|signature|payment(data|details|credential)|bankaccount)/i;
const SENSITIVE_TEXT_PATTERN =
  /\b(password|passphrase|secret|access[_-]?token|refresh[_-]?token|authorization|cookie|card(?:number)?|cvv|pin|signature|bank[_-]?account)\b(\s*[:=]\s*|\s+)(["']?)[^,\s;&}"']+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function redactLogValue(
  value: unknown,
  key?: string,
  seen = new WeakSet<object>(),
): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === 'string') {
    return value
      .replace(SENSITIVE_TEXT_PATTERN, `$1$2${REDACTED}`)
      .replace(JWT_PATTERN, REDACTED);
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

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
