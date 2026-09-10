/*
 * Board — the GitHub Pages build.
 *
 * No server. Each task is a .md file in the repo's tasks/ folder; this page
 * lists them through GitHub's API, parses the frontmatter, and renders the
 * board. Connect a token (sidebar) and it becomes interactive: dragging a card
 * or editing it rewrites that file and commits. The repo IS the database, and
 * every change is a commit you can see in the history.
 */

const REPO = { owner: 'Lionscraft-io', name: 'workforce', branch: 'main', dir: 'tasks' };

// The workflow, left to right:
//   Backlog -> Weekly -> Focus -> Review (what a bot handed back) -> Done
// Admin sits apart on the right and is human-only; agents leave it alone.
const SECTIONS = [
  { id: 'backlog', title: 'Backlog', color: '#3d4451' },
  { id: 'weekly', title: 'Weekly', color: '#4f8ef7' },
  { id: 'focus', title: 'Focus', color: '#e2504f' },
  { id: 'review', title: 'Review', color: '#f59e0b' },
  { id: 'done', title: 'Done', color: '#4bc07a' },
  { id: 'admin', title: 'Admin', color: '#8b7fa8', humansOnly: true },
];

// Files written before the rename still say todo/doing/blocked. Map them rather
// than stranding those tasks in the first column.
const LEGACY_STATUS = { todo: 'backlog', doing: 'weekly', blocked: 'focus' };

// Known people. Anyone else named in a file still appears, in grey.
// `img` is optional: drop a square image in docs/avatars/ and name it here.
// If the file is missing the initials show instead, so nothing breaks.
const PEOPLE = {
  toni: { name: 'Toni', color: '#2f3542', img: './avatars/toni.jpeg' },
  Adi: { name: 'Adi', color: '#6b7ce0', img: './avatars/adi.jpeg' },
  '007': { name: 'Pookachu Bot', color: '#5b8aa6', img: './avatars/pookachu.png' },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// A small inline icon. The markup is fixed here — never built from task data —
// so setting innerHTML carries no user input.
const GLYPHS = {
  clip:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.2 5.8 10a1.7 1.7 0 0 0 2.4 2.4l5.1-5.1a3 3 0 0 0-4.2-4.2L3.9 8.3a4.3 4.3 0 0 0 6.1 6.1l4.3-4.3"/></svg>',
  cal:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="4.2" width="10.8" height="8.8" rx="2"/><path d="M2.6 7.2h10.8"/><path d="M5.6 3v2.4"/><path d="M10.4 3v2.4"/></svg>',
  // Priority: a small pennant on its pole, filled so it reads at card size.
  flag:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 13V3"/><path d="M4.4 3.6h6.9l-1.45 2.4 1.45 2.4H4.4" fill="currentColor" stroke-linejoin="round"/></svg>',
};

function glyph(name) {
  const span = el('span', 'micon');
  span.innerHTML = GLYPHS[name] || '';
  return span;
}

// Bind defensively. Pages caches HTML and JS separately, so a deploy can briefly
// pair new JS with old HTML; without this, one missing element throws and takes
// the whole board down instead of just disabling one button.
function on(sel, event, handler) {
  const node = $(sel);
  if (node) node.addEventListener(event, handler);
  else console.warn(`missing element ${sel} — reload if the page is mid-update`);
}

let tasks = [];
let filter = { text: '', assignee: '', label: '', prio: false };
let openFile = null;
let busy = false;
let permissionProblem = false; // connected but GitHub refused a write

// Gateway mode writes through the server (no browser token); the Pages build
// writes directly and needs one.
const canEdit = () => (gateway.active ? gateway.canWrite : gh.connected);

/* ------------------------------------------------------------------ notices */

// alert() blocks the whole page (it froze the board once), so notices are
// in-page and non-blocking.
function toast(message, kind = 'info') {
  const node = el('div', `toast ${kind}`, message);
  const host = $('#toasts');
  if (!host) return console.warn('toast:', message);
  host.appendChild(node);
  setTimeout(() => node.classList.add('leaving'), kind === 'error' ? 6000 : 2500);
  setTimeout(() => node.remove(), kind === 'error' ? 6400 : 2900);
}

/* ------------------------------------------------------------------ github */

const editUrl = (file) =>
  `https://github.com/${REPO.owner}/${REPO.name}/edit/${REPO.branch}/${REPO.dir}/${encodeURIComponent(file)}`;

async function loadTasks() {
  // Through the gateway the server has already read the files for us.
  if (gateway.active) {
    const res = await fetch('./api/tasks', { headers: passwordHeader() });
    if (res.status === 401) throw Object.assign(new Error('locked'), { locked: true });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
    return body.tasks
      .map((t) => ({ ...parseTask(t.file, t.text), sha: t.sha }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  // Pin raw reads to the branch's current commit. Raw URLs that name the branch
  // can remain stale for several minutes even after the Contents API reports a
  // new blob, making a moved card appear to jump back to its previous column.
  const branch = await ghFetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}/branches/${REPO.branch}`
  );
  const commit = branch.commit.sha;
  const tree = await ghFetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}/git/trees/${commit}?recursive=1`
  );
  const prefix = `${REPO.dir}/`;
  const files = tree.tree.filter(
    (f) =>
      f.type === 'blob' &&
      f.path.startsWith(prefix) &&
      !f.path.slice(prefix.length).includes('/') &&
      f.path.endsWith('.md') &&
      f.path.toLowerCase() !== `${prefix}readme.md`
  );
  const loaded = await Promise.all(
    files.map(async (f) => {
      const path = f.path.split('/').map(encodeURIComponent).join('/');
      const rawUrl = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/${commit}/${path}`;
      const text = await fetch(rawUrl).then((r) => (r.ok ? r.text() : ''));
      return { ...parseTask(f.path.slice(prefix.length), text), sha: f.sha };
    })
  );
  return loaded.sort((a, b) => a.title.localeCompare(b.title));
}

/* ------------------------------------------------------------ live updates */

// A change made anywhere — GitHub's editor, an agent's commit, another device —
// should appear here without anyone pressing Refresh. Rather than re-downloading
// every task on a timer, ask only for the file names and their shas (one
// request) and reload in full when that fingerprint moves.
// Files we have just written, and the sha the write returned. GitHub's API is
// eventually consistent: a read moments after a commit can still hand back the
// version before it. Applying that would drop the card straight back where it
// came from — which looks exactly like the move was never saved.
const justWrote = new Map(); // file -> { sha, at }
const WRITE_SETTLE_MS = 45_000;

function noteWrite(file, sha) {
  if (sha) justWrote.set(file, { sha, at: Date.now() });
}

// True while a read still shows a version older than something we just wrote.
function readIsStale(state) {
  const now = Date.now();
  for (const [file, rec] of [...justWrote]) {
    if (now - rec.at > WRITE_SETTLE_MS) {
      justWrote.delete(file); // gave up waiting; trust the server from here
      continue;
    }
    const seen = state.find((s) => s.file === file);
    if (!seen || seen.sha !== rec.sha) return true;
    justWrote.delete(file); // the server has caught up with this one
  }
  return false;
}

async function fetchState() {
  if (gateway.active) {
    const res = await fetch('./api/tasks/state', { headers: passwordHeader() });
    if (res.status === 401) throw Object.assign(new Error('locked'), { locked: true });
    if (!res.ok) throw new Error(`state check failed (${res.status})`);
    return (await res.json()).state;
  }
  const listUrl = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${REPO.dir}?ref=${REPO.branch}`;
  return (await ghFetch(listUrl))
    .filter((f) => f.type === 'file' && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md')
    .map((f) => ({ file: f.name, sha: f.sha }));
}

const fingerprint = (state) =>
  state
    .map((s) => `${s.file}:${s.sha}`)
    .sort()
    .join('|');

const currentFingerprint = () => fingerprint(tasks.map((t) => ({ file: t.file, sha: t.sha })));

let pollTimer = null;

async function pollChanges() {
  // Never fight a save in flight, reload while a field is being typed into, or
  // rebuild the board while a card is mid-drag — re-rendering replaces the node
  // being dragged, and the browser abandons the gesture with it.
  if (busy || dragActive || !navigator.onLine) return;
  const typing = document.activeElement;
  if (typing && /INPUT|TEXTAREA|SELECT/.test(typing.tagName) && typing.id !== 'search') return;

  try {
    const state = await fetchState();
    if (readIsStale(state)) return; // our own write has not propagated yet
    if (fingerprint(state) === currentFingerprint()) return;

    const openId = openFile ? byFile(openFile)?.id : null;
    tasks = await loadTasks();

    // The open card may have been renamed or deleted while we were looking away.
    if (openFile) {
      const still = openId ? tasks.find((t) => t.id === openId) : byFile(openFile);
      if (still) openFile = still.file;
      else {
        closeDrawer();
        toast('That task was removed elsewhere.');
      }
    }
    render();
  } catch (err) {
    if (err?.locked) {
      boardPassword.value = '';
      showLock('The board password changed — enter the new one.');
      return;
    }
    /* offline or rate-limited: stay quiet and try again next tick */
  }
}

function startPolling() {
  clearInterval(pollTimer);
  // Authenticated calls are plentiful (5000/hr); anonymous ones are capped at
  // 60/hr, so an unauthenticated board checks in far less often.
  const period = gateway.active || gh.connected ? 20000 : 120000;
  pollTimer = setInterval(() => {
    if (!document.hidden) pollChanges();
  }, period);
}

// Coming back to the tab is the moment you most expect to see other people's
// changes, so check immediately rather than waiting for the next tick.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollChanges();
});
window.addEventListener('online', pollChanges);

/* ----------------------------------------------------------- markdown <-> task */

function parseTask(file, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  const meta = {};
  let body = text.trim();

  if (match) {
    body = match[2].trim();
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at === -1) continue;
      meta[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }

  const raw = (meta.status || 'backlog').toLowerCase();
  const status = LEGACY_STATUS[raw] || raw;
  return {
    file,
    // The filename is the id, so a file written without the field (an older
    // client, or a hand-made file) still resolves instead of losing its identity.
    id: meta.id || (/^LC-\d+$/.test(file.replace(/\.md$/, '')) ? file.replace(/\.md$/, '') : ''),
    title: meta.title || file.replace(/\.md$/, ''), // id-named files have no title to infer
    status: SECTIONS.some((s) => s.id === status) ? status : 'backlog',
    assignee: meta.assignee || '',
    due: /^\d{4}-\d{2}-\d{2}$/.test(meta.due || '') ? meta.due : '',
    // Optional first day. With `due` as the last day this makes the task an
    // event that occupies a span of days rather than a single deadline.
    start: /^\d{4}-\d{2}-\d{2}$/.test(meta.start || '') ? meta.start : '',
    // Any other dates the task carries — a trip's flights, a deadline mentioned
    // in the brief. Agents append here after reading a task, so every date in a
    // task ends up on the calendar rather than only its due date.
    events: parseEvents(meta.events),
    labels: (meta.labels || '').split(',').map((s) => s.trim()).filter(Boolean),
    parent: (meta.parent || '').trim(),
    links: (meta.links || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Archived tasks stay in the repo as a record; they just leave the board.
    archived: /^(true|yes)$/i.test((meta.archived || '').trim()),
    prio: /^(true|yes|high|1)$/i.test((meta.prio || '').trim()),
    // A second --- block still sitting in the body means someone prepended a
    // new header rather than rewriting the file: the fields below are stale.
    malformed: /^---\r?\n[\s\S]*?\r?\n---/.test(body),
    // Hand-placed position in its column. Absent until the card is dragged,
    // which is what keeps an untouched column alphabetical.
    order: Number.isFinite(parseFloat(meta.order)) ? parseFloat(meta.order) : null,
    body,
  };
}

// `events: 2026-08-11..2026-08-13 London trip, 2026-09-01 Invoice due`
// One line, comma separated, each entry a date or a date range and a label.
function parseEvents(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => {
      const m = /^\s*(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*(\d{4}-\d{2}-\d{2}))?\s*(.*)$/.exec(part);
      if (!m) return null;
      const from = m[1];
      const to = m[2] && m[2] >= from ? m[2] : from;
      return { from, to, label: m[3].trim() };
    })
    .filter(Boolean);
}

const eventsToField = (list) =>
  list.map((e) => `${e.from}${e.to && e.to !== e.from ? `..${e.to}` : ''}${e.label ? ' ' + e.label : ''}`).join(', ');

function toMarkdown(task) {
  return [
    '---',
    ...(task.id ? [`id: ${task.id}`] : []),
    `title: ${task.title}`,
    `status: ${task.status}`,
    `assignee: ${task.assignee || ''}`,
    ...(task.start ? [`start: ${task.start}`] : []),
    ...(task.events?.length ? [`events: ${eventsToField(task.events)}`] : []),
    `due: ${task.due || ''}`,
    `labels: ${task.labels.join(', ')}`,
    ...(task.parent ? [`parent: ${task.parent}`] : []),
    ...(task.links?.length ? [`links: ${task.links.join(', ')}`] : []),
    ...(task.archived ? ['archived: true'] : []),
    ...(task.prio ? ['prio: true'] : []),
    ...(task.order != null ? [`order: ${task.order}`] : []),
    '---',
    '',
    task.body || '',
    '',
  ].join('\n');
}

// Every mutation goes through here: rewrite the file, commit, update in place.
async function saveTask(task, message) {
  if (!canEdit()) throw new Error('This board is read-only.');
  setBusy(true);
  try {
    const res = await putFile(REPO, `${REPO.dir}/${task.file}`, toMarkdown(task), message, task.sha);
    task.sha = res.content.sha; // keep the new sha or the next save 409s
    noteWrite(task.file, task.sha);
    render();
  } catch (err) {
    // The file moved or vanished under us — an old tab, or a rename elsewhere.
    // Writing blindly here is what forks a task into a duplicate, so re-resolve
    // the task by its id and retry once against the file that actually exists.
    if (task.id && /not found|404|422|sha/i.test(err.message)) {
      const fresh = (await loadTasks()).find((t) => t.id === task.id);
      if (fresh && fresh.file !== task.file) {
        task.file = fresh.file;
        task.sha = fresh.sha;
        const res = await putFile(REPO, `${REPO.dir}/${task.file}`, toMarkdown(task), message, task.sha);
        task.sha = res.content.sha;
        noteWrite(task.file, task.sha);
        render();
        return;
      }
    }
    throw err;
  } finally {
    setBusy(false);
  }
}


function setBusy(on) {
  busy = on;
  document.body.classList.toggle('busy', on);
}

/* ---------------------------------------------------------------- rendering */

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '')).toUpperCase() || '?';
}
const personName = (id) => PEOPLE[id]?.name || id;
const personColor = (id) => PEOPLE[id]?.color || '#9a988c';

// Fills an avatar element with that person's picture, keeping the initials
// underneath: if the image is missing or fails to load, nothing looks broken.
function paintAvatar(node, id) {
  node.textContent = initials(personName(id));
  node.style.background = personColor(id);
  node.title = personName(id);
  const src = PEOPLE[id]?.img;
  if (!src) return node;
  const img = new Image();
  img.src = src;
  img.alt = personName(id);
  img.className = 'avatar-img';
  img.addEventListener('load', () => {
    node.textContent = '';
    node.appendChild(img);
  });
  return node;
}

const LABEL_TINTS = [
  { bg: '#e9ead6', fg: '#5c6132', dot: '#8a944e' },
  { bg: '#f5e7cd', fg: '#8a6420', dot: '#c9922e' },
  { bg: '#f6dfd9', fg: '#96493c', dot: '#cd6a56' },
  { bg: '#dde7ec', fg: '#3d6178', dot: '#5b8aa6' },
  { bg: '#dfeada', fg: '#48693f', dot: '#6d9861' },
  { bg: '#ebe0e9', fg: '#7b4a72', dot: '#a06a97' },
];
function labelTint(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 997;
  return LABEL_TINTS[hash % LABEL_TINTS.length];
}

const parseDay = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const isOverdue = (iso) => {
  const t = new Date();
  return parseDay(iso) < new Date(t.getFullYear(), t.getMonth(), t.getDate());
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Written out rather than localised, so the same card reads the same way to
// everyone on the board regardless of whose browser is showing it. The year is
// left off unless the date is not in this one, where its absence would mislead.
function formatDate(iso) {
  const date = parseDay(iso);
  const stem = `${date.getDate()}. ${MONTHS[date.getMonth()]}.`;
  return date.getFullYear() === new Date().getFullYear() ? stem : `${stem} ${date.getFullYear()}`;
}

// Whole days from today; negative once the date has passed.
function daysUntil(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((parseDay(iso) - today) / 86400000);
}

function matchesFilter(task) {
  if (filter.assignee === '__none__') {
    if (task.assignee) return false;
  } else if (filter.assignee && task.assignee !== filter.assignee) return false;
  if (filter.label && !task.labels.includes(filter.label)) return false;
  if (filter.prio && !task.prio) return false;
  if (filter.text && !`${task.id} ${task.title} ${task.body}`.toLowerCase().includes(filter.text)) return false;
  return true;
}

function cardNode(task) {
  const card = el(
    'div',
    `card ${task.status}${task.archived ? ' is-archived' : ''}${task.prio ? ' is-prio' : ''}`
  );
  card.dataset.file = task.file;
  card.draggable = canEdit();
  card.title = `${task.id ? task.id + ' — ' : ''}${canEdit() ? 'click to edit · drag to move' : 'click to open on GitHub'}`;

  const chips = el('div', 'card-labels');
  for (const name of task.labels) {
    const tint = labelTint(name);
    const chip = el('span', 'label', name);
    chip.style.setProperty('--lbg', tint.bg);
    chip.style.setProperty('--lfg', tint.fg);
    chips.appendChild(chip);
  }
  if (chips.children.length) card.appendChild(chips);

  card.appendChild(el('div', 'card-title', task.title));

  const meta = el('div', 'card-meta');
  // An indicator, not a button. It used to clear the flag on click, which meant
  // clicking it to check what it was is what unset it.
  if (task.malformed) {
    const warn = el('span', 'badge malformed-badge', '⚠');
    warn.title = 'This file has two frontmatter blocks — an agent probably wrote a new header above the old one. Open it and merge them.';
    meta.appendChild(warn);
  }
  if (task.prio) {
    const flag = el('span', 'badge prio-badge');
    flag.appendChild(glyph('flag'));
    flag.title = 'Priority';
    meta.appendChild(flag);
  }
  if (task.id) meta.appendChild(el('span', 'task-id', task.id));
  if (task.due && task.status !== 'done') {
    const left = daysUntil(task.due);
    const state = left < 0 ? ' overdue' : left <= 2 ? ' soon' : '';
    const pill = el('span', 'label due' + state);
    pill.append(glyph('cal'), el('span', null, formatDate(task.due)));
    pill.title =
      left < 0 ? `${-left} day${left === -1 ? '' : 's'} overdue`
      : left === 0 ? 'Due today'
      : left === 1 ? 'Due tomorrow'
      : `Due in ${left} days`;
    meta.appendChild(pill);
  }
  if (task.parent) {
    const up = el('span', 'rel-chip', `↳ ${task.parent}`);
    up.title = `Part of ${byId(task.parent)?.title || task.parent}`;
    meta.appendChild(up);
  }
  const kids = childrenOf(task.id);
  if (kids.length) {
    const done = kids.filter((k) => k.status === 'done').length;
    const chip = el('span', 'rel-chip', `${done}/${kids.length} subtasks`);
    meta.appendChild(chip);
  }
  const files = attachmentsOf(task);
  if (files.length) {
    const clip = el('span', 'badge');
    clip.append(glyph('clip'), document.createTextNode(String(files.length)));
    clip.title = files.length === 1 ? files[0].name : `${files.length} attachments`;
    meta.appendChild(clip);
  }
  if (task.archived) {
    meta.appendChild(el('span', 'rel-chip archived', 'archived'));
    if (canEdit()) {
      const restore = el('button', 'card-action', 'Restore');
      restore.title = 'Put this task back on the board';
      restore.addEventListener('click', (e) => {
        e.stopPropagation(); // the card itself opens the detail panel
        setArchived(task, false);
      });
      meta.appendChild(restore);
    }
  }

  const avatar = el('div', 'avatar' + (task.assignee ? '' : ' empty'));
  if (task.assignee) paintAvatar(avatar, task.assignee);
  else avatar.title = 'Unassigned';
  if (canEdit()) {
    avatar.classList.add('avatar-button');
    avatar.title = `${task.assignee ? personName(task.assignee) : 'Unassigned'} — click to change`;
    avatar.addEventListener('click', (e) => {
      e.stopPropagation(); // the card itself opens the detail panel
      openAssignMenu(task, avatar);
    });
  }
  meta.appendChild(avatar);
  card.appendChild(meta);

  card.addEventListener('click', (e) => {
    if (e.target.closest('.avatar-button')) return;
    if (card.dataset.suppressClick) return;
    if (canEdit()) openDrawer(task.file);
    else window.open(editUrl(task.file), '_blank', 'noopener');
  });

  if (canEdit()) {
    card.addEventListener('dragstart', (e) => {
      dragHeight = card.getBoundingClientRect().height;
      dragActive = true;
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', task.file);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      dragActive = false;
      card.classList.remove('dragging');
      clearInsertion();
      document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    });
    enableTouchDrag(card, task);
  }
  return card;
}

function render() {
  if (view === 'calendar') {
    renderCalendar();
    renderWorkload();
    renderLabels();
    renderPrioFilter();
    renderConnection();
    if (openFile && !$('#drawer').hidden) renderDrawer();
    return;
  }
  const board = $('#board');
  board.innerHTML = '';

  for (const section of SECTIONS) {
    const wrap = el('div', 'column');
    wrap.dataset.status = section.id;

    const head = el('div', 'col-head');
    head.style.setProperty('--c', section.color);
    head.append(el('span', 'title', section.title));
    // Agents are told to leave this column alone in BOT.md; the header does not
    // need to repeat it at everyone all day.
    if (section.humansOnly) head.title = 'Human-only — agents leave this column alone';
    const visible = columnTasks(section.id);
    head.appendChild(el('span', 'count', String(visible.length)));

    // Finished work piles up: clear it from the header, where you look at it.
    if (section.id === 'done' && canEdit()) {
      const ready = tasks.filter((t) => t.status === 'done' && !t.archived).length;
      if (ready) {
        const sweep = el('button', 'head-action', `Archive all (${ready})`);
        sweep.title = 'Move finished tasks off the board — the files stay in the repo';
        sweep.addEventListener('click', (e) => {
          e.stopPropagation(); // the header itself renames on double-click
          archiveDone();
        });
        head.appendChild(sweep);
      }

      // While archived work is on screen, offer the reverse of Archive all.
      if (showArchived) {
        const back = tasks.filter((t) => t.status === 'done' && t.archived).length;
        if (back) {
          const restoreAll = el('button', 'head-action', `Restore all (${back})`);
          restoreAll.addEventListener('click', (e) => {
            e.stopPropagation();
            restoreDone();
          });
          head.appendChild(restoreAll);
        }
      }
    }

    const body = el('div', 'col-body');
    for (const task of visible) body.appendChild(cardNode(task));

    const add = el('button', 'add-card', '+ Add task');
    add.addEventListener('click', () => startNewCard(section.id, body, add));
    body.appendChild(add);



    if (canEdit()) {
      body.addEventListener('dragover', (e) => {
        e.preventDefault();
        wrap.classList.add('drop-target');
        markInsertion(body, dropIndex(body, e.clientY));
      });
      body.addEventListener('dragleave', (e) => {
        // dragleave also fires crossing between cards inside the column.
        if (body.contains(e.relatedTarget)) return;
        wrap.classList.remove('drop-target');
        clearInsertion();
      });
      body.addEventListener('drop', (e) => {
        e.preventDefault();
        dragActive = false;
        const at = dropIndex(body, e.clientY);
        wrap.classList.remove('drop-target');
        clearInsertion();
        moveTask(e.dataTransfer.getData('text/plain'), section.id, at);
      });
    }

    wrap.append(head, body);
    board.appendChild(wrap);
  }

  renderWorkload();
  renderLabels();
  renderPrioFilter();
  renderSectionTabs();
  renderConnection();
  if (openFile && !$('#drawer').hidden) renderDrawer();
}

function renderWorkload() {
  const strip = $('#workload');
  strip.innerHTML = '';
  const load = {};
  let unassigned = 0;
  for (const task of tasks) {
    if (task.status === 'done' || !onBoard(task)) continue;
    if (task.assignee) load[task.assignee] = (load[task.assignee] || 0) + 1;
    else unassigned++;
  }

  const chip = (label, count, value, avatar) => {
    const node = el('button', 'wchip' + (filter.assignee === value ? ' active' : ''));
    if (avatar) node.appendChild(avatar);
    node.append(el('span', 'wname', label), el('span', 'wcount', String(count)));
    node.addEventListener('click', () => {
      filter.assignee = filter.assignee === value ? '' : value;
      render();
    });
    return node;
  };

  strip.appendChild(chip('Everyone', tasks.filter((t) => t.status !== 'done' && onBoard(t)).length, ''));
  const ids = new Set([...Object.keys(PEOPLE), ...tasks.map((t) => t.assignee).filter(Boolean)]);
  for (const id of ids) {
    const av = paintAvatar(el('span', 'wavatar'), id);
    strip.appendChild(chip(personName(id), load[id] || 0, id, av));
  }
  if (unassigned) strip.appendChild(chip('Unassigned', unassigned, '__none__', el('span', 'wavatar empty')));

  const archived = tasks.filter((t) => t.archived).length;
  if (archived) {
    const toggle = el('button', 'wchip archive-toggle' + (showArchived ? ' active' : ''));
    toggle.append(el('span', 'wname', showArchived ? 'Hide archived' : 'Show archived'), el('span', 'wcount', String(archived)));
    toggle.addEventListener('click', () => {
      showArchived = !showArchived;
      render();
    });
    strip.appendChild(toggle);
  }
}

function renderLabels() {
  const list = $('#labels');
  list.innerHTML = '';
  const names = [...new Set(tasks.filter(onBoard).flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b));
  if (!names.length) return list.appendChild(el('div', 'muted small', 'No labels yet'));
  for (const name of names) {
    const chip = el('button', 'lchip' + (filter.label === name ? ' active' : ''));
    chip.style.setProperty('--c', labelTint(name).dot);
    chip.appendChild(el('span', 'lname', name));
    chip.addEventListener('click', () => {
      filter.label = filter.label === name ? '' : name;
      render();
    });
    list.appendChild(chip);
  }
}

// Its own chip rather than a label, because priority is a property of the task
// and labels are whatever you happen to have typed.
function renderPrioFilter() {
  const list = $('#prio-filter');
  if (!list) return;
  list.innerHTML = '';
  const count = tasks.filter((t) => onBoard(t) && t.prio).length;
  const chip = el('button', 'lchip prio-chip' + (filter.prio ? ' active' : ''));
  chip.appendChild(glyph('flag'));
  chip.appendChild(el('span', 'lname', 'Priority only'));
  chip.appendChild(el('span', 'wcount', String(count)));
  chip.title = count ? `${count} flagged` : 'Nothing flagged yet';
  chip.addEventListener('click', () => {
    filter.prio = !filter.prio;
    render();
  });
  list.appendChild(chip);
}

function renderSectionTabs() {
  const strip = $('#sectiontabs');
  strip.innerHTML = '';
  SECTIONS.forEach((section, i) => {
    const count = tasks.filter((t) => t.status === section.id && onBoard(t) && matchesFilter(t)).length;
    const tab = el('button', 'sectiontab' + (i === 0 ? ' active' : ''));
    tab.style.setProperty('--c', section.color);
    tab.dataset.status = section.id;
    tab.append(el('span', 't', section.title), el('span', 'n', String(count)));
    tab.addEventListener('click', () => {
      const node = document.querySelectorAll('.column')[i];
      if (node) $('#board').scrollTo({ left: node.offsetLeft, behavior: 'smooth' });
      document.querySelectorAll('.sectiontab').forEach((t) => t.classList.toggle('active', t === tab));
    });
    strip.appendChild(tab);
  });
}

function renderConnection() {
  const btn = $('#btn-connect');
  // In gateway mode the server holds the token, so none of this UI applies.
  if (gateway.active) {
    if (btn) btn.hidden = true;
    const banner = $('#banner');
    if (banner) {
      banner.hidden = gateway.canWrite;
      banner.classList.toggle('error', !gateway.canWrite);
      const text = $('#banner-text');
      if (text)
        text.innerHTML =
          '<strong>Read-only.</strong> This board is served by a gateway that has no GitHub token — add GITHUB_TOKEN to its secrets to enable editing.';
      const connect = $('#banner-connect');
      if (connect) connect.hidden = true;
      const help = $('#banner-help');
      if (help) help.hidden = true;
    }
    const live = $('#live');
    if (live) {
      live.classList.toggle('off', !gateway.canWrite);
      live.title = gateway.canWrite ? 'Changes commit through the server' : 'Read-only — server has no token';
    }
    return;
  }
  if (btn) {
    btn.hidden = false;
    btn.textContent = gh.connected ? 'GitHub token' : 'Connect GitHub';
  }

  const banner = $('#banner');
  const text = $('#banner-text');
  const connect = $('#banner-connect');
  const help = $('#banner-help');
  if (!banner || !text || !connect) return;

  if (tokenRejected) {
    banner.hidden = false;
    banner.classList.add('error');
    text.innerHTML =
      '<strong>Your saved token was rejected</strong> — it was probably regenerated or revoked. ' +
      'The board is showing tasks read-only. Save the current token to edit again.';
    connect.textContent = 'Update token';
    if (help) help.hidden = false;
  } else if (permissionProblem) {
    banner.hidden = false;
    banner.classList.add('error');
    text.innerHTML =
      "<strong>Your token can read but not write.</strong> On the token page open it, set " +
      "<strong>Permissions → Contents → Read and write</strong> (and make sure <strong>workforce</strong> " +
      'is among its repositories), save, then reconnect with the updated token.';
    connect.textContent = 'Reconnect';
    help.hidden = false;
  } else if (!gh.connected) {
    banner.hidden = false;
    banner.classList.remove('error');
    text.innerHTML =
      '<strong>Read-only.</strong> Connect GitHub to drag cards and edit them — changes are saved as commits in your repo.';
    connect.textContent = 'Connect GitHub';
    help.hidden = false;
  } else {
    banner.hidden = true;
  }

  const live = $('#live');
  live.classList.toggle('off', !gh.connected || permissionProblem || tokenRejected);
  live.title = permissionProblem
    ? 'Connected, but the token cannot write'
    : gh.connected
      ? 'Connected — changes commit to the repo'
      : 'Read-only — connect a token to edit';
}

/* ---------------------------------------------------------------- calendar */

const isoDay = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function setView(next) {
  view = next;
  const stale = $('#board');
  if (stale && next !== 'board') stale.innerHTML = '';
  $('#view-board')?.classList.toggle('active', next === 'board');
  $('#view-calendar')?.classList.toggle('active', next === 'calendar');
  const board = $('#board');
  const cal = $('#calendar');
  if (board) board.hidden = next !== 'board';
  if (cal) cal.hidden = next !== 'calendar';
  const tabs = $('#sectiontabs');
  if (tabs) tabs.style.display = next === 'board' ? '' : 'none';
  render();
}

// Everything a task puts on the calendar: its own dates, plus every event
// listed on it. One function, so the calendar and the card never disagree.
function calendarEntries(task) {
  const out = [];
  if (task.due) {
    const from = task.start && task.start <= task.due ? task.start : task.due;
    out.push({ from, to: task.due, label: task.title, own: true });
  }
  for (const ev of task.events || []) out.push({ ...ev, label: ev.label || task.title });
  return out;
}

// Every day an entry occupies, tagged so the calendar can draw a continuous
// bar: 'start', 'mid', 'end' for a range, and null for a single day.
function spanDays(entry) {
  if (entry.from === entry.to) return [[entry.to, null]];
  const out = [];
  const cursor = parseDay(entry.from);
  const stop = parseDay(entry.to);
  // A runaway range would render thousands of cells; a year is already absurd.
  for (let guard = 0; cursor <= stop && guard < 400; guard++) {
    const iso = isoDay(cursor);
    out.push([iso, iso === entry.from ? 'start' : iso === entry.to ? 'end' : 'mid']);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function renderCalendar() {
  const grid = $('#cal-grid');
  if (!grid) return;
  const today = new Date();
  if (!calMonth) calMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const title = $('#cal-title');
  if (title) title.textContent = calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // Dated tasks land on the grid. A task with `start` occupies every day from
  // there to `due`, so a three-day trip reads as three days rather than one.
  const visible = tasks.filter((t) => onBoard(t) && matchesFilter(t));
  const byDay = new Map();
  for (const task of visible) {
    for (const entry of calendarEntries(task)) {
      for (const [iso, part] of spanDays(entry)) {
        if (!byDay.has(iso)) byDay.set(iso, []);
        byDay.get(iso).push({ task, entry, part });
      }
    }
  }

  const undated = visible.filter((t) => !calendarEntries(t).length).length;
  const note = $('#cal-undated');
  if (note) note.textContent = undated ? `${undated} task${undated === 1 ? '' : 's'} without a date` : '';

  grid.innerHTML = '';
  for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    grid.appendChild(el('div', 'cal-weekday', name));
  }

  // Start on the Monday of the week containing the 1st.
  const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);

  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const iso = isoDay(day);
    const outside = day.getMonth() !== calMonth.getMonth();
    const cell = el('div', 'cal-day' + (outside ? ' outside' : '') + (iso === isoDay(today) ? ' today' : ''));
    cell.appendChild(el('div', 'cal-date', String(day.getDate())));

    for (const { task, entry, part } of byDay.get(iso) || []) {
      const chip = el(
        'button',
        `cal-task${task.status === 'done' ? ' done' : ''}${part ? ' span-' + part : ''}`
      );
      const colour = SECTIONS.find((sec) => sec.id === task.status)?.color || '#9a988c';
      // A one-day task keeps its dot; a span is drawn as a bar in the same
      // colour, so the eye follows it across the week without reading titles.
      if (part) chip.style.setProperty('--c', colour);
      else {
        const dot = el('span', 'linkdot');
        dot.style.background = colour;
        chip.appendChild(dot);
      }
      // Only the first day of a span carries the title; the rest continue it.
      chip.appendChild(el('span', 'cal-task-title', part && part !== 'start' ? '' : entry.label));
      chip.title =
        entry.from === entry.to
          ? `${task.id} · ${entry.label}`
          : `${task.id} · ${entry.label} (${entry.from} → ${entry.to})`;
      chip.addEventListener('click', () => openDrawer(task.file));
      cell.appendChild(chip);
    }
    grid.appendChild(cell);
  }
}

/* ------------------------------------------------------------------ actions */

const byFile = (file) => tasks.find((t) => t.file === file);
const byId = (id) => tasks.find((t) => t.id === id);
const childrenOf = (id) => (id ? tasks.filter((t) => t.parent === id) : []);

// Archived work is hidden by default but never removed from the repo.
let showArchived = false;
let view = 'board';                 // 'board' | 'calendar'
// Remembered per browser: a collapsed sidebar should stay collapsed.
let sidebarHidden = localStorage.getItem('board.sidebar') === 'hidden';
let calMonth = null;                // first day of the month on screen
const onBoard = (t) => showArchived || !t.archived;

// A task cannot be filed under itself or under one of its own descendants.
function wouldCycle(task, parentId) {
  let cursor = byId(parentId);
  while (cursor) {
    if (cursor.id === task.id) return true;
    cursor = cursor.parent ? byId(cursor.parent) : null;
  }
  return false;
}

// A write failed: surface it where it can be acted on, not in a popup.
function reportWriteFailure(err) {
  if (/permission|read but not write/i.test(err.message)) {
    permissionProblem = true;
    renderConnection();
    toast('GitHub refused the change — see the note above the board.', 'error');
  } else {
    toast(err.message, 'error');
  }
}

async function setPrio(task, on) {
  const was = task.prio;
  task.prio = on;
  render();
  try {
    await saveTask(task, `task: ${on ? 'prio' : 'no prio'} ${task.file.replace(/\.md$/, '')}`);
    permissionProblem = false;
  } catch (err) {
    task.prio = was;
    render();
    reportWriteFailure(err);
  }
}

/* --------------------------------------------------------- manual ordering */

// Cards carry an `order`. A column nobody has reordered has none at all and
// stays alphabetical; the first drop into it numbers the whole column once, and
// every drop after that writes one file — one commit — by landing the card on a
// number between its two new neighbours.
//
// Numbering the column up front is what makes that safe. Mixing stored numbers
// with numbers implied from alphabetical rank looks like it should work, but the
// two spaces collide: a card stored at 1000 next to a card whose implied rank is
// also 1000 leaves no gap to land in.
const ORDER_STEP = 1000;

// Explicit where it exists, alphabetical rank where it does not. Implied ranks
// are whole multiples of the step, which is what lets a stored order sit between
// two of them without ever tying.
function effectiveOrders(list) {
  const alpha = [...list].sort((a, b) => a.title.localeCompare(b.title));
  const map = new Map();
  alpha.forEach((t, i) => map.set(t.file, (i + 1) * ORDER_STEP));
  for (const t of list) if (t.order != null) map.set(t.file, t.order);
  return map;
}

function sortForColumn(list) {
  const eff = effectiveOrders(list);
  return [...list].sort(
    (a, b) => eff.get(a.file) - eff.get(b.file) || a.title.localeCompare(b.title)
  );
}

const columnTasks = (status) =>
  sortForColumn(tasks.filter((t) => t.status === status && onBoard(t) && matchesFilter(t)));

// Open a gap the size of the card being dragged, so the column shows the shape
// of the result rather than a line marking an edge.
let placeholder = null;
let dragHeight = 0;
let dragActive = false;

function markInsertion(body, at) {
  if (!placeholder) placeholder = el('div', 'card-placeholder');
  placeholder.style.height = `${dragHeight || 64}px`;
  const cards = [...body.querySelectorAll('.card')].filter(
    (c) => !c.classList.contains('dragging') && !c.classList.contains('touch-source')
  );
  const before = at < cards.length ? cards[at] : body.querySelector('.add-card');
  if (before) body.insertBefore(placeholder, before);
  else body.appendChild(placeholder);
}

function clearInsertion() {
  placeholder?.remove();
}

// Which slot the pointer is pointing at, counting gaps between cards.
function dropIndex(body, y) {
  const cards = [...body.querySelectorAll('.card')].filter(
    (c) => !c.classList.contains('dragging') && !c.classList.contains('touch-source')
  );
  for (let i = 0; i < cards.length; i++) {
    const box = cards[i].getBoundingClientRect();
    if (y < box.top + box.height / 2) return i;
  }
  return cards.length;
}

// Number a whole column from its current on-screen order, leaving room between
// the cards. Runs once when a column is first reordered, and again in the rare
// case that repeated midpoints exhaust the gap. Files go up in parallel: they
// are separate paths, so they do not contend for each other's sha.
async function spreadColumn(status) {
  const column = tasks
    .filter((t) => t.status === status && onBoard(t))
    .sort((a, b) => {
      const eff = effectiveOrders(tasks.filter((x) => x.status === status && onBoard(x)));
      return eff.get(a.file) - eff.get(b.file) || a.title.localeCompare(b.title);
    });

  const changed = [];
  column.forEach((t, i) => {
    const fresh = (i + 1) * ORDER_STEP;
    if (t.order !== fresh) {
      t.order = fresh;
      changed.push(t);
    }
  });
  if (!changed.length) return;

  const where = SECTIONS.find((s) => s.id === status)?.title || status;
  toast(`Spacing out ${where} — ${changed.length} card${changed.length === 1 ? '' : 's'}…`);
  render();
  // One at a time: each write is a commit, and GitHub serialises commits on a
  // branch, so firing them together makes them collide.
  for (const t of changed) await saveTask(t, `task: order ${t.file.replace(/\.md$/, '')}`);
}

async function moveTask(file, status, index = null) {
  const task = byFile(file);
  if (!task) return;
  if (task.status === status && index == null) return; // dropped where it began

  const was = { status: task.status, order: task.order };
  const sameColumn = task.status === status;

  // Neighbours in the destination column as displayed, this card taken out.
  const shown = columnTasks(status);
  const currentIndex = shown.findIndex((t) => t.file === file);
  const column = shown.filter((t) => t.file !== file);
  const at = index == null ? column.length : Math.max(0, Math.min(index, column.length));
  if (sameColumn && at === currentIndex) return; // dropped back into its own slot

  // Land between the neighbours' effective orders — stored where the card has
  // one, implied from its position where it does not. Numbering the column
  // first would be tidier, but on a git-backed board that is one commit per
  // card, and firing those at once races the branch into 409s. One drop is one
  // write.
  // Computed over `shown`, the same list whose order put the cards on screen.
  // Working these out over `column` instead would renumber the implied ranks of
  // everything alphabetically after the card being dragged, so the neighbours
  // would no longer be in ascending order and a drop could land a slot out.
  const eff = effectiveOrders(shown);
  const above = column[at - 1];
  const below = column[at];
  const lo = above ? eff.get(above.file) : (below ? eff.get(below.file) - ORDER_STEP : 0);
  const hi = below ? eff.get(below.file) : (above ? eff.get(above.file) + ORDER_STEP : ORDER_STEP);

  // Midpoints halve the gap each time; after ~20 drops into the same slot there
  // is no room left. Spreading the column out again is the only path that
  // writes more than one file, and one you have to work at to reach.
  if (hi - lo < 0.002) {
    try {
      await spreadColumn(status);
    } catch (err) {
      Object.assign(task, was);
      render();
      return reportWriteFailure(err);
    }
    return moveTask(file, status, index);
  }

  // An implied order is always a whole multiple of the step, so a midpoint that
  // lands on one would tie with a card that has no order of its own. Step off it.
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const taken = new Set(column.map((t) => eff.get(t.file)));  // never tie with a neighbour
  let landed = round3((lo + hi) / 2);
  while (taken.has(landed) && landed + 0.001 < hi) landed = round3(landed + 0.001);

  task.status = status;
  task.order = landed;
  render();
  try {
    const name = task.file.replace(/\.md$/, '');
    await saveTask(task, was.status === status ? `task: reorder ${name}` : `task: ${name} → ${status}`);
    permissionProblem = false;
  } catch (err) {
    Object.assign(task, was); // put it back where it was
    render();
    reportWriteFailure(err);
  }
}

// Inline composer in the column — no browser prompt. Title, date and who, so a
// task can be filed complete instead of needing to be opened again afterwards.
function startNewCard(status, body, addBtn) {
  if (body.querySelector('.composer')) return;

  const box = el('div', 'composer');
  const title = el('textarea', 'new-card-input');
  title.rows = 2;
  title.placeholder = 'Task title — Enter to save, Esc to cancel';

  const row = el('div', 'composer-row');
  const due = el('input', 'composer-due');
  due.type = 'date';
  due.title = 'Due date (optional)';

  const who = el('select', 'composer-who');
  who.title = 'Responsible (optional)';
  who.appendChild(el('option', null, 'Unassigned')).value = '';
  for (const id of Object.keys(PEOPLE)) {
    const opt = el('option', null, personName(id));
    opt.value = id;
    who.appendChild(opt);
  }

  const save = el('button', 'primary small', 'Add');
  row.append(due, who, save);
  box.append(title, row);
  body.insertBefore(box, addBtn);
  title.focus();

  let settled = false;
  const finish = async (keep) => {
    if (settled) return;
    settled = true;
    const text = title.value.trim();
    box.remove();
    if (keep && text) await createTask(status, text, { due: due.value || '', assignee: who.value || '' });
    else render();
  };

  save.addEventListener('click', () => finish(true));
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
    if (e.key === 'Escape') finish(false);
  });
  // Clicking the date or person field must not count as abandoning the card.
  box.addEventListener('focusout', (e) => {
    if (!box.contains(e.relatedTarget)) finish(true);
  });
}

// Sequential and human-quotable: "look at LC-014". Never reuses a number, so an
// id keeps pointing at the same task even after files are renamed or deleted.
function nextTaskId() {
  const used = tasks
    .map((t) => /^LC-(\d+)$/.exec(t.id || ''))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `LC-${String(next).padStart(3, '0')}`;
}

async function createTask(status, title, extra = {}) {
  if (!canEdit()) {
    toast('This board is read-only.', 'error');
    render();
    return;
  }
  // The file is named after the id and nothing else, so retitling a task never
  // has to move a file — which is what used to fork tasks into duplicates.
  const id = nextTaskId();
  const file = `${id}.md`;

  const task = { file, id, title, status, assignee: '', due: '', labels: [], parent: '', links: [], archived: false, body: '', sha: null, ...extra };
  tasks.push(task); // optimistic, so the card appears immediately
  render();
  setBusy(true);
  try {
    const res = await putFile(REPO, `${REPO.dir}/${file}`, toMarkdown(task), `task: add ${id}`);
    task.sha = res.content.sha;
    permissionProblem = false;
    toast('Task created');
  } catch (err) {
    tasks = tasks.filter((t) => t !== task); // roll back the card
    reportWriteFailure(err);
  } finally {
    setBusy(false);
    render();
  }
}

// Two-step delete instead of confirm(), which also blocks the page.
let pendingDelete = null;
function requestDelete(file) {
  const btn = $('#d-delete');
  if (pendingDelete !== file) {
    pendingDelete = file;
    btn.textContent = 'Tap again to delete';
    btn.classList.add('armed');
    setTimeout(() => {
      if (pendingDelete === file) {
        pendingDelete = null;
        btn.textContent = 'Delete task';
        btn.classList.remove('armed');
      }
    }, 4000);
    return;
  }
  pendingDelete = null;
  btn.textContent = 'Delete task';
  btn.classList.remove('armed');
  removeTask(file);
}

async function setArchived(task, archived) {
  const before = task.archived;
  task.archived = archived;
  render();
  try {
    await saveTask(task, `task: ${archived ? 'archive' : 'restore'} ${task.id || task.file}`);
    toast(archived ? `${task.id} archived` : `${task.id} restored`);
  } catch (err) {
    task.archived = before;
    render();
    reportWriteFailure(err);
  }
}

// Clear finished work off the board in one go; the files stay in the repo.
async function archiveDone() {
  const done = tasks.filter((t) => t.status === 'done' && !t.archived);
  if (!done.length) return toast('Nothing in Done to archive.');
  setBusy(true);
  let ok = 0;
  try {
    for (const task of done) {
      task.archived = true;
      try {
        await saveTask(task, `task: archive ${task.id || task.file}`);
        ok++;
      } catch (err) {
        task.archived = false;
        reportWriteFailure(err);
        break; // stop at the first refusal rather than hammering GitHub
      }
    }
  } finally {
    setBusy(false);
    render();
    if (ok) toast(`Archived ${ok} task${ok === 1 ? '' : 's'}`);
  }
}

// The mirror of archiveDone: bring finished work back onto the board.
async function restoreDone() {
  const archived = tasks.filter((t) => t.status === 'done' && t.archived);
  if (!archived.length) return;
  setBusy(true);
  let ok = 0;
  try {
    for (const task of archived) {
      task.archived = false;
      try {
        await saveTask(task, `task: restore ${task.id || task.file}`);
        ok++;
      } catch (err) {
        task.archived = true;
        reportWriteFailure(err);
        break;
      }
    }
  } finally {
    setBusy(false);
    render();
    if (ok) toast(`Restored ${ok} task${ok === 1 ? '' : 's'}`);
  }
}

async function removeTask(file) {
  const task = byFile(file);
  if (!task) return;
  setBusy(true);
  try {
    await deleteFile(REPO, `${REPO.dir}/${file}`, `task: remove ${file.replace(/\.md$/, '')}`, task.sha);
    tasks = tasks.filter((t) => t.file !== file);
    permissionProblem = false;
    closeDrawer();
    toast('Task deleted');
  } catch (err) {
    reportWriteFailure(err);
  } finally {
    setBusy(false);
    render();
  }
}

/* --------------------------------------------- who is responsible (quick pick) */

function closeAssignMenu() {
  const menu = $('#assign-menu');
  if (menu) menu.hidden = true;
}

function openAssignMenu(task, anchor) {
  const menu = $('#assign-menu');
  if (!menu) return;
  menu.innerHTML = '';
  menu.appendChild(el('div', 'head', 'Responsible'));

  const choose = (id) => {
    closeAssignMenu();
    if ((task.assignee || '') === (id || '')) return;
    patchOpen_forTask(task, { assignee: id || '' }, `task: assign ${task.id} -> ${id || 'nobody'}`);
  };

  const none = el('button', 'assign-option' + (task.assignee ? '' : ' current'));
  none.append(el('div', 'avatar empty'), el('span', null, 'Unassigned'));
  none.addEventListener('click', () => choose(''));
  menu.appendChild(none);

  for (const id of Object.keys(PEOPLE)) {
    const option = el('button', 'assign-option' + (task.assignee === id ? ' current' : ''));
    const who = el('div');
    who.appendChild(el('div', null, personName(id)));
    option.append(paintAvatar(el('div', 'avatar'), id), who);
    option.addEventListener('click', () => choose(id));
    menu.appendChild(option);
  }

  menu.hidden = false;
  // Anchor under the avatar, nudged back on screen if it would overflow.
  const box = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  menu.style.top = `${Math.min(box.bottom + 6, window.innerHeight - size.height - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left - 150, window.innerWidth - size.width - 8))}px`;
  setTimeout(() => document.addEventListener('pointerdown', closeAssignOnce, { once: true }), 0);
}

function closeAssignOnce(e) {
  if (e.target.closest('#assign-menu')) {
    document.addEventListener('pointerdown', closeAssignOnce, { once: true });
    return;
  }
  closeAssignMenu();
}

// Same save path as the detail panel, but for a task that may not be open.
function patchOpen_forTask(task, change, message) {
  const before = { ...task };
  Object.assign(task, change);
  render();
  saveTask(task, message)
    .then(() => {
      permissionProblem = false;
    })
    .catch((err) => {
      Object.assign(task, before);
      render();
      reportWriteFailure(err);
    });
}

/* -------------------------------------------------------------- attachments */

const readAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(',')[1]); // strip the data: prefix
    reader.readAsDataURL(file);
  });

// Keep the name recognisable but safe for a URL and for the API's validation.
const safeFileName = (name) =>
  name
    .replace(/[^\w .-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(-90) || 'file';

async function attachFiles(task, files) {
  if (!canEdit()) return toast('This board is read-only.', 'error');
  if (!task.id) return toast('This task has no id to attach files to.', 'error');

  const list = [...files];
  const tooBig = list.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
  for (const f of tooBig) toast(`${f.name} is over ${MAX_ATTACHMENT_BYTES / 1e6} MB`, 'error');

  const usable = list.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
  if (!usable.length) return;

  setBusy(true);
  const added = [];
  try {
    for (const file of usable) {
      const name = safeFileName(file.name);
      try {
        const url = await uploadAttachment(REPO, task.id, name, await readAsBase64(file));
        // Images embed so they show up; anything else becomes a plain link.
        added.push(/\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? `![${name}](${url})` : `[${name}](${url})`);
      } catch (err) {
        reportWriteFailure(err);
      }
    }
  } finally {
    setBusy(false);
  }

  if (!added.length) return;
  const heading = '## Attachments';
  const body = task.body.includes(heading)
    ? `${task.body.trimEnd()}\n${added.join('\n')}`
    : `${task.body.trimEnd()}\n\n${heading}\n${added.join('\n')}`;
  patchOpen({ body: body.trim() }, `task: attach ${added.length} file(s) to ${task.id}`);
  toast(`Attached ${added.length} file${added.length === 1 ? '' : 's'}`);
}

async function removeAttachment(task, file) {
  if (!canEdit()) return toast('This board is read-only.', 'error');
  setBusy(true);
  try {
    await deleteAttachment(REPO, task.id, file.name);
    // Take the link out of the brief as well, or the task still points at it.
    const escaped = file.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = new RegExp(`^.*!?\\[[^\\]]*\\]\\(${escaped}\\).*$\\n?`, 'm');
    const body = task.body.replace(line, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    patchOpen({ body }, `task: remove ${file.name} from ${task.id}`);
    toast(`Removed ${file.name}`);
  } catch (err) {
    reportWriteFailure(err);
  } finally {
    setBusy(false);
  }
}

// Anything already attached, pulled back out of the description.
function attachmentsOf(task) {
  const found = [];
  const re = /!?\[([^\]]+)\]\((https:\/\/raw\.githubusercontent\.com\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(task.body || ''))) found.push({ name: m[1], url: m[2] });
  return found;
}

/* ------------------------------------------------------------------ drawer */

function openDrawer(file) {
  openFile = file;
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  renderDrawer();
}

// One row in the subtask / related lists — click to jump to that task.
function taskLink(task) {
  const li = el('li', 'linkrow' + (task.status === 'done' ? ' done' : ''));
  const dot = el('span', 'linkdot');
  dot.style.background = SECTIONS.find((s) => s.id === task.status)?.color || '#9a988c';
  const button = el('button', 'linkbtn');
  button.append(el('span', 'task-id', task.id), el('span', null, task.title));
  button.addEventListener('click', () => openDrawer(task.file));
  li.append(dot, button);
  return li;
}

function closeDrawer() {
  openFile = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

// The dates a task carries, listed so you can see and remove what an agent
// added after reading the brief.
function renderEventList(task) {
  const list = $('#d-events');
  if (!list) return;
  list.innerHTML = '';
  const own = task.due
    ? [{ from: task.start && task.start <= task.due ? task.start : task.due, to: task.due, label: 'Due', own: true }]
    : [];
  const rows = [...own, ...(task.events || [])];
  if (!rows.length) {
    list.appendChild(el('li', 'muted small', 'No dates yet'));
    return;
  }
  rows.forEach((ev, i) => {
    const li = el('li');
    const when = ev.from === ev.to ? formatDate(ev.from) : `${formatDate(ev.from)} – ${formatDate(ev.to)}`;
    li.append(el('span', 'task-id', when), el('span', null, ev.label || task.title));
    // The due date is edited by its own field above, not removed from here.
    if (!ev.own && canEdit()) {
      const drop = el('button', 'icon-btn', '✕');
      drop.title = 'Remove this date';
      drop.addEventListener('click', () => {
        const next = (task.events || []).filter((_, n) => n !== i - own.length);
        patchOpen({ events: next }, `task: dates ${task.file.replace(/\.md$/, '')}`);
      });
      li.appendChild(drop);
    }
    list.appendChild(li);
  });
}

// A textarea clips whatever does not fit its rows, and a task title is exactly
// the field you must be able to read in full. Grow it to its content instead.
function autosize(node) {
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${node.scrollHeight}px`;
}

function renderDrawer() {
  const task = byFile(openFile);
  if (!task) return closeDrawer();
  const focused = document.activeElement;
  const editing = focused && $('#drawer').contains(focused) && /INPUT|TEXTAREA|SELECT/.test(focused.tagName);

  const section = SECTIONS.find((s) => s.id === task.status);
  const chip = $('#drawer-section');
  chip.textContent = section?.title || task.status;
  chip.style.setProperty('--c', section?.color || '#9a988c');

  if (!editing) {
    $('#d-title').value = task.title;
    autosize($('#d-title'));
    $('#d-desc').value = task.body;
    $('#d-start').value = task.start || '';
    $('#d-due').value = task.due;
    $('#d-labels').value = task.labels.join(', ');
  }

  const prio = $('#d-prio');
  if (prio) prio.checked = !!task.prio;

  renderEventList(task);

  const assignee = $('#d-assignee');
  assignee.innerHTML = '<option value="">Unassigned</option>';
  const ids = new Set([...Object.keys(PEOPLE), ...(task.assignee ? [task.assignee] : [])]);
  for (const id of ids) {
    const opt = el('option', null, personName(id));
    opt.value = id;
    assignee.appendChild(opt);
  }
  assignee.value = task.assignee;

  const status = $('#d-status');
  status.innerHTML = '';
  for (const s of SECTIONS) {
    const opt = el('option', null, s.title);
    opt.value = s.id;
    status.appendChild(opt);
  }
  status.value = task.status;

  // Part of: every other task, minus anything that would create a loop.
  const parentSel = $('#d-parent');
  if (parentSel) {
    parentSel.innerHTML = '<option value="">— none —</option>';
    for (const other of tasks) {
      if (other.id === task.id || !other.id || wouldCycle(task, other.id)) continue;
      const label = other.title.length > 44 ? `${other.title.slice(0, 43)}…` : other.title;
      const opt = el('option', null, `${other.id} · ${label}`);
      opt.value = other.id;
      parentSel.appendChild(opt);
    }
    parentSel.value = task.parent || '';
  }
  if (!editing) {
    const linksInput = $('#d-links');
    if (linksInput) linksInput.value = (task.links || []).join(', ');
  }

  const kids = childrenOf(task.id);
  const kidsWrap = $('#d-subtasks-wrap');
  if (kidsWrap) {
    kidsWrap.hidden = !canEdit() && !kids.length;
    const list = $('#d-subtasks');
    const count = $('#d-subtask-count');
    if (count) count.textContent = kids.length ? `${kids.filter((k) => k.status === 'done').length}/${kids.length}` : '';
    if (list) {
      list.innerHTML = '';
      for (const kid of kids) list.appendChild(taskLink(kid));
      if (!kids.length) list.appendChild(el('li', 'muted small', 'None yet'));
    }
  }

  const related = (task.links || []).map(byId).filter(Boolean);
  const relWrap = $('#d-related-wrap');
  if (relWrap) {
    relWrap.hidden = !related.length;
    const list = $('#d-related');
    if (list) {
      list.innerHTML = '';
      for (const other of related) list.appendChild(taskLink(other));
    }
  }

  $('#d-file').textContent = `${task.id ? task.id + ' · ' : ''}${REPO.dir}/${task.file}`;
  const files = attachmentsOf(task);
  const attachWrap = $('#d-attach-wrap');
  if (attachWrap) {
    attachWrap.hidden = !files.length;
    const list = $('#d-attachments');
    if (list) {
      list.innerHTML = '';
      for (const f of files) {
        const li = el('li', 'attachrow');
        const link = el('a', 'attachlink', f.name);
        link.href = f.url;
        link.target = '_blank';
        link.rel = 'noopener';
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)) {
          const thumb = new Image();
          thumb.src = f.url;
          thumb.className = 'attachthumb';
          thumb.alt = f.name;
          li.appendChild(thumb);
        }
        li.appendChild(link);
        if (canEdit()) {
          const del = el('button', 'icon-btn attach-remove', '✕');
          del.title = `Delete ${f.name} from the repo`;
          del.addEventListener('click', () => {
            if (del.dataset.armed) return removeAttachment(task, f);
            del.dataset.armed = '1';
            del.textContent = 'delete?';
            setTimeout(() => {
              delete del.dataset.armed;
              del.textContent = '✕';
            }, 4000);
          });
          li.appendChild(del);
        }
        list.appendChild(li);
      }
    }
  }
  const zone = $('#d-dropzone');
  if (zone) zone.hidden = !canEdit();

  const archiveBtn = $('#d-archive');
  if (archiveBtn) {
    archiveBtn.textContent = task.archived ? 'Restore' : 'Archive';
    archiveBtn.hidden = !canEdit();
  }
  $('#d-github').href = editUrl(task.file);
}

function patchOpen(change, message) {
  const task = byFile(openFile);
  if (!task) return;
  const before = { ...task };
  Object.assign(task, change);
  render();
  saveTask(task, message)
    .then(() => {
      permissionProblem = false;
    })
    .catch((err) => {
      Object.assign(task, before); // undo the edit we couldn't save
      render();
      reportWriteFailure(err);
    });
}

/* -------------------------------------------------------- drag with a finger */

const LONG_PRESS_MS = 260;
function enableTouchDrag(node, task) {
  let timer = null;
  let ghost = null;
  let start = null;
  let dragging = false;

  const cancel = () => {
    clearTimeout(timer);
    node.classList.remove('press');
  };

  node.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return;
      start = { x: e.clientX, y: e.clientY };
      node.classList.add('press');
      timer = setTimeout(() => {
        dragging = true;
        dragActive = true;
        dragHeight = node.getBoundingClientRect().height;
        node.classList.remove('press');
        node.classList.add('touch-source');
        $('#board').style.scrollSnapType = 'none';
        ghost = node.cloneNode(true);
        ghost.classList.add('touch-ghost');
        ghost.style.width = `${node.getBoundingClientRect().width}px`;
        document.body.appendChild(ghost);
        moveGhost(start.x, start.y);
        navigator.vibrate?.(8);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );

  const moveGhost = (x, y) => {
    ghost.style.left = `${x - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${y - 28}px`;
  };

  node.addEventListener(
    'pointermove',
    (e) => {
      if (!start) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
        return;
      }
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
      highlightAt(e.clientX, e.clientY);
    },
    { passive: false }
  );

  const finish = (e) => {
    cancel();
    dragActive = false;
    if (!dragging) return (start = null);
    dragging = false;
    start = null;
    ghost?.remove();
    ghost = null;
    node.classList.remove('touch-source');
    clearHighlight();
    $('#board').style.scrollSnapType = '';
    node.dataset.suppressClick = '1';
    setTimeout(() => delete node.dataset.suppressClick, 300);

    const under = elementUnder(e.clientX, e.clientY);
    const tabStatus = under?.closest('.sectiontab')?.dataset.status;
    if (tabStatus) return moveTask(task.file, tabStatus); // tabs move, they don't place
    const column = under?.closest('.column');
    if (!column) return;
    const body = column.querySelector('.col-body');
    moveTask(task.file, column.dataset.status, body ? dropIndex(body, e.clientY) : null);
  };

  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);
}

function elementUnder(x, y) {
  const ghost = document.querySelector('.touch-ghost');
  if (ghost) ghost.style.display = 'none';
  const under = document.elementFromPoint(x, y);
  if (ghost) ghost.style.display = '';
  return under;
}
function highlightAt(x, y) {
  clearHighlight();
  const under = elementUnder(x, y);
  const tab = under?.closest('.sectiontab');
  if (tab) return tab.classList.add('tab-over');
  const column = under?.closest('.column');
  if (!column) return;
  column.classList.add('touch-over');
  const body = column.querySelector('.col-body');
  if (body) markInsertion(body, dropIndex(body, y));
}
function clearHighlight() {
  document.querySelectorAll('.touch-over').forEach((n) => n.classList.remove('touch-over'));
  document.querySelectorAll('.tab-over').forEach((n) => n.classList.remove('tab-over'));
  clearInsertion();
}

/* ------------------------------------------------------------------ wiring */

on('#search', 'input', (e) => {
  filter.text = e.target.value.trim().toLowerCase();
  render();
});
on('#btn-refresh', 'click', () => start());
function applySidebar() {
  document.body.classList.toggle('sidebar-off', sidebarHidden);
  const btn = $('#btn-sidebar');
  if (btn) btn.title = sidebarHidden ? 'Show the sidebar' : 'Hide the sidebar';
}
on('#btn-sidebar', 'click', () => {
  sidebarHidden = !sidebarHidden;
  localStorage.setItem('board.sidebar', sidebarHidden ? 'hidden' : 'shown');
  applySidebar();
});
applySidebar();

on('#view-board', 'click', () => setView('board'));
on('#view-calendar', 'click', () => setView('calendar'));
on('#cal-prev', 'click', () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
  renderCalendar();
});
on('#cal-next', 'click', () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
  renderCalendar();
});
on('#cal-today', 'click', () => {
  const now = new Date();
  calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  renderCalendar();
});
const repoLink = $('#repo-link');
if (repoLink) repoLink.href = `https://github.com/${REPO.owner}/${REPO.name}/tree/${REPO.branch}/${REPO.dir}`;

// Shows what is actually stored, so the token has a visible home rather than
// being an invisible thing you re-enter and hope about.
function renderTokenStatus() {
  const box = $('#token-status');
  if (!box) return;
  box.hidden = !gh.connected;
  if (!gh.connected) return;

  box.classList.toggle('bad', permissionProblem);
  const state = $('#token-state');
  const value = $('#token-value');
  const saved = $('#token-saved');
  if (state) state.textContent = permissionProblem ? 'Saved, but it cannot write' : 'Saved and working';
  if (value) value.textContent = gh.masked;
  if (saved) {
    const when = gh.savedAt ? new Date(gh.savedAt) : null;
    saved.textContent = when
      ? `Stored in this browser since ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      : 'Stored in this browser';
  }
}

function openTokenModal() {
  const input = $('#token-input');
  const modal = $('#token-modal');
  if (!modal || !input) return;
  input.value = '';
  const err = $('#token-error');
  if (err) err.hidden = true;

  renderTokenStatus();
  // Replacing a saved token has to be possible without disconnecting first —
  // otherwise a broken token locks you out of entering a working one.
  const remove = $('#token-disconnect');
  if (remove) remove.hidden = !gh.connected;
  const howto = $('#token-howto');
  if (howto) howto.open = !gh.connected; // steps expanded only when there's nothing saved
  const save = $('#token-save');
  if (save) save.textContent = gh.connected ? 'Replace token' : 'Save token';

  modal.hidden = false;
  if (!gh.connected) input.focus();
}

// Proves the stored token still works, from the panel, without touching a card.
async function testToken() {
  const btn = $('#token-test');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Testing…';
  }
  try {
    await checkAccess(REPO);
    // A read succeeding says nothing about writing, so try a real (harmless)
    // write: rewrite one task file with its own current content.
    const probe = tasks[0];
    if (probe) {
      await putFile(REPO, `${REPO.dir}/${probe.file}`, toMarkdown(probe), 'task: verify write access', probe.sha)
        .then((res) => {
          probe.sha = res.content.sha;
        });
    }
    permissionProblem = false;
    toast('Token works — reading and writing.');
  } catch (err) {
    if (/permission|read but not write/i.test(err.message)) permissionProblem = true;
    toast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Test it';
    }
    renderTokenStatus();
    renderConnection();
  }
}

function closeTokenModal() {
  const modal = $('#token-modal');
  if (modal) modal.hidden = true;
}

// Always opens the dialog; disconnecting lives inside it.
function connectGitHub() {
  openTokenModal();
}

function disconnectGitHub() {
  gh.token = '';
  permissionProblem = false;
  closeTokenModal();
  render();
  toast('Token removed — the board is read-only again.');
}

// Ask the browser's password manager to remember the token, so other devices
// that sync with it fill it in instead of you retyping. Chromium implements
// this explicitly; elsewhere the form markup lets the manager offer it itself.
// Browsers evict "best effort" storage under pressure, and Safari clears
// script-written storage on sites you haven't opened for a week — which would
// silently log the board out. Asking for persistent storage exempts it.
async function keepStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* not supported — nothing lost, storage is just best-effort */
  }
}

async function offerToRemember(token) {
  try {
    if (!window.PasswordCredential || !navigator.credentials?.store) return;
    const credential = new window.PasswordCredential({
      id: `${REPO.owner}/${REPO.name}`,
      password: token,
      name: 'Board — GitHub token',
    });
    await navigator.credentials.store(credential);
  } catch {
    /* the manager declined or is unavailable — the form fallback still applies */
  }
}

async function saveToken() {
  const input = $('#token-input');
  const err = $('#token-error');
  const token = input.value.trim();
  if (!token) return;

  const previous = gh.token;
  gh.token = token;
  const saveBtn = $('#token-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    await checkAccess(REPO);
    // The repo endpoint reports OUR access, not the token's, so it cannot prove
    // the token may write. The first real save is the honest test.
    permissionProblem = false;
    tokenRejected = false;
    await keepStorage();
    await offerToRemember(token);
    renderTokenStatus();
    closeTokenModal();
    await start();
    toast('Connected — drag a card to test it saves.');
  } catch (e) {
    gh.token = previous;
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

on('#btn-connect', 'click', connectGitHub);
on('#banner-connect', 'click', connectGitHub);
on('#token-form', 'submit', (e) => {
  e.preventDefault();
  saveToken();
});
on('#token-cancel', 'click', closeTokenModal);
on('#token-disconnect', 'click', disconnectGitHub);
on('#token-test', 'click', testToken);
on('#token-modal', 'click', (e) => e.target.id === 'token-modal' && closeTokenModal());

on('#drawer-close', 'click', closeDrawer);
on('#scrim', 'click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

on('#d-title', 'input', (e) => autosize(e.target));
on('#d-title', 'change', (e) => {
  const value = e.target.value.trim();
  const task = byFile(openFile);
  if (value && task && value !== task.title) patchOpen({ title: value }, `task: retitle ${task.id || task.file}`);
});
on('#d-desc', 'change', (e) =>
  patchOpen({ body: e.target.value }, `task: edit ${openFile.replace(/\.md$/, '')}`)
);
on('#d-due', 'change', (e) =>
  patchOpen({ due: e.target.value }, `task: due ${openFile.replace(/\.md$/, '')}`)
);
on('#d-start', 'change', (e) => {
  const task = byFile(openFile);
  if (!task) return;
  const start = e.target.value;
  // A start with no end is just a start; give it one so it lands somewhere.
  const patch = start && !task.due ? { start, due: start } : { start };
  patchOpen(patch, `task: start ${openFile.replace(/\.md$/, '')}`);
});
on('#d-labels', 'change', (e) =>
  patchOpen(
    { labels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) },
    `task: labels ${openFile.replace(/\.md$/, '')}`
  )
);
on('#d-assignee', 'change', (e) =>
  patchOpen({ assignee: e.target.value }, `task: assign ${openFile.replace(/\.md$/, '')}`)
);
on('#d-status', 'change', (e) => moveTask(openFile, e.target.value));
on('#d-event-add', 'click', () => {
  const task = byFile(openFile);
  const from = $('#d-event-from')?.value;
  if (!task || !from) return toast('Pick a date first.', 'error');
  const to = $('#d-event-to')?.value;
  const label = ($('#d-event-label')?.value || '').trim();
  const next = [...(task.events || []), { from, to: to && to >= from ? to : from, label }];
  $('#d-event-from').value = '';
  $('#d-event-to').value = '';
  $('#d-event-label').value = '';
  patchOpen({ events: next }, `task: dates ${task.file.replace(/\.md$/, '')}`);
});
on('#d-prio', 'change', (e) => {
  const task = byFile(openFile);
  if (task) setPrio(task, e.target.checked);
});
on('#d-parent', 'change', (e) => {
  const task = byFile(openFile);
  if (!task) return;
  const value = e.target.value;
  if (value && wouldCycle(task, value)) {
    toast('That would put the task inside itself.', 'error');
    e.target.value = task.parent || '';
    return;
  }
  patchOpen({ parent: value }, `task: parent ${task.id} -> ${value || 'none'}`);
});

on('#d-links', 'change', (e) => {
  const task = byFile(openFile);
  if (!task) return;
  const wanted = e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const unknown = wanted.filter((id) => !byId(id));
  if (unknown.length) {
    toast(`No such task: ${unknown.join(', ')}`, 'error');
    e.target.value = (task.links || []).join(', ');
    return;
  }
  patchOpen({ links: wanted.filter((id) => id !== task.id) }, `task: links ${task.id}`);
});

// Adding a subtask creates a real task already filed under this one.
async function addSubtask() {
  const input = $('#d-subtask-new');
  const parent = byFile(openFile);
  if (!input || !parent) return;
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await createTask(parent.status === 'done' ? 'backlog' : parent.status, title, { parent: parent.id });
  renderDrawer();
}
on('#d-subtask-add', 'click', addSubtask);
on('#d-subtask-new', 'keydown', (e) => e.key === 'Enter' && addSubtask());

on('#d-archive', 'click', () => {
  const task = byFile(openFile);
  if (task) setArchived(task, !task.archived);
});

// The whole dialog is the drop target, so you can let go anywhere on it.
const drawerEl = $('#drawer');
if (drawerEl) {
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  drawerEl.addEventListener('dragover', (e) => {
    stop(e);
    if (canEdit()) drawerEl.classList.add('dropping');
  });
  drawerEl.addEventListener('dragleave', (e) => {
    if (!drawerEl.contains(e.relatedTarget)) drawerEl.classList.remove('dropping');
  });
  drawerEl.addEventListener('drop', (e) => {
    stop(e);
    drawerEl.classList.remove('dropping');
    const task = byFile(openFile);
    if (task && e.dataTransfer?.files?.length) attachFiles(task, e.dataTransfer.files);
  });
}
on('#d-pick', 'click', () => $('#d-file-input')?.click());
on('#d-file-input', 'change', (e) => {
  const task = byFile(openFile);
  if (task && e.target.files?.length) attachFiles(task, e.target.files);
  e.target.value = '';
});

on('#d-delete', 'click', () => requestDelete(openFile));

// One password for the whole board. It lives in this browser only, is sent
// on every gateway call, and a wrong or missing one brings the lock screen
// back rather than an error in the corner.
function showLock(message) {
  const lock = $('#lock');
  if (!lock) return;
  $('#lock-error').textContent = message || '';
  $('#lock-error').hidden = !message;
  lock.hidden = false;
  $('#lock-input').value = '';
  setTimeout(() => $('#lock-input').focus(), 0);
}
function hideLock() {
  const lock = $('#lock');
  if (lock) lock.hidden = true;
}
on('#lock-form', 'submit', (e) => {
  e.preventDefault();
  boardPassword.value = $('#lock-input').value;
  hideLock();
  start();
});
on('#btn-lock', 'click', () => {
  boardPassword.value = '';
  tasks = [];
  render();
  showLock();
});

async function start() {
  try {
    if (!gateway.active) await detectGateway();
    if (gateway.needsPassword && !boardPassword.value) return showLock();
    $('#board').replaceChildren(el('div', 'muted', 'Loading from GitHub…'));
    tasks = await loadTasks();
    render();
    startPolling();
  } catch (err) {
    if (err.locked) {
      const hadOne = Boolean(boardPassword.value);
      boardPassword.value = '';
      return showLock(hadOne ? 'That password was not accepted.' : '');
    }
    $('#board').innerHTML = '';
    $('#board').appendChild(el('div', 'muted', err.message));
    renderConnection();
  }
}

start();
