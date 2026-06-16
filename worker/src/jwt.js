/**
 * Minimal HS256 JWT sign/verify using WebCrypto (HMAC-SHA256).
 * Secret comes from the Worker secret JWT_SECRET.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_TTL = 7 * 24 * 3600; // 7 days

function base64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function encodeSegment(obj) {
  return base64urlFromBytes(encoder.encode(JSON.stringify(obj)));
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

/** Sign a payload. Adds iat/exp automatically. */
export async function signJwt(payload, secret, ttlSeconds = DEFAULT_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const data = `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(body)}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return `${data}.${base64urlFromBytes(new Uint8Array(sig))}`;
}

/** Verify a token. Returns the payload, or null if invalid/expired. */
export async function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  try {
    const key = await importKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC', key, bytesFromBase64url(sig), encoder.encode(`${header}.${body}`)
    );
    if (!valid) return null;

    const payload = JSON.parse(decoder.decode(bytesFromBase64url(body)));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
