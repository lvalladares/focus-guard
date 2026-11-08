export function parseHashTarget(hash) {
  if (typeof hash !== 'string' || hash.length === 0) return null;
  let raw = hash;
  if (raw.startsWith('#')) raw = raw.slice(1);
  if (raw.length === 0) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  try {
    new URL(decoded);
    return decoded;
  } catch {
    return null;
  }
}

export function safeParseUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function httpHostname(url) {
  const parsed = safeParseUrl(url);
  if (!parsed) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname;
}
