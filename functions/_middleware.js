// Password-protects the whole site (page and API) with HTTP Basic Auth, so
// nobody without the team password can use your Anthropic credit or read
// client data. Set APP_PASSWORD in the Cloudflare dashboard; if it's missing
// the site stays locked rather than open.
const REALM = 'Expense Parser';

function unauthorized(message) {
  return new Response(message, {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` },
  });
}

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export async function onRequest({ request, env, next }) {
  if (!env.APP_PASSWORD) {
    return new Response('This site is locked: set APP_PASSWORD in the Cloudflare dashboard.', { status: 503 });
  }
  const header = request.headers.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return unauthorized('Sign in required.');

  let password = '';
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
    password = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return unauthorized('Sign in required.');
  }
  if (!(await sameSecret(password, env.APP_PASSWORD))) return unauthorized('Wrong password.');
  return next();
}
