#!/usr/bin/env node
// MCP server for a PookieWookie board.
//
// Lets Claude Desktop, Claude Code, Cursor, or any MCP client work the board
// as native tools: list and read tasks, create them, change fields, append
// notes, read the calendar. It talks to the board's gateway over HTTP, so it
// needs no GitHub token and every write goes through the same checks the
// board applies to everyone else.
//
//   BOARD_URL       where the board runs           (required)
//   BOARD_PASSWORD  if the board has one           (optional)
//   AGENT_ID        act as this agent, e.g. 007    (optional — see below)
//
// With AGENT_ID set, writes carry X-Agent-Id and the board refuses what an
// agent must not do: touching tasks assigned to someone else, renaming,
// deleting, the admin column. Set it for anything autonomous. Leave it unset
// when a person is driving the assistant and wants full access.
//
// The server never asks the model to write a task file. It parses the file
// into fields and body, changes only what was asked, and emits exactly one
// frontmatter block — the mistake that cost a task its title once cannot
// happen through here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BOARD = (process.env.BOARD_URL || '').replace(/\/$/, '');
const PASSWORD = process.env.BOARD_PASSWORD || '';
const AGENT = (process.env.AGENT_ID || '').trim();

if (!BOARD) {
  console.error('BOARD_URL is not set. Example: BOARD_URL=https://your-board.replit.app');
  process.exit(1);
}

const STATUSES = ['backlog', 'weekly', 'focus', 'review', 'done', 'admin'];
const LEGACY = { todo: 'backlog', doing: 'weekly', blocked: 'focus' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------- task files */

function parse(file, text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  const fields = [];
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at > 0) fields.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  const body = m ? m[2].trim() : text.trim();
  const get = (k) => fields.find(([key]) => key.toLowerCase() === k)?.[1] ?? '';
  const raw = get('status').toLowerCase();
  return {
    file,
    fields,
    body,
    get,
    id: get('id') || file.replace(/\.md$/, ''),
    title: get('title') || file.replace(/\.md$/, ''),
    status: LEGACY[raw] || (STATUSES.includes(raw) ? raw : 'backlog'),
    assignee: get('assignee'),
    due: DATE.test(get('due')) ? get('due') : '',
    start: DATE.test(get('start')) ? get('start') : '',
    labels: get('labels').split(',').map((s) => s.trim()).filter(Boolean),
    prio: /^(true|yes|high|1)$/i.test(get('prio')),
    archived: /^(true|yes)$/i.test(get('archived')),
    order: get('order') === '' ? null : Number(get('order')),
    parent: get('parent'),
    links: get('links').split(',').map((s) => s.trim()).filter(Boolean),
    events: parseEvents(get('events')),
    // A second --- block in the body means someone prepended a header; the
    // fields above are stale and a human should look at the file.
    malformed: /^---\r?\n[\s\S]*?\r?\n---/.test(body),
  };
}

function parseEvents(raw) {
  return String(raw || '')
    .split(',')
    .map((p) => /^\s*(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*(\d{4}-\d{2}-\d{2}))?\s*(.*)$/.exec(p))
    .filter(Boolean)
    .map((m) => ({ from: m[1], to: m[2] && m[2] >= m[1] ? m[2] : m[1], label: m[3].trim() }));
}
const eventsField = (list) =>
  list.map((e) => `${e.from}${e.to !== e.from ? `..${e.to}` : ''}${e.label ? ' ' + e.label : ''}`).join(', ');

function serialise(fields, body) {
  const text = ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---', '', body, ''].join('\n');
  if ((text.match(/^---$/gm) || []).length !== 2) throw new Error('refusing to write: not exactly one frontmatter block');
  return text;
}

function setField(fields, key, value) {
  const i = fields.findIndex(([k]) => k.toLowerCase() === key);
  if (value === '' || value == null) {
    // Keep the core fields present but empty; drop optional ones entirely.
    if (['title', 'status', 'assignee', 'due', 'labels', 'id'].includes(key)) {
      if (i >= 0) fields[i][1] = '';
      else fields.push([key, '']);
    } else if (i >= 0) fields.splice(i, 1);
    return;
  }
  if (i >= 0) fields[i][1] = String(value);
  else fields.push([key, String(value)]);
}

// What the board shows for a task, without the body — compact for a model.
function summary(t) {
  const out = { id: t.id, title: t.title, status: t.status };
  if (t.assignee) out.assignee = t.assignee;
  if (t.due) out.due = t.due;
  if (t.start) out.start = t.start;
  if (t.labels.length) out.labels = t.labels;
  if (t.prio) out.prio = true;
  if (t.archived) out.archived = true;
  if (t.parent) out.parent = t.parent;
  if (t.links.length) out.links = t.links;
  if (t.events.length) out.events = t.events;
  if (t.malformed) out.malformed = true;
  return out;
}

/* ----------------------------------------------------------------- board */

const headers = (extra = {}) => ({
  'Content-Type': 'application/json',
  ...(PASSWORD ? { 'X-Board-Password': PASSWORD } : {}),
  ...(AGENT ? { 'X-Agent-Id': AGENT } : {}),
  ...extra,
});

class BoardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(BOARD + path, { ...init, headers: headers(init.headers) });
  } catch (err) {
    throw new BoardError(0, `Could not reach the board at ${BOARD}: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error || `board returned ${res.status}`;
    if (res.status === 401) throw new BoardError(401, `${msg} Set BOARD_PASSWORD to this board's password.`);
    throw new BoardError(res.status, msg);
  }
  return body;
}

async function readAll() {
  const { tasks } = await api('/api/tasks');
  return tasks.map((t) => ({ ...parse(t.file, t.text), sha: t.sha }));
}

async function readOne(id) {
  const all = await readAll();
  const want = id.trim().toUpperCase();
  const t = all.find((x) => x.id.toUpperCase() === want || x.file.toUpperCase() === `${want}.md`);
  if (!t) throw new BoardError(404, `No task ${id} on this board.`);
  return { task: t, all };
}

async function writeTask(file, text, message, sha) {
  return api(`/api/tasks/${file}`, { method: 'PUT', body: JSON.stringify({ text, message, sha }) });
}

// Read, change, write — and on a 409 (someone wrote first) read again and
// reapply the same change to the newer file, once.
async function edit(id, mutate, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { task } = await readOne(id);
    if (task.malformed) throw new BoardError(422, `${task.id} has two frontmatter blocks; a human should repair the file before anything writes to it.`);
    const fields = task.fields.map(([k, v]) => [k, v]);
    const next = mutate({ task, fields, body: task.body });
    const text = serialise(fields, next.body ?? task.body);
    try {
      await writeTask(task.file, text, message(task), task.sha);
      return parse(task.file, text);
    } catch (err) {
      if (err.status !== 409 || attempt === 1) throw err;
    }
  }
}

/* ----------------------------------------------------------------- tools */

const server = new McpServer({ name: 'pookiewookie-board', version: '0.1.0' });

const ok = (data, text) => ({
  content: [{ type: 'text', text: text ?? JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: err.status === 403 ? `Refused by the board: ${err.message} (This is a rule, not a transient error — do not retry.)` : err.message }],
});
const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

const Status = z.enum(STATUSES);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const Id = z.string().describe('Task id, e.g. LC-028');

server.registerTool(
  'board_info',
  {
    title: 'Board info',
    description: 'How this board is set up: the columns and their meaning, the people and agents seen on it, and how this connection is acting.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  guard(async () => {
    const [cfg, tasks] = await Promise.all([api('/api/config'), readAll()]);
    const people = {};
    for (const t of tasks) if (t.assignee) people[t.assignee] = (people[t.assignee] || 0) + 1;
    return ok({
      board: BOARD,
      repo: cfg.repo,
      canWrite: Boolean(cfg.canWrite),
      actingAs: AGENT ? `agent ${AGENT} (board rules enforced)` : 'a person (full access)',
      columns: [
        { id: 'backlog', meaning: 'not started' },
        { id: 'weekly', meaning: 'planned for this week; an agent sets this when it claims a task' },
        { id: 'focus', meaning: 'being worked on; also where an agent parks a task with a question' },
        { id: 'review', meaning: 'finished, waiting for a human to confirm — agents finish here, never in done' },
        { id: 'done', meaning: 'confirmed by a human' },
        { id: 'admin', meaning: 'human-only; agents never touch it' },
      ],
      assigneesSeen: people,
      taskCount: tasks.length,
    });
  })
);

server.registerTool(
  'list_tasks',
  {
    title: 'List tasks',
    description: 'Tasks on the board, compact (no bodies). Filter by assignee, status, priority. Archived tasks are hidden unless asked for. Use get_task for the brief and notes of one task.',
    inputSchema: {
      assignee: z.string().optional().describe('Only tasks assigned to this id, e.g. 007, toni'),
      status: Status.optional(),
      prio: z.boolean().optional().describe('true = only priority tasks'),
      include_archived: z.boolean().optional(),
      query: z.string().optional().describe('Case-insensitive text match on id, title and body'),
    },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ assignee, status, prio, include_archived, query }) => {
    let tasks = await readAll();
    if (!include_archived) tasks = tasks.filter((t) => !t.archived);
    if (assignee) tasks = tasks.filter((t) => t.assignee.toLowerCase() === assignee.toLowerCase());
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (prio != null) tasks = tasks.filter((t) => t.prio === prio);
    if (query) {
      const q = query.toLowerCase();
      tasks = tasks.filter((t) => `${t.id} ${t.title} ${t.body}`.toLowerCase().includes(q));
    }
    tasks.sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || (a.order ?? 1e9) - (b.order ?? 1e9) || a.title.localeCompare(b.title));
    return ok({ count: tasks.length, tasks: tasks.map(summary) });
  })
);

server.registerTool(
  'get_task',
  {
    title: 'Get task',
    description: 'One task in full: every field plus the body — the brief and the notes under it.',
    inputSchema: { id: Id },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ id }) => {
    const { task, all } = await readOne(id);
    const subtasks = all.filter((t) => t.parent === task.id).map(summary);
    return ok({ ...summary(task), body: task.body, ...(subtasks.length ? { subtasks } : {}) });
  })
);

server.registerTool(
  'create_task',
  {
    title: 'Create task',
    description: 'Create a task. The id is assigned (next LC-number). Status defaults to backlog. With AGENT_ID set, a new task must be assigned to that agent or left unassigned.',
    inputSchema: {
      title: z.string().min(1),
      body: z.string().optional().describe('The brief: context, links, definition of done. Markdown.'),
      status: Status.optional(),
      assignee: z.string().optional(),
      due: Day.optional(),
      start: Day.optional().describe('With due, the task spans these days on the calendar'),
      labels: z.array(z.string()).optional(),
      prio: z.boolean().optional(),
      parent: z.string().optional().describe('Id of the task this is a subtask of'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  guard(async (a) => {
    const all = await readAll();
    const n = all.reduce((m, t) => Math.max(m, Number((/LC-(\d+)/.exec(t.file) || [])[1] || 0)), 0) + 1;
    const id = `LC-${String(n).padStart(3, '0')}`;
    const fields = [
      ['id', id],
      ['title', a.title.trim()],
      ['status', a.status || 'backlog'],
      ['assignee', a.assignee || ''],
      ...(a.start ? [['start', a.start]] : []),
      ['due', a.due || ''],
      ['labels', (a.labels || []).join(', ')],
      ...(a.prio ? [['prio', 'true']] : []),
      ...(a.parent ? [['parent', a.parent]] : []),
    ];
    const text = serialise(fields, (a.body || '').trim());
    await writeTask(`${id}.md`, text, `task: add ${id}`, undefined);
    return ok(summary(parse(`${id}.md`, text)), `Created ${id}: ${a.title.trim()}`);
  })
);

server.registerTool(
  'update_task',
  {
    title: 'Update task',
    description: 'Change fields on a task. Only the fields given are touched; everything else in the file is carried through. Pass an empty string to clear due, start, assignee or parent. To add a note, use add_note. With AGENT_ID set, the title cannot be changed and only tasks assigned to that agent can be edited.',
    inputSchema: {
      id: Id,
      title: z.string().optional(),
      status: Status.optional(),
      assignee: z.string().optional(),
      due: z.union([Day, z.literal('')]).optional(),
      start: z.union([Day, z.literal('')]).optional(),
      labels: z.array(z.string()).optional().describe('Replaces the label list'),
      prio: z.boolean().optional(),
      archived: z.boolean().optional().describe('true hides a finished task from the board; the file stays'),
      parent: z.string().optional(),
      links: z.array(z.string()).optional().describe('Related task ids; replaces the list'),
      add_events: z
        .array(z.object({ from: Day, to: Day.optional(), label: z.string().optional() }))
        .optional()
        .describe('Dates to add to the calendar for this task. Existing ones are kept; duplicates are skipped.'),
      body: z.string().optional().describe('Replaces the whole body (brief + notes). Prefer add_note.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  guard(async (a) => {
    const changed = [];
    const t = await edit(
      a.id,
      ({ task, fields }) => {
        if (a.title != null && a.title.trim() && a.title.trim() !== task.title) { setField(fields, 'title', a.title.trim()); changed.push('title'); }
        if (a.status && a.status !== task.status) { setField(fields, 'status', a.status); changed.push(`status → ${a.status}`); }
        if (a.assignee != null) { setField(fields, 'assignee', a.assignee.trim()); changed.push('assignee'); }
        if (a.due != null) { setField(fields, 'due', a.due); changed.push('due'); }
        if (a.start != null) { setField(fields, 'start', a.start); changed.push('start'); }
        if (a.labels) { setField(fields, 'labels', a.labels.map((s) => s.trim()).filter(Boolean).join(', ')); changed.push('labels'); }
        if (a.prio != null) { setField(fields, 'prio', a.prio ? 'true' : ''); changed.push(a.prio ? 'prio on' : 'prio off'); }
        if (a.archived != null) { setField(fields, 'archived', a.archived ? 'true' : ''); changed.push(a.archived ? 'archived' : 'restored'); }
        if (a.parent != null) { setField(fields, 'parent', a.parent.trim()); changed.push('parent'); }
        if (a.links) { setField(fields, 'links', a.links.map((s) => s.trim()).filter(Boolean).join(', ')); changed.push('links'); }
        if (a.add_events?.length) {
          const have = new Set(task.events.map((e) => `${e.from}..${e.to}`));
          const added = [];
          for (const e of a.add_events) {
            const to = e.to && e.to >= e.from ? e.to : e.from;
            if (have.has(`${e.from}..${to}`)) continue;
            have.add(`${e.from}..${to}`);
            added.push({ from: e.from, to, label: (e.label || '').replace(/,/g, ' ').trim() });
          }
          if (added.length) { setField(fields, 'events', eventsField([...task.events, ...added])); changed.push(`${added.length} date(s) → calendar`); }
        }
        return { body: a.body != null ? a.body.trim() : undefined };
      },
      (task) => `task: ${task.id}${a.status && a.status !== task.status ? ` → ${a.status}` : ' update'}`
    );
    if (a.body != null) changed.push('body');
    return ok(summary(t), changed.length ? `${t.id}: ${changed.join(' · ')}` : `${t.id}: nothing to change`);
  })
);

server.registerTool(
  'move_task',
  {
    title: 'Move task',
    description: 'Move a task to a column. Agents hand work back with review, not done.',
    inputSchema: { id: Id, status: Status },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  guard(async ({ id, status }) => {
    const t = await edit(id, ({ fields }) => { setField(fields, 'status', status); return {}; }, (task) => `task: ${task.id} → ${status}`);
    return ok(summary(t), `${t.id} → ${status}`);
  })
);

server.registerTool(
  'add_note',
  {
    title: 'Add note',
    description: 'Append a dated note under the task\'s "## Notes" heading. This is how work is reported: what was found, with links. The brief above it is never changed.',
    inputSchema: {
      id: Id,
      text: z.string().min(1).describe('Markdown. Concrete findings, not a restatement of the brief.'),
      author: z.string().optional().describe('Shown on the note. Defaults to AGENT_ID, else "assistant".'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  guard(async ({ id, text, author }) => {
    const who = author || AGENT || 'assistant';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const t = await edit(
      id,
      ({ body }) => {
        const note = `\n\n### ${stamp} — ${who}\n${text.trim()}`;
        return { body: /^## Notes/m.test(body) ? body + note : `${body}\n\n## Notes${note}`.trim() };
      },
      (task) => `task: note on ${task.id}`
    );
    return ok(summary(t), `Note added to ${t.id}`);
  })
);

server.registerTool(
  'list_calendar',
  {
    title: 'Calendar',
    description: 'Every dated entry on the board: due dates, start–due spans, and events listed on tasks. The calendar is derived from the tasks; to add to it, set due/start or add_events on a task.',
    inputSchema: {
      from: Day.optional().describe('Inclusive. Defaults to today.'),
      to: Day.optional().describe('Inclusive. Defaults to 60 days after from.'),
      include_done: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ from, to, include_done }) => {
    const today = new Date().toISOString().slice(0, 10);
    const lo = from || today;
    const hi = to || new Date(Date.parse(lo) + 60 * 86400000).toISOString().slice(0, 10);
    const entries = [];
    for (const t of await readAll()) {
      if (t.archived) continue;
      if (!include_done && t.status === 'done') continue;
      const own = t.due ? [{ from: t.start && t.start <= t.due ? t.start : t.due, to: t.due, label: t.title, kind: t.start ? 'span' : 'due' }] : [];
      for (const e of [...own, ...t.events.map((e) => ({ ...e, label: e.label || t.title, kind: 'event' }))]) {
        if (e.to < lo || e.from > hi) continue;
        entries.push({ from: e.from, to: e.to, label: e.label, kind: e.kind, task: t.id, assignee: t.assignee || undefined });
      }
    }
    entries.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    return ok({ from: lo, to: hi, count: entries.length, entries });
  })
);

/* ------------------------------------------------------------------ run */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`pookiewookie-board MCP: ${BOARD} as ${AGENT ? `agent ${AGENT}` : 'a person'}`);
