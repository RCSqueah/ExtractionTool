// GET/PUT /api/db/<path> — the shared per-client storage (chart of accounts,
// coding history, notes, and the client list), one JSON document per path,
// kept in the EXPENSES_DB Cloudflare KV namespace. Everyone signed in to the
// site reads and writes the same documents.
const VALID_KEY = /^[a-z0-9\-]+(\/[a-z0-9\-]+)*$/i;
const MAX_BYTES = 5 * 1024 * 1024;

function errorResponse(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

function keyFrom(params) {
  const parts = Array.isArray(params.path) ? params.path : [params.path];
  const key = parts.join('/');
  return key.length <= 200 && VALID_KEY.test(key) ? key : null;
}

export async function onRequestGet({ params, env }) {
  if (!env.EXPENSES_DB) return errorResponse(500, 'not_configured', 'No EXPENSES_DB KV binding — see README.');
  const key = keyFrom(params);
  if (!key) return errorResponse(400, 'bad_request', 'Invalid document path.');
  const value = await env.EXPENSES_DB.get(key);
  if (value === null) return errorResponse(404, 'not_found', 'No such document.');
  return new Response(value, { headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPut({ params, env, request }) {
  if (!env.EXPENSES_DB) return errorResponse(500, 'not_configured', 'No EXPENSES_DB KV binding — see README.');
  const key = keyFrom(params);
  if (!key) return errorResponse(400, 'bad_request', 'Invalid document path.');
  const text = await request.text();
  if (text.length > MAX_BYTES) return errorResponse(413, 'too_large', 'Document too large.');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  } catch {
    return errorResponse(400, 'bad_request', 'Document must be a JSON object.');
  }
  await env.EXPENSES_DB.put(key, text);
  return new Response(null, { status: 204 });
}
