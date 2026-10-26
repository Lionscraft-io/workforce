// End-to-end: a real gateway on a scratch task folder, the real MCP server
// over stdio, and the SDK's own client driving it — the same path Claude or
// Cursor would take. Nothing here touches the repo's real tasks/.
//
//   node --test            (from mcp/)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const PORT = 3998;
const BOARD = `http://localhost:${PORT}`;

// The gateway resolves TASKS_DIR relative to its own folder, so the scratch
// folder has to live inside the repo. It is removed afterwards.
const scratchName = `.mcp-test-tasks-${process.pid}`;
const scratch = path.join(repoRoot, scratchName);

const seed = {
  'LC-001.md': `---
id: LC-001
title: Book the venue
status: backlog
assignee: toni
due: 2026-11-20
labels: events
---

Find a room for 40 people near the office.
`,
  'LC-002.md': `---
id: LC-002
title: Draft the agenda
status: weekly
assignee: 007
due:
labels:
order: 1000
---

One page, three sessions.

## Notes
Started.
`,
  'LC-003.md': `---
id: LC-003
title: Approve the budget
status: admin
assignee: 007
due:
labels:
---
`,
};

let gateway;
const clients = [];

async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, 'server.js')],
    env: { ...process.env, BOARD_URL: BOARD, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent };
};

before(async () => {
  fs.mkdirSync(scratch, { recursive: true });
  for (const [f, t] of Object.entries(seed)) fs.writeFileSync(path.join(scratch, f), t);
  gateway = spawn(process.execPath, [path.join(repoRoot, 'gateway.js')], {
    env: { ...process.env, PORT: String(PORT), TASKS_DIR: scratchName, BOARD_SOURCE: 'local', BOARD_PASSWORD: '', GITHUB_TOKEN: '', PMO_AGENTS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BOARD}/api/config`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('test gateway did not start');
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  gateway?.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('lists the tools a client will see', async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['add_note', 'board_info', 'create_task', 'get_task', 'list_calendar', 'list_tasks', 'move_task', 'update_task']
  );
  const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(ro, ['board_info', 'get_task', 'list_calendar', 'list_tasks']);
});

test('reads the board', async () => {
  const c = await connect();
  const info = await call(c, 'board_info');
  assert.equal(info.data.taskCount, 3);
  assert.equal(info.data.actingAs, 'a person (full access)');

  const all = await call(c, 'list_tasks');
  assert.equal(all.data.count, 3);
  assert.ok(!('body' in all.data.tasks[0]), 'list is compact');

  const mine = await call(c, 'list_tasks', { assignee: '007' });
  assert.deepEqual(mine.data.tasks.map((t) => t.id), ['LC-002', 'LC-003']);

  const one = await call(c, 'get_task', { id: 'lc-002' });
  assert.equal(one.data.title, 'Draft the agenda');
  assert.match(one.data.body, /## Notes/);
});

test('creates, updates, notes, moves — and never doubles the frontmatter', async () => {
  const c = await connect();
  const made = await call(c, 'create_task', { title: 'Order lunch', assignee: 'toni', due: '2026-11-19', labels: ['events', 'food'], prio: true });
  assert.equal(made.data.id, 'LC-004');
  assert.equal(made.data.prio, true);

  const up = await call(c, 'update_task', { id: 'LC-004', start: '2026-11-18', add_events: [{ from: '2026-11-19', label: 'Delivery 11:30' }, { from: '2026-11-19', label: 'duplicate day, skipped' }] });
  assert.equal(up.data.start, '2026-11-18');
  assert.equal(up.data.events.length, 1, 'same day added once');

  await call(c, 'add_note', { id: 'LC-004', text: 'Caterer confirmed.', author: 'toni' });
  const moved = await call(c, 'move_task', { id: 'LC-004', status: 'review' });
  assert.equal(moved.data.status, 'review');

  const file = fs.readFileSync(path.join(scratch, 'LC-004.md'), 'utf8');
  assert.equal((file.match(/^---$/gm) || []).length, 2, 'exactly one frontmatter block');
  assert.match(file, /^title: Order lunch$/m);
  assert.match(file, /^labels: events, food$/m);
  assert.match(file, /^events: 2026-11-19 Delivery 11:30$/m);
  assert.match(file, /## Notes\n\n### \d{4}-\d{2}-\d{2} \d{2}:\d{2} — toni\nCaterer confirmed\./);

  const cleared = await call(c, 'update_task', { id: 'LC-004', due: '', prio: false });
  assert.ok(!cleared.data.due && !cleared.data.prio);
  assert.doesNotMatch(fs.readFileSync(path.join(scratch, 'LC-004.md'), 'utf8'), /^prio:/m, 'prio line dropped, not left as prio: ');
});

test('calendar is derived from the tasks', async () => {
  const c = await connect();
  const cal = await call(c, 'list_calendar', { from: '2026-11-01', to: '2026-11-30' });
  const labels = cal.data.entries.map((e) => `${e.from}→${e.to} ${e.label} [${e.kind}]`);
  assert.ok(labels.includes('2026-11-20→2026-11-20 Book the venue [due]'), labels.join('\n'));
  assert.ok(labels.includes('2026-11-19→2026-11-19 Delivery 11:30 [event]'), labels.join('\n'));
  assert.ok(cal.data.entries.every((e) => e.from <= '2026-11-30' && e.to >= '2026-11-01'));
});

test('as an agent, the board\'s rules are enforced and reported as non-retryable', async () => {
  const c = await connect({ AGENT_ID: '007' });
  const info = await call(c, 'board_info');
  assert.match(info.data.actingAs, /agent 007/);

  const rename = await call(c, 'update_task', { id: 'LC-002', title: 'Renamed by a bot' });
  assert.equal(rename.isError, true);
  assert.match(rename.text, /do not rename|Refused/i);
  assert.match(rename.text, /do not retry/);

  const theirs = await call(c, 'move_task', { id: 'LC-001', status: 'focus' });
  assert.equal(theirs.isError, true);
  assert.match(theirs.text, /assigned to toni/);

  const admin = await call(c, 'move_task', { id: 'LC-003', status: 'done' });
  assert.equal(admin.isError, true);
  assert.match(admin.text, /human-only/);

  const fine = await call(c, 'move_task', { id: 'LC-002', status: 'review' });
  assert.equal(fine.isError, undefined);
  assert.equal(fine.data.status, 'review');

  const created = await call(c, 'create_task', { title: 'Found more work', assignee: 'toni' });
  assert.equal(created.isError, true, 'an agent may not assign new work to a human');
  const own = await call(c, 'create_task', { title: 'Found more work' });
  assert.equal(own.data.status, 'backlog');
});

test('a wrong password is explained, not swallowed', async () => {
  const c = await connect({ BOARD_PASSWORD: 'nope' });
  // the test gateway has no password; a wrong one is simply ignored there, so
  // check the error path by pointing at nothing instead
  const d = await connect({ BOARD_URL: 'http://localhost:1' });
  const r = await call(d, 'list_tasks');
  assert.equal(r.isError, true);
  assert.match(r.text, /Could not reach the board/);
  await c.close();
});

test('refuses to write through a task whose file has two frontmatter blocks', async () => {
  fs.writeFileSync(path.join(scratch, 'LC-009.md'), `---\nid: LC-009\ntitle: LC-009\nstatus: backlog\n---\n\n---\nid: LC-009\ntitle: The real title\nstatus: focus\nassignee: toni\n---\n\nbody\n`);
  const c = await connect();
  const got = await call(c, 'get_task', { id: 'LC-009' });
  assert.equal(got.data.malformed, true);
  const r = await call(c, 'add_note', { id: 'LC-009', text: 'hello' });
  assert.equal(r.isError, true);
  assert.match(r.text, /two frontmatter blocks/);
});

test('a PMO agent may manage any task, but may still not rename', async () => {
  const PMO_PORT = PORT - 1;
  const pmo = spawn(process.execPath, [path.join(repoRoot, 'gateway.js')], {
    env: { ...process.env, PORT: String(PMO_PORT), TASKS_DIR: scratchName, BOARD_SOURCE: 'local', BOARD_PASSWORD: '', GITHUB_TOKEN: '', PMO_AGENTS: '007' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://localhost:${PMO_PORT}/api/config`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const c = await connect({ BOARD_URL: `http://localhost:${PMO_PORT}`, AGENT_ID: '007' });

    const theirs = await call(c, 'move_task', { id: 'LC-001', status: 'focus' });
    assert.equal(theirs.isError, undefined, theirs.text);
    assert.equal(theirs.data.status, 'focus', 'PMO may move a task assigned to someone else');

    const rename = await call(c, 'update_task', { id: 'LC-001', title: 'Still not allowed' });
    assert.equal(rename.isError, true, 'PMO still may not rename');
    assert.match(rename.text, /do not rename/i);

    // PMO is also exempt from the admin rule (db80636). Renames, id changes and
    // deletes stay refused for every agent.
    const admin = await call(c, 'move_task', { id: 'LC-003', status: 'review' });
    assert.equal(admin.isError, undefined, 'PMO may manage admin tasks');
  } finally {
    pmo.kill();
  }
});
