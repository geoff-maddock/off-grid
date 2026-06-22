/**
 * Simple D1-backed login rate limiting, keyed by client IP.
 *
 * Throttles brute-force password guessing from a single source. Distributed
 * attacks (many IPs) are better handled by a Cloudflare WAF rate-limit rule —
 * this is the self-contained, code-level baseline.
 */

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 10;
const PRUNE_PROBABILITY = 0.05; // prune aged-out rows on ~5% of failures

// All helpers are fail-open: a limiter (D1) error must never block a legitimate
// login. An empty ip (no CF-Connecting-IP — local dev, off-Cloudflare) disables
// limiting for that request, since there's no source to key on.

/** True if this IP has hit the failed-attempt limit within the window. */
export async function tooManyAttempts(db, ip) {
  if (!ip) return false;
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND created_at > datetime('now', ?)`)
      .bind(ip, `-${WINDOW_MINUTES} minutes`)
      .first();
    return (row?.n ?? 0) >= MAX_FAILURES;
  } catch (e) {
    console.error('rate-limit check failed:', e);
    return false; // fail open
  }
}

/** Record a failed login; occasionally prune rows that aged out of the window. */
export async function recordFailedLogin(db, ip, email) {
  if (!ip) return;
  try {
    await db.prepare('INSERT INTO login_attempts (ip, email) VALUES (?, ?)').bind(ip, email || null).run();
    if (Math.random() < PRUNE_PROBABILITY) {
      await db
        .prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now', ?)`)
        .bind(`-${WINDOW_MINUTES} minutes`)
        .run();
    }
  } catch (e) {
    console.error('rate-limit record failed:', e);
  }
}

/** Clear an IP's failures after a successful login. */
export async function clearFailedLogins(db, ip) {
  if (!ip) return;
  try {
    await db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  } catch (e) {
    console.error('rate-limit clear failed:', e);
  }
}
