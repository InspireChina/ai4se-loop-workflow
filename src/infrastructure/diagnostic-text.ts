const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/ig;
const SECRET_PATTERN = /((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[=:]\s*)([^\s,;]+)|("(?:api[_-]?key|token|secret|password|authorization|cookie)"\s*:\s*")([^"]*)(")/ig;

export function sanitizeDiagnosticText(input: unknown, limit = 12_000) {
  const value = String(input ?? '')
    .replace(AUTHORIZATION_PATTERN, (_match, scheme) => `${scheme} [REDACTED]`)
    .replace(
    SECRET_PATTERN,
    (match, barePrefix, _bareValue, jsonPrefix, _jsonValue, jsonQuote) => {
      if (jsonPrefix !== undefined) return `${jsonPrefix}[REDACTED]${jsonQuote || '"'}`;
      if (barePrefix !== undefined) return `${barePrefix}[REDACTED]`;
      return match;
    },
  );
  return value.length > limit ? `…${value.slice(-(limit - 1))}` : value;
}
