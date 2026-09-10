/*
 * The write side of the GitHub Pages board.
 *
 * There is no server, so the page commits to the repo itself through GitHub's
 * contents API. That needs a token, which the user pastes once and which lives
 * only in this browser's localStorage — it is never sent anywhere but github.com.
 *
 * Without a token everything still loads; the board is simply read-only.
 */

/*
 * Two ways to reach GitHub:
 *
 *   gateway  — served by gateway.js, which holds the token server-side. The
 *              browser needs no token at all; it calls same-origin /api routes.
 *   direct   — the GitHub Pages build, where the page must carry a token
 *              because a static site cannot keep a secret.
 *
 * The mode is detected once at startup by asking for /api/config.
 */
const gateway = { active: false, canWrite: false, needsPassword: false };

async function detectGateway() {
  try {
    const res = await fetch('./api/config', { headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const cfg = await res.json();
    if (cfg.mode !== 'gateway') return false;
    gateway.active = true;
    gateway.canWrite = Boolean(cfg.canWrite);
    gateway.needsPassword = Boolean(cfg.needsPassword);
    return true;
  } catch {
    return false; // static hosting: no gateway, use the token path
  }
}

// Every call to the gateway carries the board password when one is stored.
const passwordHeader = () => (boardPassword.value ? { 'X-Board-Password': boardPassword.value } : {});

const PASSWORD_KEY = 'board.gateway.password';
const boardPassword = {
  get value() {
    return localStorage.getItem(PASSWORD_KEY) || '';
  },
  set value(v) {
    if (v) localStorage.setItem(PASSWORD_KEY, v);
    else localStorage.removeItem(PASSWORD_KEY);
  },
};

// Set when GitHub refuses the stored token, so the UI can say so while the
// board keeps working read-only.
let tokenRejected = false;

const TOKEN_KEY = 'board.gh.token';
const SAVED_KEY = 'board.gh.savedAt';

const gh = {
  get token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  },
  set token(v) {
    if (v) {
      localStorage.setItem(TOKEN_KEY, v);
      localStorage.setItem(SAVED_KEY, new Date().toISOString());
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(SAVED_KEY);
    }
  },
  get connected() {
    return Boolean(this.token);
  },
  get savedAt() {
    return localStorage.getItem(SAVED_KEY) || '';
  },
  // Never render the whole secret — enough to recognise which token this is.
  get masked() {
    const t = this.token;
    if (!t) return '';
    return t.length <= 12 ? '••••' : `${t.slice(0, 11)}…${t.slice(-4)}`;
  },
};

function ghHeaders(extra = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...extra };
  if (gh.token) headers.Authorization = `Bearer ${gh.token}`;
  return headers;
}

async function ghFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: ghHeaders(options.headers) });
  if (res.ok) return res.status === 204 ? null : res.json();

  // A stale token must not hide a public repo: reads fall back to anonymous so
  // the board still shows its tasks, and the UI reports the token separately.
  const isRead = !options.method || options.method === 'GET';
  if (res.status === 401 && isRead && gh.token) {
    const anon = await fetch(url, { ...options, headers: { Accept: 'application/vnd.github+json' } });
    if (anon.ok) {
      tokenRejected = true;
      return anon.status === 204 ? null : anon.json();
    }
  }

  const detail = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Token rejected — reconnect with a valid token.');
  if (res.status === 403)
    throw new Error(
      gh.connected
        ? "Token lacks permission — it needs Contents: Read and write on this repo."
        : "GitHub's anonymous rate limit is reached. Connect a token, or wait a few minutes."
    );
  if (res.status === 409) throw new Error('That file changed on GitHub — hit Refresh and try again.');
  throw new Error(detail.message || `GitHub returned ${res.status}`);
}

/* Base64 for UTF-8 content — btoa alone mangles anything non-ASCII. */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const contentsUrl = (repo, path) =>
  `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;

// Through the gateway the browser sends plain text and no credential; the
// server does the base64 and adds the token.
async function gatewayWrite(method, file, payload) {
  const res = await fetch(`./api/tasks/${encodeURIComponent(file)}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(boardPassword.value ? { 'X-Board-Password': boardPassword.value } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
  return { content: { sha: body.sha } };
}

const fileNameOf = (fullPath) => fullPath.split('/').pop();

// Create or update a file. `sha` must be the current blob sha when replacing.
async function putFile(repo, path, text, message, sha) {
  if (gateway.active) return gatewayWrite('PUT', fileNameOf(path), { text, message, sha });
  return ghFetch(contentsUrl(repo, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64(text),
      branch: repo.branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

async function deleteFile(repo, path, message, sha) {
  if (gateway.active) return gatewayWrite('DELETE', fileNameOf(path), { message, sha });
  return ghFetch(contentsUrl(repo, path), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, branch: repo.branch, sha }),
  });
}

// Attachments: same repo, one folder per task id. Through the gateway the
// server holds the token; on Pages the page uploads directly.
const MAX_ATTACHMENT_BYTES = 5_000_000;

async function uploadAttachment(repo, taskId, name, base64) {
  if (gateway.active) {
    const res = await fetch(`./api/files/${encodeURIComponent(taskId)}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(boardPassword.value ? { 'X-Board-Password': boardPassword.value } : {}),
      },
      body: JSON.stringify({ content: base64, message: `attach ${name} to ${taskId}` }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`);
    return body.url;
  }

  const path = `attachments/${taskId}/${name}`;
  await ghFetch(contentsUrl(repo, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `attach ${name} to ${taskId}`, content: base64, branch: repo.branch }),
  });
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.branch}/${path}`;
}

async function deleteAttachment(repo, taskId, name) {
  if (gateway.active) {
    const res = await fetch(`./api/files/${encodeURIComponent(taskId)}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(boardPassword.value ? { 'X-Board-Password': boardPassword.value } : {}),
      },
      body: JSON.stringify({ message: `remove ${name} from ${taskId}` }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Delete failed (${res.status})`);
    return;
  }

  // Direct mode has to fetch the blob sha before it can remove the file.
  const path = `attachments/${taskId}/${name}`;
  const meta = await ghFetch(`${contentsUrl(repo, path)}?ref=${repo.branch}`).catch((err) => {
    if (/not found|404/i.test(err.message)) return null;
    throw err;
  });
  if (!meta) return; // already gone
  await ghFetch(contentsUrl(repo, path), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `remove ${name} from ${taskId}`, sha: meta.sha, branch: repo.branch }),
  });
}

// Confirms the token works AND can write, before we let the UI pretend it can.
async function checkAccess(repo) {
  const info = await ghFetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`);
  if (!info.permissions?.push) throw new Error('That token can read but not write to this repo.');
  return info;
}
