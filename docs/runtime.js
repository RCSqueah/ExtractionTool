// Browser-only stand-in for the Claude Artifact runtime (window.claude.use).
//
// The page was originally written against claude.ai's artifact capabilities —
// `sample` (ask Claude), `db` (storage) and `downloads` (save a file). This
// file provides the same shapes with no server, so index.html barely changes:
//
//   sample.json(prompt, { images, documents })  → Claude API, called straight
//                                                 from this browser with the
//                                                 key entered in ⚙ Settings
//   db.doc(path).get() / .set(obj)              → this browser's localStorage
//   downloads.save({ filename, data })          → ordinary browser download
//
// Errors carry a `.code` matching the runtime contract the page already
// branches on (rate_limited, prompt_too_large, refused, invalid_json, …).
//
// Everything here is single-user: the key, model and client data live in this
// browser only. Use ⚙ Settings → Back up to keep a copy of the client data.
(function () {
  if (window.claude && typeof window.claude.use === 'function') return;

  const DEFAULT_MODEL = 'claude-sonnet-5';
  const MAX_TOKENS = 64000;
  // Bundled copy of the official SDK (see README → "Updating the SDK").
  const SDK_URL = './vendor/anthropic-sdk-0.128.0.js';
  // Server-side refusal fallbacks: if the model's safety classifiers decline
  // a request, the API re-runs it on Anthropic's recommended substitute in
  // the same call. Only sent for models that support it.
  const SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5)/;

  const KEY_API = 'ep:apiKey';
  const KEY_MODEL = 'ep:model';
  const DB_PREFIX = 'ep:db:';

  // ── localStorage helpers (can throw in private windows / blocked storage) ──
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }
  function lsKeys() {
    try { return Object.keys(localStorage); } catch (_) { return []; }
  }

  function codedError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function toList(v) {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  function imageMediaType(file) {
    if (file.type) return file.type;
    return /\.png$/i.test(file.name || '') ? 'image/png' : 'image/jpeg';
  }

  // Models sometimes wrap JSON in code fences or add a sentence around it —
  // strip that and pull out the outermost object/array before parsing.
  function parseJsonLoose(text) {
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
    const starts = [cleaned.indexOf('['), cleaned.indexOf('{')].filter(i => i !== -1);
    if (starts.length) {
      const start = Math.min(...starts);
      const close = cleaned[start] === '[' ? ']' : '}';
      const end = cleaned.lastIndexOf(close);
      if (end > start) {
        try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) { /* fall through */ }
      }
    }
    throw codedError('invalid_json', `Response started: "${cleaned.slice(0, 150)}"`);
  }

  // ── sample: ask Claude ─────────────────────────────────────────────────────
  let sdkPromise = null;
  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = import(SDK_URL).then(m => m.default).catch(e => {
        sdkPromise = null;
        throw codedError('network', 'Could not load the Claude SDK — check your connection and reload.');
      });
    }
    return sdkPromise;
  }

  function currentModel() {
    return (lsGet(KEY_MODEL) || '').trim() || DEFAULT_MODEL;
  }

  async function askClaude(prompt, opts = {}) {
    const apiKey = (lsGet(KEY_API) || '').trim();
    if (!apiKey) {
      window.toggleSettingsPanel(true);
      throw codedError('not_configured', 'Add your Anthropic API key in ⚙ Settings (top right) first.');
    }
    const Anthropic = await loadSdk();

    const documents = await Promise.all(toList(opts.documents).map(async f => ({
      type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await fileToBase64(f) },
    })));
    const images = await Promise.all(toList(opts.images).map(async f => ({
      type: 'image', source: { type: 'base64', media_type: imageMediaType(f), data: await fileToBase64(f) },
    })));
    const content = [...documents, ...images, { type: 'text', text: prompt }];

    const model = currentModel();
    // The key is typed in by the only user of this browser, so calling the
    // API directly from the page is acceptable here; never ship a key in code.
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const params = { model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] };
    // Structured outputs: with a JSON schema, the API guarantees the reply is
    // valid JSON in exactly that shape (no stray quotes or truncated syntax).
    if (opts.schema) params.output_config = { format: { type: 'json_schema', schema: opts.schema } };

    // Streaming keeps long extractions (big bank statements) clear of HTTP
    // timeouts; finalMessage() just waits for the complete response.
    const send = () => SUPPORTS_FALLBACKS.test(model)
      ? client.beta.messages
          .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          .finalMessage()
      : client.messages.stream(params).finalMessage();

    // The SDK retries a request that fails to start, but not one whose
    // connection drops part-way through a long reply — retry those here,
    // along with overloaded / rate-limited / server errors, with a pause.
    const isTransient = e => !(e instanceof Anthropic.APIError)
      || e instanceof Anthropic.APIConnectionError
      || e instanceof Anthropic.RateLimitError
      || e.status === undefined || e.status === 408 || e.status === 409 || e.status >= 500;
    const RETRY_DELAYS_MS = [3000, 8000, 20000];

    let message;
    for (let attempt = 0; ; attempt++) {
      try {
        message = await send();
        break;
      } catch (error) {
        if (attempt < RETRY_DELAYS_MS.length && isTransient(error)) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        const detail = String((error && error.message) || error || '').slice(0, 160);
        if (error instanceof Anthropic.AuthenticationError) {
          throw codedError('not_configured', 'Your Anthropic API key was rejected — check it in ⚙ Settings.');
        }
        if (error instanceof Anthropic.NotFoundError) {
          throw codedError('not_configured', `Model "${model}" was not found — it may have been retired. Put a current model name in ⚙ Settings.`);
        }
        if (error instanceof Anthropic.RateLimitError) {
          throw codedError('rate_limited', 'Too many requests right now — please wait a moment and try again.');
        }
        if (error instanceof Anthropic.APIError && error.status === 413) {
          throw codedError('prompt_too_large', 'That file is too large for one request.');
        }
        if (error instanceof Anthropic.BadRequestError) {
          throw codedError('bad_request', error.message);
        }
        if (error instanceof Anthropic.APIConnectionError || !(error instanceof Anthropic.APIError)) {
          throw codedError('network', `Could not reach the Claude API after ${attempt + 1} attempts (${detail || 'connection dropped'}).`);
        }
        throw codedError('server_error', `Claude API error ${error.status ?? ''}: ${detail}`);
      }
    }

    if (message.stop_reason === 'refusal') {
      throw codedError('refused', 'Claude declined to process that input.');
    }
    if (message.stop_reason === 'max_tokens') {
      throw codedError('output_too_long', "Claude's reply was too long to finish — try splitting the file into smaller parts.");
    }
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  const sample = {
    async limits() {
      return { images: true, documents: true };
    },
    text: askClaude,
    // Retries once if the reply isn't valid JSON — rare, and usually fine on a
    // second attempt. Calls that pass a schema get guaranteed-valid JSON.
    async json(prompt, opts = {}) {
      try {
        return parseJsonLoose(await askClaude(prompt, opts));
      } catch (e) {
        if (e.code !== 'invalid_json') throw e;
        return parseJsonLoose(await askClaude(prompt, opts));
      }
    },
  };

  // ── db: this browser's storage ─────────────────────────────────────────────
  const db = {
    doc(path) {
      const key = DB_PREFIX + path;
      return {
        async get() {
          const raw = lsGet(key);
          if (raw === null) return { exists: false, data: () => undefined };
          const obj = JSON.parse(raw);
          return { exists: true, data: () => obj };
        },
        async set(obj) {
          if (!lsSet(key, JSON.stringify(obj))) {
            throw codedError('db_error', 'Could not save — this browser is blocking storage or it is full.');
          }
        },
      };
    },
  };

  // ── downloads ──────────────────────────────────────────────────────────────
  function saveFile(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const downloads = {
    async save({ filename, data }) {
      saveFile(filename, data instanceof Blob ? data : new Blob([data]));
      return { status: 'saved' };
    },
  };

  const caps = { sample, db, downloads };
  window.claude = {
    async use(name) {
      return caps[name] || null;
    },
  };

  // ── ⚙ Settings panel (markup lives in index.html) ─────────────────────────
  function setStatus(msg) {
    const el = document.getElementById('settingsStatus');
    if (el) el.textContent = msg;
  }

  window.toggleSettingsPanel = function (forceOpen) {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;
    const open = forceOpen === true || panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open) {
      document.getElementById('settingsApiKey').value = lsGet(KEY_API) || '';
      document.getElementById('settingsModel').value = lsGet(KEY_MODEL) || '';
      document.getElementById('settingsModel').placeholder = DEFAULT_MODEL;
      setStatus('');
    }
  };

  window.saveSettingsPanel = function () {
    const ok = lsSet(KEY_API, document.getElementById('settingsApiKey').value.trim()) &&
      lsSet(KEY_MODEL, document.getElementById('settingsModel').value.trim());
    setStatus(ok ? `✓ Saved — using ${currentModel()}.` : 'Could not save — this browser is blocking storage.');
  };

  window.downloadBackup = function () {
    const docs = collectDocs();
    const backup = { app: 'expense-parser', version: 1, savedAt: new Date().toISOString(), docs };
    const stamp = new Date().toISOString().slice(0, 10);
    saveFile(`expense-parser-backup-${stamp}.json`, new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    setStatus(`✓ Backed up ${Object.keys(docs).length} record${Object.keys(docs).length !== 1 ? 's' : ''}.`);
  };

  // Writes backup records into this browser. With `merge`, nothing already
  // here is replaced: clients join the existing list, and a client already
  // set up keeps its own coding, notes and settings, gaining only what it
  // doesn't have yet. Returns false if storage is blocked or full.
  function applyDocs(docs, merge) {
    const readDoc = path => { try { return JSON.parse(lsGet(DB_PREFIX + path) || 'null'); } catch (_) { return null; } };
    const mergeDoc = (path, incoming) => {
      const old = readDoc(path);
      if (!old || typeof old !== 'object') return incoming;
      if (Array.isArray(incoming.clients)) {
        const list = Array.isArray(old.clients) ? old.clients.slice() : [];
        incoming.clients.forEach(n => { if (!list.some(c => String(c).toLowerCase() === String(n).toLowerCase())) list.push(n); });
        return { ...old, clients: list };
      }
      const out = { ...incoming, ...old };
      out.rules = { ...(incoming.rules || {}), ...(old.rules || {}) };
      const oldAcc = (old.coa && old.coa.accounts) || [];
      const newAcc = ((incoming.coa && incoming.coa.accounts) || []).filter(a => !oldAcc.some(o => o.code === a.code));
      out.coa = { accounts: [...oldAcc, ...newAcc], vatDefaults: { ...((incoming.coa && incoming.coa.vatDefaults) || {}), ...((old.coa && old.coa.vatDefaults) || {}) } };
      if (!Array.isArray(old.adjustments) || !old.adjustments.length) out.adjustments = incoming.adjustments || [];
      return out;
    };
    for (const [path, obj] of Object.entries(docs)) {
      if (!lsSet(DB_PREFIX + path, JSON.stringify(merge ? mergeDoc(path, obj) : obj))) return false;
    }
    return true;
  }

  function collectDocs() {
    const docs = {};
    lsKeys().filter(k => k.startsWith(DB_PREFIX)).forEach(k => {
      try { docs[k.slice(DB_PREFIX.length)] = JSON.parse(lsGet(k)); } catch (_) { /* skip corrupt */ }
    });
    return docs;
  }

  window.restoreBackup = async function (file) {
    if (!file) return;
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch (_) {
      setStatus('That file is not a valid backup.');
      return;
    }
    if (!backup || backup.app !== 'expense-parser' || !backup.docs || typeof backup.docs !== 'object') {
      setStatus('That file is not an Expense Parser backup.');
      return;
    }
    const entries = Object.entries(backup.docs);
    // Restoring replaces records with the same name; anything not in the
    // backup is left alone. A starter pack ("merge": true) only adds (see
    // applyDocs).
    const merge = backup.merge === true;
    const question = merge
      ? `Add ${entries.length} record(s) from "${backup.title || 'this starter pack'}"? Clients you've already set up keep their own coding — only missing accounts and coding rules are added.`
      : `Restore ${entries.length} record(s) from ${backup.savedAt || 'this backup'}? Records with the same name will be replaced.`;
    if (!confirm(question)) return;
    if (!applyDocs(backup.docs, merge)) {
      setStatus('Could not restore — this browser is blocking storage or it is full.');
      return;
    }
    setStatus('✓ Restored — reloading…');
    setTimeout(() => location.reload(), 600);
  };

  // ── Password-protected shared copy of the client data ─────────────────────
  // The site is public, so client data is only ever published encrypted:
  // ⚙ Settings → "Create encrypted copy" scrambles this browser's client
  // data with a password (AES-GCM, key from PBKDF2-SHA256) into
  // client-data.enc.json, which goes in the repo's docs/ folder. On opening
  // the site, a browser that hasn't loaded that copy yet asks for the
  // password and adds the data (merging, as a starter pack does). The
  // password is never stored or sent anywhere; without it the file is
  // unreadable.
  const SHARED_FILE = 'client-data.enc.json';
  const KEY_SHARED_VERSION = 'ep:sharedVersion';
  const PBKDF2_ITERATIONS = 600000;
  const b64 = bytes => {
    const u = new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

  async function passwordKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptDocs(docs, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await passwordKey(password, salt, PBKDF2_ITERATIONS);
    const plain = JSON.stringify({ app: 'expense-parser', version: 1, merge: true, title: 'shared client data', savedAt: new Date().toISOString(), docs });
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return { app: 'expense-parser-encrypted', version: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data), createdAt: new Date().toISOString() };
  }

  // Returns the backup object, or throws 'wrong_password'.
  async function decryptShared(file, password) {
    const key = await passwordKey(password, unb64(file.salt), file.iterations || PBKDF2_ITERATIONS);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, key, unb64(file.data));
    } catch (_) {
      throw codedError('wrong_password', 'Wrong password.');
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  window.createEncryptedCopy = async function () {
    const p1 = document.getElementById('sharedPw1').value;
    const p2 = document.getElementById('sharedPw2').value;
    if (p1.length < 12) { setStatus('Use a password of at least 12 characters — ideally four or five random words.'); return; }
    if (p1 !== p2) { setStatus("The two passwords don't match."); return; }
    const docs = collectDocs();
    if (!Object.keys(docs).length) { setStatus('There is no client data in this browser to encrypt yet.'); return; }
    setStatus('Encrypting…');
    const file = await encryptDocs(docs, p1);
    saveFile(SHARED_FILE, new Blob([JSON.stringify(file)], { type: 'application/json' }));
    lsSet(KEY_SHARED_VERSION, file.salt); // this browser already has this data
    document.getElementById('sharedPw1').value = '';
    document.getElementById('sharedPw2').value = '';
    setStatus(`✓ Saved ${SHARED_FILE} (${Object.keys(docs).length} records). Upload it to the docs folder on GitHub to publish it.`);
  };

  function hideUnlockBanner() {
    const el = document.getElementById('unlockBanner');
    if (el) el.style.display = 'none';
  }

  async function checkSharedCopy() {
    let file;
    try {
      const res = await fetch(SHARED_FILE, { cache: 'no-store' });
      if (!res.ok) return;
      file = await res.json();
    } catch (_) { return; }
    if (!file || file.app !== 'expense-parser-encrypted' || !file.salt || !file.data) return;
    if (lsGet(KEY_SHARED_VERSION) === file.salt) return;
    try { if (sessionStorage.getItem('ep:unlockLater') === file.salt) return; } catch (_) { /* ignore */ }
    const banner = document.getElementById('unlockBanner');
    if (!banner) return;
    banner.style.display = 'block';
    const input = document.getElementById('unlockPassword');
    const status = document.getElementById('unlockStatus');
    const unlock = async () => {
      status.textContent = 'Unlocking…';
      try {
        const backup = await decryptShared(file, input.value);
        if (!backup || !backup.docs || !applyDocs(backup.docs, true)) throw codedError('db_error', 'Could not save — this browser is blocking storage or it is full.');
        lsSet(KEY_SHARED_VERSION, file.salt);
        status.textContent = '✓ Client data loaded — reloading…';
        setTimeout(() => location.reload(), 500);
      } catch (e) {
        status.textContent = e.code === 'wrong_password' ? 'Wrong password — try again.' : (e.message || 'Could not unlock.');
        input.select();
      }
    };
    document.getElementById('unlockBtn').onclick = unlock;
    input.onkeydown = e => { if (e.key === 'Enter') unlock(); };
    document.getElementById('unlockLaterBtn').onclick = () => {
      try { sessionStorage.setItem('ep:unlockLater', file.salt); } catch (_) { /* ignore */ }
      hideUnlockBanner();
    };
    input.focus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkSharedCopy);
  else checkSharedCopy();
})();
