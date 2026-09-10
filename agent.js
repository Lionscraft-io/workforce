// Pookachu Bot — works its own tasks on the board with a Hermes model.
//
//   node agent.js              one pass over the tasks assigned to it
//   node agent.js --loop       keep going, every AGENT_INTERVAL seconds
//   node agent.js --dry-run    show what it would write, write nothing
//   node agent.js --task LC-028
//
// The model never writes a task file. It answers a question about one task in
// JSON — notes, a new status, any dates it found — and this script rebuilds the
// file around that answer, carrying every other field through untouched. That
// is what stops an agent doing what a previous one did to LC-028: emitting a
// fresh frontmatter block on top of the old one and losing the title.
//
// Everything it needs comes from the environment (.env locally, Secrets on
// Replit). Nothing secret is ever written to the repo.

import fs from 'node:fs';
import crypto from 'node:crypto';

if (fs.existsSync('.env')) process.loadEnvFile();

const cfg = {
  apiKey: process.env.HERMES_API_KEY || '',
  // Nous Research's OpenAI-compatible endpoint. Confirm both of these in your
  // Hermes dashboard; either can be overridden here without touching code.
  baseUrl: (process.env.HERMES_BASE_URL || 'https://inference-api.nousresearch.com/v1').replace(/\/$/, ''),
  model: process.env.HERMES_MODEL || 'Hermes-4-70B',
  board: (process.env.BOARD_URL || 'http://localhost:3000').replace(/\/$/, ''),
  password: process.env.BOARD_PASSWORD || '',
  agentId: process.env.AGENT_ID || '007',
  interval: Number(process.env.AGENT_INTERVAL || 300),
  perPass: Number(process.env.AGENT_TASKS_PER_PASS || 3),
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const only = args[args.indexOf('--task') + 1] && args.includes('--task') ? args[args.indexOf('--task') + 1] : null;
const DRY = flag('--dry-run');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[agent]', ...a);

/* ------------------------------------------------------------ task files */

// Frontmatter as an ordered list of [key, value], so the file is written back
// with the same fields in the same order and nothing the model did not touch
// can drift.
function parseTask(file, text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  const fields = [];
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at > 0) fields.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  const get = (k) => fields.find(([key]) => key.toLowerCase() === k)?.[1] ?? '';
  return { file, fields, get, body: m ? m[2].trim() : text.trim(), malformed: /^---\r?\n[\s\S]*?\r?\n---/.test(m ? m[2].trim() : '') };
}

function serialise(fields, body) {
  return ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---', '', body, ''].join('\n');
}

function setField(fields, key, value) {
  const i = fields.findIndex(([k]) => k.toLowerCase() === key);
  if (i >= 0) fields[i][1] = value;
  else fields.push([key, value]);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseEvents(raw) {
  return String(raw || '')
    .split(',')
    .map((p) => /^\s*(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*(\d{4}-\d{2}-\d{2}))?\s*(.*)$/.exec(p))
    .filter(Boolean)
    .map((m) => ({ from: m[1], to: m[2] && m[2] >= m[1] ? m[2] : m[1], label: m[3].trim() }));
}
const eventsField = (list) =>
  list.map((e) => `${e.from}${e.to !== e.from ? `..${e.to}` : ''}${e.label ? ' ' + e.label : ''}`).join(', ');

/* ---------------------------------------------------------------- board */

const boardHeaders = (extra = {}) => ({
  'Content-Type': 'application/json',
  'X-Agent-Id': cfg.agentId,
  ...(cfg.password ? { 'X-Board-Password': cfg.password } : {}),
  ...extra,
});

async function readBoard() {
  const res = await fetch(`${cfg.board}/api/tasks`, { headers: boardHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `board returned ${res.status}`);
  return body.tasks.map((t) => ({ ...parseTask(t.file, t.text), sha: t.sha }));
}

async function writeTask(task, text, message) {
  const res = await fetch(`${cfg.board}/api/tasks/${task.file}`, {
    method: 'PUT',
    headers: boardHeaders(),
    body: JSON.stringify({ text, message, sha: task.sha }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `board returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ---------------------------------------------------------------- model */

const SYSTEM = `You are Pookachu Bot, an agent working tasks on a small team's kanban board.
You are given ONE task: its fields and its brief. Do the work the brief asks for,
using only what you know and what the brief contains — you have no tools and no
web access, so if the task needs information you do not have, say exactly what is
missing rather than guessing.

Reply with ONE JSON object and nothing else, in this shape:
{
  "notes": "what you did or found, in markdown, concrete and with any links from the brief",
  "status": "review" | "focus",
  "events": [ { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "label": "short label" } ],
  "due": "YYYY-MM-DD" | null,
  "labels_add": [ "label" ]
}

Rules:
- "status": "review" when the work is done and a human should check it.
  "focus" when you are stuck — then "notes" must contain the specific question.
- "events": every date you can resolve to a real day from the title or brief —
  a trip, a flight, a deadline, a meeting. Resolve relative dates against today.
  Use "to" for a range; for a single day set "to" equal to "from". Put a time in
  the label if it matters ("Flight out 09:40"). If unsure a date is real, leave
  it out and mention it in notes instead. Empty array if none.
- "due": only if the brief clearly states a deadline and none is set; else null.
- Never invent facts. Never restate the brief as if it were a finding.
- Keep notes under 250 words.`;

function taskPrompt(t) {
  const today = new Date().toISOString().slice(0, 10);
  const shown = t.fields.filter(([k]) => !['order'].includes(k.toLowerCase())).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `Today is ${today}.\n\nTASK ${t.get('id')}\n${shown}\n\nBRIEF:\n${t.body || '(no brief — say so in notes and ask for one)'}`;
}

async function askModel(t) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: taskPrompt(t) },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hermes returned ${res.status}: ${text.slice(0, 300)}`);
  const content = JSON.parse(text).choices?.[0]?.message?.content ?? '';
  // Models sometimes wrap JSON in prose or a code fence; take the first object.
  const json = /\{[\s\S]*\}/.exec(content)?.[0];
  if (!json) throw new Error(`model did not return JSON: ${content.slice(0, 200)}`);
  return JSON.parse(json);
}

/* ------------------------------------------------------------- one task */

// Only these can change. Title, id, assignee, order, prio, parent, links and
// anything else in the file are carried through exactly as they were.
function applyAnswer(t, a) {
  const fields = t.fields.map(([k, v]) => [k, v]);
  const changes = [];

  const status = ['review', 'focus'].includes(a.status) ? a.status : 'review';
  setField(fields, 'status', status);
  changes.push(`status → ${status}`);

  const existing = parseEvents(t.get('events'));
  const have = new Set([...existing.map((e) => `${e.from}..${e.to}`), `${t.get('start') || t.get('due')}..${t.get('due')}`]);
  const added = [];
  for (const e of Array.isArray(a.events) ? a.events : []) {
    if (!DATE.test(e?.from || '')) continue;
    const to = DATE.test(e.to || '') && e.to >= e.from ? e.to : e.from;
    if (have.has(`${e.from}..${to}`)) continue;
    have.add(`${e.from}..${to}`);
    added.push({ from: e.from, to, label: String(e.label || '').replace(/,/g, ' ').trim().slice(0, 60) });
  }
  if (added.length) {
    setField(fields, 'events', eventsField([...existing, ...added]));
    changes.push(`${added.length} date${added.length === 1 ? '' : 's'} → calendar`);
  }

  if (!t.get('due') && DATE.test(a.due || '')) {
    setField(fields, 'due', a.due);
    changes.push(`due ${a.due}`);
  }

  const labels = t.get('labels').split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set(labels.map((l) => l.toLowerCase()));
  const extra = [];
  for (const raw of Array.isArray(a.labels_add) ? a.labels_add : []) {
    const l = String(raw).trim().toLowerCase();
    if (l && !seen.has(l) && extra.length < 3) {
      seen.add(l);
      extra.push(l);
    }
  }
  if (extra.length) {
    setField(fields, 'labels', [...labels, ...extra].join(', '));
    changes.push(`labels +${extra.join(', ')}`);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  // The marker is invisible on the board and is how the next pass knows this
  // task is waiting on a human: a reply typed under the note lands after it,
  // and an edit to the brief changes the hash.
  const marker = `<!-- pookachu:done brief=${briefHash(t.body)} -->`;
  const note = `\n\n### ${stamp} — Pookachu Bot\n${String(a.notes || '(no notes returned)').trim()}\n${marker}`;
  const body = /^## Notes/m.test(t.body) ? stripMarkers(t.body) + note : `${t.body}\n\n## Notes${note}`.trim();

  return { text: serialise(fields, body), changes, status };
}

async function workTask(t) {
  const id = t.get('id') || t.file;
  log(`${id} — ${t.get('title')}`);
  if (t.malformed) return log(`  skipped: file has two frontmatter blocks; a human should fix it first`);

  const answer = await askModel(t);
  const { text, changes, status } = applyAnswer(t, answer);
  log(`  ${changes.join(' · ')}`);

  if (DRY) return console.log('\n' + text + '\n');

  try {
    await writeTask(t, text, `task: ${id} → ${status}`);
    log(`  written`);
  } catch (err) {
    if (err.status === 403) return log(`  refused by the board: ${err.message}`); // not retryable
    if (err.status === 409) {
      // Someone edited it under us. Read again and apply the answer to the new file.
      const fresh = (await readBoard()).find((x) => x.file === t.file);
      if (!fresh) return log(`  gone — someone removed it`);
      const again = applyAnswer(fresh, answer);
      await writeTask(fresh, again.text, `task: ${id} → ${again.status}`);
      return log(`  written (after re-read)`);
    }
    throw err;
  }
}

/* ----------------------------------------------------------------- pass */

// Once the agent has handed a task back it leaves it alone, and picks it up
// again only when a human has responded in one of three ways: moved it back to
// backlog or weekly, typed anything under the agent's note, or changed the
// brief. Without this a task parked in focus with a question would get a fresh
// note every pass, forever.
const MARKER = /<!-- pookachu:done brief=([0-9a-f]+) -->/g;
const briefOf = (body) => body.split(/^## Notes/m)[0].trim();
const briefHash = (body) => crypto.createHash('sha1').update(briefOf(body)).digest('hex').slice(0, 10);
const stripMarkers = (body) => body.replace(/\n?<!-- pookachu:done brief=[0-9a-f]+ -->/g, '');

function awaitingHuman(t) {
  const status = t.get('status').toLowerCase();
  if (status === 'backlog' || status === 'weekly') return false;
  const atEnd = /<!-- pookachu:done brief=([0-9a-f]+) -->\s*$/.exec(t.body);
  if (!atEnd) return false;                       // no note yet, or someone wrote under it
  return atEnd[1] === briefHash(t.body);          // brief unchanged since -> still waiting
}

function mine(tasks) {
  return tasks
    .filter((t) => t.get('assignee') === cfg.agentId)
    .filter((t) => !['done', 'review', 'admin'].includes(t.get('status').toLowerCase()))
    .filter((t) => !/^(true|yes)$/i.test(t.get('archived')))
    .filter((t) => !awaitingHuman(t))
    .filter((t) => !only || t.get('id') === only || t.file === `${only}.md`)
    .sort((a, b) => {
      const p = (t) => (/^(true|yes|high|1)$/i.test(t.get('prio')) ? 0 : 1);
      return p(a) - p(b) || (a.get('due') || '9999').localeCompare(b.get('due') || '9999');
    });
}

async function pass() {
  const tasks = await readBoard();
  const queue = mine(tasks);
  log(`${tasks.length} tasks on the board, ${queue.length} for ${cfg.agentId}${DRY ? ' (dry run)' : ''}`);
  for (const t of queue.slice(0, cfg.perPass)) {
    try {
      await workTask(t);
    } catch (err) {
      log(`  failed: ${err.message}`);
    }
  }
}

if (!cfg.apiKey) {
  console.error('HERMES_API_KEY is not set. Put it in .env locally, or in Secrets on Replit.');
  process.exit(1);
}

log(`model ${cfg.model} at ${cfg.baseUrl}`);
log(`board ${cfg.board} as ${cfg.agentId}`);

if (flag('--loop')) {
  for (;;) {
    await pass().catch((err) => log(`pass failed: ${err.message}`));
    await new Promise((r) => setTimeout(r, cfg.interval * 1000));
  }
} else {
  await pass();
}
