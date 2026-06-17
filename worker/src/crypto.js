/**
 * Password hashing and token utilities (WebCrypto — runs natively on Workers).
 *
 * Passwords: PBKDF2-HMAC-SHA256 with a per-user random salt. Stored as
 *   "pbkdf2$<iterations>$<saltHex>$<hashHex>"
 * (bcrypt/scrypt/argon2 would require a WASM dependency; PBKDF2 is native.)
 */

// Cloudflare Workers' WebCrypto caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, HASH_BITS
  );
  return new Uint8Array(bits);
}

/** Constant-time string compare (equal-length hex strings). */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Hash a plaintext password for storage. */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

/** Verify a plaintext password against a stored hash. */
export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = hexToBytes(parts[2]);
  const expected = parts[3];
  const actual = bytesToHex(await pbkdf2(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

/** SHA-256 hex digest — used to store invite tokens without keeping the raw value. */
export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** Generate a URL-safe random token (hex). */
export function randomToken(bytes = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
