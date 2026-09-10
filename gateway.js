/*
 * Gateway — serves the board and talks to GitHub on its behalf.
 *
 * The GitHub Pages build has to ask each browser for a token, because a static
 * page cannot keep a secret. Running the same board from here removes that: the
 * token lives in this process (GITHUB_TOKEN in Replit Secrets), and the browser
 * just calls this server. Data still lives as .md files in the repo, so history
 * and git-based agents are unchanged.
 *
 * Endpoints (all same-origin, no token in the browser):
 *   GET    /api/config            what the frontend needs to know
 *   GET    /api/tasks             every task file with its text and sha
 *   PUT    /api/tasks/:file       {text, sha?, message} -> commit
 *   DELETE /api/tasks/:file       {sha, message}        -> commit
 *
 * Set BOARD_PASSWORD to require a password before anything can be changed.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  /* no .env — fine, Replit provides the environment directly */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'docs');
const PORT = process.env.PORT || 3000;

const REPO = {
  owner: process.env.REPO_OWNER || 'toniilein',
  name: process.env.REPO_NAME || 'workforce',
  branch: process.env.REPO_BRANCH || 'main',
  dir: process.env.TASKS_DIR || 'tasks',
};

const TOKEN = process.env.GITHUB_TOKEN || '';
// GitHub's contents API is fine with a few MB; beyond that it gets unreliable,
// and a task board does not need to carry large media.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5_000_000);
const PASSWORD = process.env.BOARD_PASSWORD || '';

// Where tasks come from. With no token there is nothing useful GitHub will let
// us write and its anonymous read limit is 60/hour, so a checkout with a tasks/
// folder is served straight from disk instead: full editing, no token, no
// limit. Commit and push when you are happy with what you see.
const LOCAL_DIR = path.join(__dirname, REPO.dir);
const LOCAL_MODE =
  process.env.BOARD_SOURCE === 'local' ||
  (process.env.BOARD_SOURCE !== 'github' && !TOKEN && fs.existsSync(LOCAL_DIR));

/* ------------------------------------------------------------------ github */

const API = 'https://api.github.com';
const rawUrl = (path) =>
  `https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/${REPO.branch}/${path}`;

const contentsUrl = (file) =>
  `${API}/repos/${REPO.owner}/${REPO.name}/contents/${REPO.dir}${file ? `/${encodeURIComponent(file)}` : ''}`;

async function github(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workforce-board',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(body?.message || `GitHub returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const isTaskFile = (name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md';

// A content hash stands in for GitHub's blob sha so the change-detection and
// conflict logic works identically in both modes.
const localSha = (text) => crypto.createHash('sha1').update(text).digest('hex');

function listTasksLocal() {
  return fs
    .readdirSync(LOCAL_DIR)
    .filter(isTaskFile)
    .map((name) => {
      const text = fs.readFileSync(path.join(LOCAL_DIR, name), 'utf8');
      return { file: name, sha: localSha(text), text };
    });
}

async function listTasks() {
  if (LOCAL_MODE) return listTasksLocal();
  const entries = await github(`${contentsUrl()}?ref=${REPO.branch}`);
  const files = entries.filter(
    (f) => f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md'
  );

  // Read the bodies from the raw CDN rather than the API. Asking the API for
  // each file costs one of only 60 anonymous calls an hour, so a board with a
  // dozen tasks used to exhaust the quota in a couple of reloads.
  return Promise.all(
    files.map(async (f) => {
      const res = await fetch(`${f.download_url}?t=${Date.now()}`, {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      });
      if (!res.ok) throw new Error(`could not read ${f.name} (${res.status})`);
      return { file: f.name, sha: f.sha, text: await res.text() };
    })
  );
}

const writeTask = (file, text, message, sha) =>
  LOCAL_MODE
    ? (fs.writeFileSync(path.join(LOCAL_DIR, file), text), { content: { sha: localSha(text) } })
    : github(contentsUrl(file), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: REPO.branch,
      ...(sha ? { sha } : {}),
    }),
  });

const removeTask = (file, message, sha) =>
  LOCAL_MODE
    ? (fs.rmSync(path.join(LOCAL_DIR, file), { force: true }), { ok: true })
    : github(contentsUrl(file), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: REPO.branch }),
  });


/* ------------------------------------------------------- agent guard rails */

// Agents identify themselves with X-Agent-Id. The board's own UI does not send
// it, so humans are unaffected. This is a guard rail, not a security boundary:
// an agent that omits the header is treated as a human. It exists because the
// damage here is accidental — an agent rewriting a file it should not have
// touched, or dropping a title it failed to carry through — and that is exactly
// what a check at the write path catches.
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || '').trim());
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

async function readTaskText(file) {
  if (LOCAL_MODE) {
    const full = path.join(LOCAL_DIR, file);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  }
  try {
    const entry = await github(`${contentsUrl(file)}?ref=${REPO.branch}`);
    return Buffer.from(entry.content || '', 'base64').toString('utf8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// Returns an error message when an agent may not make this write, else null.
async function agentRefusal(agentId, file, method, nextText) {
  const current = await readTaskText(file);

  if (method === 'DELETE') {
    return current
      ? 'Agents do not delete tasks. Set `archived: true` instead and say why in ## Notes.'
      : null;
  }

  const next = frontmatter(nextText);

  if (!current) {
    // Creating is allowed, but it has to be the agent's own work to pick up.
    if (next.assignee && next.assignee !== agentId)
      return `A new task must be assigned to you (${agentId}) or left unassigned.`;
    if (next.status === 'admin') return 'The admin column is human-only.';
    return null;
  }

  const before = frontmatter(current);

  if ((before.assignee || '') !== agentId)
    return `${file} is assigned to ${before.assignee || 'nobody'}, not to you (${agentId}). Agents only work their own tasks.`;
  if (before.status === 'admin' || next.status === 'admin')
    return 'The admin column is human-only.';
  if ((before.title || '') !== (next.title || ''))
    return `Agents do not rename tasks. Leave title as "${before.title}" and carry it through unchanged.`;
  if ((before.id || '') !== (next.id || ''))
    return 'The id is permanent. Carry it through unchanged.';

  return null;
}

/* -------------------------------------------------------------------- http */

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, maxBytes = 2e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // keep draining; killing the socket now would surface
      bytes += c.length;  // as a connection error instead of a readable message
      if (bytes > maxBytes) {
        tooBig = true;
        return reject(Object.assign(new Error('payload too large'), { tooLarge: true }));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!bytes) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Timing-safe compare so the password can't be guessed byte by byte.
function passwordOk(given) {
  if (!PASSWORD) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ routes */

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return send(res, 400, { error: 'bad request target' });
  }
  const p = url.pathname;

  // Attachments saved locally are not inside docs/, so they get their own route.
  if (LOCAL_MODE && p.startsWith('/attachments/')) {
    const rel = decodeURIComponent(p).replace(/^\/+/, '');
    const abs = path.join(__dirname, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!abs.startsWith(path.join(__dirname, 'attachments'))) return send(res, 403, { error: 'forbidden' });
    return fs.readFile(abs, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  if (!p.startsWith('/api/')) return serveStatic(res, p);

  // Tells the frontend it is running against a gateway, so it hides all the
  // token UI and calls these routes instead of api.github.com.
  if (p === '/api/config' && req.method === 'GET') {
    return send(res, 200, {
      mode: 'gateway',
      repo: REPO,
      canWrite: Boolean(TOKEN) || LOCAL_MODE,
      local: LOCAL_MODE,
      needsPassword: Boolean(PASSWORD),
    });
  }

  // Just the file names and their shas: one GitHub call, enough to tell whether
  // anything changed without downloading every task on a timer.
  if (p === '/api/tasks/state' && req.method === 'GET') {
    try {
      if (LOCAL_MODE)
        return send(res, 200, { state: listTasksLocal().map(({ file, sha }) => ({ file, sha })) });
      const entries = await github(`${contentsUrl()}?ref=${REPO.branch}`);
      const state = entries
        .filter((f) => f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md')
        .map((f) => ({ file: f.name, sha: f.sha }));
      return send(res, 200, { state });
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  if (p === '/api/tasks' && req.method === 'GET') {
    try {
      return send(res, 200, { tasks: await listTasks() });
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  // Attachments live beside the tasks in the repo, one folder per task id.
  const upload = /^\/api\/files\/(LC-\d+)\/(.+)$/.exec(p);
  if (upload && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!TOKEN && !LOCAL_MODE)
      return send(res, 503, { error: 'This board is read-only: no GITHUB_TOKEN is configured.' });

    let body;
    try {
      body = await readBody(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1024);
    } catch (err) {
      send(res, 413, { error: `File is too large (limit ${MAX_UPLOAD_BYTES / 1e6} MB).` });
      req.destroy(); // stop the rest of the upload now the client has been told
      return;
    }
    if (!passwordOk(req.headers['x-board-password'] || body.password))
      return send(res, 401, { error: 'Wrong board password.' });

    const taskId = upload[1];
    let name;
    try {
      name = decodeURIComponent(upload[2]);
    } catch {
      return send(res, 400, { error: 'bad file name' });
    }
    // No paths, no surprises: a plain file name with a sane extension.
    if (!/^[\w][\w .-]{0,80}\.[A-Za-z0-9]{1,8}$/.test(name) || name.includes('..'))
      return send(res, 400, { error: 'invalid file name' });

    const filePath = `attachments/${taskId}/${name}`;

    // Local mode keeps attachments on disk and serves them from /attachments/…
    if (LOCAL_MODE) {
      const onDisk = path.join(__dirname, 'attachments', taskId, name);
      try {
        if (req.method === 'DELETE') {
          fs.rmSync(onDisk, { force: true });
          return send(res, 200, { ok: true, path: filePath });
        }
        const base64Local = String(body.content || '');
        if (!base64Local) return send(res, 400, { error: 'no file content' });
        if (Buffer.byteLength(base64Local, 'utf8') * 0.75 > MAX_UPLOAD_BYTES)
          return send(res, 413, { error: `File is too large (limit ${MAX_UPLOAD_BYTES / 1e6} MB).` });
        fs.mkdirSync(path.dirname(onDisk), { recursive: true });
        fs.writeFileSync(onDisk, Buffer.from(base64Local, 'base64'));
        return send(res, 200, { ok: true, path: filePath, url: `/${filePath}` });
      } catch (err) {
        return send(res, 500, { error: err.message });
      }
    }
    const fileApi = `${API}/repos/${REPO.owner}/${REPO.name}/contents/${filePath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;

    // Removing an attachment needs the blob's sha; look it up so callers don't
    // have to track it.
    if (req.method === 'DELETE') {
      try {
        const meta = await github(`${fileApi}?ref=${REPO.branch}`);
        await github(fileApi, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: body.message || `remove ${name} from ${taskId}`,
            sha: meta.sha,
            branch: REPO.branch,
          }),
        });
        return send(res, 200, { ok: true, path: filePath });
      } catch (err) {
        // Already gone is a success from the caller's point of view.
        if (err.status === 404) return send(res, 200, { ok: true, path: filePath, missing: true });
        return send(res, err.status || 502, { error: err.message });
      }
    }

    const base64 = String(body.content || '');
    if (!base64) return send(res, 400, { error: 'no file content' });
    if (Buffer.byteLength(base64, 'utf8') * 0.75 > MAX_UPLOAD_BYTES)
      return send(res, 413, { error: `File is too large (limit ${MAX_UPLOAD_BYTES / 1e6} MB).` });

    try {
      const result = await github(
        fileApi,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: body.message || `attach ${name} to ${taskId}`,
            content: base64,
            branch: REPO.branch,
            ...(body.sha ? { sha: body.sha } : {}),
          }),
        }
      );
      return send(res, 200, { ok: true, path: filePath, url: rawUrl(filePath), sha: result?.content?.sha ?? null });
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  const match = /^\/api\/tasks\/([^/]+)$/.exec(p);
  if (match && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!TOKEN && !LOCAL_MODE)
      return send(res, 503, { error: 'This board is read-only: no GITHUB_TOKEN is configured.' });

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    if (!passwordOk(req.headers['x-board-password'] || body.password))
      return send(res, 401, { error: 'Wrong board password.' });

    let file;
    try {
      file = decodeURIComponent(match[1]);
    } catch {
      return send(res, 400, { error: 'bad file name' });
    }
    // Keep writes inside tasks/: no traversal, no stray file types.
    if (!/^[\w.-]+\.md$/.test(file)) return send(res, 400, { error: 'invalid task file name' });

    const agentId = String(req.headers['x-agent-id'] || '').trim();
    if (agentId) {
      try {
        const refusal = await agentRefusal(agentId, file, req.method, String(body.text ?? ''));
        if (refusal) return send(res, 403, { error: refusal });
      } catch (err) {
        return send(res, err.status || 502, { error: err.message });
      }
    }

    try {
      const result =
        req.method === 'PUT'
          ? await writeTask(file, String(body.text ?? ''), body.message || `task: update ${file}`, body.sha)
          : await removeTask(file, body.message || `task: remove ${file}`, body.sha);
      return send(res, 200, { ok: true, sha: result?.content?.sha ?? null });
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  send(res, 404, { error: `no route for ${req.method} ${p}` });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  });
});

process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

// The UI is served from this checkout, so a Repl that hasn't pulled serves an
// old board. Print which commit is running to make that visible immediately.
function localCommit() {
  try {
    const head = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? fs.readFileSync(path.join(__dirname, '.git', ref), 'utf8').trim() : head;
    return sha.slice(0, 7);
  } catch {
    return 'unknown';
  }
}

server.listen(PORT, () => {
  console.log(`board gateway → http://localhost:${PORT}`);
  console.log(`serving commit: ${localCommit()}`);
  console.log(`repo: ${REPO.owner}/${REPO.name}@${REPO.branch}/${REPO.dir}`);
  console.log(
    LOCAL_MODE
      ? `source: local files in ${REPO.dir}/ (edits stay on disk until you commit)`
      : TOKEN
        ? 'source: GitHub, token loaded (writes enabled)'
        : 'source: GitHub, NO TOKEN — read-only'
  );
  console.log(PASSWORD ? 'access: password required for changes' : 'access: open (set BOARD_PASSWORD to lock)');
});
