// POST /api/ai — forwards one extraction prompt (plus any attached images or
// PDFs) to Claude and returns the model's text. The API key stays here on the
// server; the browser never sees it.
//
// The model is a setting, not code: set CLAUDE_MODEL in the Cloudflare
// dashboard to switch models (e.g. when one is retired) without a redeploy of
// any code.
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 32000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Server-side refusal fallbacks: if the model's safety classifiers decline a
// request, the API re-runs it on Anthropic's recommended substitute in the
// same call. Only sent for models that support it.
const SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5)/;

function errorResponse(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return errorResponse(500, 'not_configured', 'The server has no ANTHROPIC_API_KEY set — add it in the Cloudflare dashboard.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'bad_request', 'Request body was not valid JSON.');
  }

  const { prompt, images = [], documents = [] } = body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return errorResponse(400, 'bad_request', 'Missing prompt.');
  }
  if (!Array.isArray(images) || !Array.isArray(documents)) {
    return errorResponse(400, 'bad_request', 'images and documents must be arrays.');
  }
  for (const img of images) {
    if (!img || !IMAGE_TYPES.has(img.media_type) || typeof img.data !== 'string') {
      return errorResponse(400, 'image_rejected', 'Images must be PNG, JPEG, GIF or WebP.');
    }
  }
  for (const doc of documents) {
    if (!doc || doc.media_type !== 'application/pdf' || typeof doc.data !== 'string') {
      return errorResponse(400, 'bad_request', 'Documents must be PDFs.');
    }
  }

  const content = [
    ...documents.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.data } })),
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
    { type: 'text', text: prompt },
  ];

  const model = (env.CLAUDE_MODEL || DEFAULT_MODEL).trim();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const params = { model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] };

  let message;
  try {
    // Streaming keeps long extractions (big bank statements) clear of HTTP
    // timeouts; finalMessage() just waits for the complete response.
    message = SUPPORTS_FALLBACKS.test(model)
      ? await client.beta.messages
          .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          .finalMessage()
      : await client.messages.stream(params).finalMessage();
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return errorResponse(500, 'not_configured', 'The server\'s ANTHROPIC_API_KEY was rejected — check it in the Cloudflare dashboard.');
    }
    if (error instanceof Anthropic.NotFoundError) {
      return errorResponse(500, 'not_configured', `Model "${model}" was not found — it may have been retired. Update CLAUDE_MODEL in the Cloudflare dashboard.`);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return errorResponse(429, 'rate_limited', 'Too many requests right now — please wait a moment and try again.');
    }
    if (error instanceof Anthropic.APIError && error.status === 413) {
      return errorResponse(413, 'prompt_too_large', 'That file is too large for one request.');
    }
    if (error instanceof Anthropic.BadRequestError) {
      return errorResponse(400, 'bad_request', error.message);
    }
    if (error instanceof Anthropic.APIError) {
      return errorResponse(502, 'server_error', `Claude API error ${error.status ?? ''}: ${error.message}`);
    }
    return errorResponse(502, 'server_error', 'Could not reach the Claude API.');
  }

  if (message.stop_reason === 'refusal') {
    return errorResponse(422, 'refused', 'Claude declined to process that input.');
  }
  if (message.stop_reason === 'max_tokens') {
    return errorResponse(413, 'prompt_too_large', 'The response was too long to finish — try splitting the file into smaller parts.');
  }

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return Response.json({ text, model: message.model });
}
