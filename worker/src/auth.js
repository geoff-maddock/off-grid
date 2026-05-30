/**
 * Simple bearer token authentication.
 * Token is stored as a Cloudflare Worker secret: ADMIN_TOKEN
 */

/**
 * Validates the Authorization header against the stored ADMIN_TOKEN.
 * Returns null if auth passes, or a 401 Response if it fails.
 */
export function requireAuth(request, env) {
  const header = request.headers.get('Authorization');
  if (!header) {
    return unauthorizedResponse('Missing Authorization header');
  }

  const token = header.replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return unauthorizedResponse('Invalid token');
  }

  return null; // Auth passed
}

function unauthorizedResponse(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
