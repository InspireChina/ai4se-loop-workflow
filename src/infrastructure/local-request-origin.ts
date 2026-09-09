const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizedHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
}

function isLoopbackHostname(hostname: string) {
  const normalized = normalizedHostname(hostname);
  return LOOPBACK_HOSTS.has(normalized) || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

/**
 * Desktop builds can expose the same loopback server as localhost or 127.0.0.1,
 * and Next.js may reconstruct request.url with a different loopback alias/port.
 * Treat those representations as local while continuing to reject web origins.
 */
export function isAllowedLocalRequestOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const target = new URL(request.url);
    if (source.origin === target.origin) return true;
    return source.protocol === 'http:'
      && target.protocol === 'http:'
      && isLoopbackHostname(source.hostname)
      && isLoopbackHostname(target.hostname);
  } catch {
    return false;
  }
}
