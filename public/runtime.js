// Self-hosted stand-in for the Claude Artifact runtime (window.claude.use).
//
// The page was originally written against claude.ai's artifact capabilities —
// `sample` (ask Claude), `db` (shared storage) and `downloads` (save a file).
// This file provides the same shapes backed by this site's own server
// functions (functions/api/*), so index.html barely has to change:
//
//   sample.json(prompt, { images, documents })  → POST /api/ai
//   sample.limits()                             → static capabilities
//   db.doc(path).get() / .set(obj)              → GET / PUT /api/db/<path>
//   downloads.save({ filename, data })          → ordinary browser download
//
// Errors carry a `.code` matching the runtime contract the page already
// branches on (rate_limited, prompt_too_large, refused, invalid_json, …).
(function () {
  if (window.claude && typeof window.claude.use === 'function') return;

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

  async function postJson(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw codedError('network', 'Could not reach the server — check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data.error || {};
      throw codedError(err.code || 'server_error', err.message || `Server error ${res.status}`);
    }
    return data;
  }

  const sample = {
    async limits() {
      return { images: true, documents: true };
    },
    async text(prompt, opts = {}) {
      const images = await Promise.all(toList(opts.images).map(async f => ({
        media_type: imageMediaType(f), data: await fileToBase64(f),
      })));
      const documents = await Promise.all(toList(opts.documents).map(async f => ({
        media_type: 'application/pdf', data: await fileToBase64(f),
      })));
      const data = await postJson('/api/ai', { prompt, images, documents });
      return data.text;
    },
    async json(prompt, opts = {}) {
      return parseJsonLoose(await sample.text(prompt, opts));
    },
  };

  function docUrl(path) {
    return '/api/db/' + String(path).split('/').map(encodeURIComponent).join('/');
  }

  const db = {
    doc(path) {
      return {
        async get() {
          const res = await fetch(docUrl(path));
          if (res.status === 404) return { exists: false, data: () => undefined };
          if (!res.ok) throw codedError('db_error', `Could not load ${path} (${res.status})`);
          const obj = await res.json();
          return { exists: true, data: () => obj };
        },
        async set(obj) {
          const res = await fetch(docUrl(path), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(obj),
          });
          if (!res.ok) throw codedError('db_error', `Could not save ${path} (${res.status})`);
        },
      };
    },
  };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { status: 'saved' };
    },
  };

  const caps = { sample, db, downloads };
  window.claude = {
    async use(name) {
      return caps[name] || null;
    },
  };
})();
