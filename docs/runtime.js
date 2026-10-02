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

  const DEFAULT_MODEL = 'claude-opus-5';
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
      if (error instanceof Anthropic.APIError) {
        throw codedError('server_error', `Claude API error ${error.status ?? ''}: ${error.message}`);
      }
      throw codedError('network', 'Could not reach the Claude API — check your connection.');
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
    async json(prompt, opts = {}) {
      return parseJsonLoose(await askClaude(prompt, opts));
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
    const docs = {};
    lsKeys().filter(k => k.startsWith(DB_PREFIX)).forEach(k => {
      try { docs[k.slice(DB_PREFIX.length)] = JSON.parse(lsGet(k)); } catch (_) { /* skip corrupt */ }
    });
    const backup = { app: 'expense-parser', version: 1, savedAt: new Date().toISOString(), docs };
    const stamp = new Date().toISOString().slice(0, 10);
    saveFile(`expense-parser-backup-${stamp}.json`, new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    setStatus(`✓ Backed up ${Object.keys(docs).length} record${Object.keys(docs).length !== 1 ? 's' : ''}.`);
  };

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
    // backup is left alone.
    if (!confirm(`Restore ${entries.length} record(s) from ${backup.savedAt || 'this backup'}? Records with the same name will be replaced.`)) return;
    for (const [path, obj] of entries) {
      if (!lsSet(DB_PREFIX + path, JSON.stringify(obj))) {
        setStatus('Could not restore — this browser is blocking storage or it is full.');
        return;
      }
    }
    setStatus('✓ Restored — reloading…');
    setTimeout(() => location.reload(), 600);
  };
})();
