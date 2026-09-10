# Brief for an agent working this board

Give this file to any agent (Telegram bot, n8n flow, Claude, a script) that should work the
board alongside the humans. Everything it needs is here.

The board **is** the `tasks/` folder of the GitHub repo. There is no database. A task is a
markdown file; the columns, the calendar, the priority flags and the ordering are all fields
in those files. Write the file and the board changes for everyone, live.

## Identity and access

| | |
| --- | --- |
| Repo | `toniilein/workforce`, branch `main` |
| Task folder | `tasks/` |
| Attachments | `attachments/<task-id>/` |
| Your id | `007` (shows on the board as "Pookachu Bot") |
| Humans | `toni` (Toni), `Adi` (Adi) |

There are two ways in. Pick one:

**A. The board's own gateway** — simplest. The server holds the token, so the agent needs no
GitHub credentials at all. Base URL is wherever the board is running (the Replit URL). If the
board has a `BOARD_PASSWORD` set, send it as an `X-Board-Password` header.

**Send `X-Agent-Id: 007` on every write.** It is how the board knows an agent is writing, and
it turns on the checks below — which exist to catch your mistakes before they reach a human's
board, not to get in your way. Omitting it is not a shortcut; it is writing under a human's
name, which is worse than being refused.

**B. GitHub directly** — for agents that run nowhere near the board.
`Authorization: Bearer <YOUR_GITHUB_TOKEN>` on every request, with *Contents: Read and write*
on this repo only. Keep the token in the agent's own secret storage; never print it in a chat
reply and never commit it to a file.

## What a task looks like

One task = one file, named after its id and nothing else — `LC-007.md`:

```markdown
---
id: LC-007
title: Research risk events in Europe
status: weekly
assignee: 007
due: 2026-08-20
labels: research, urgent
prio: true
order: 2000
parent: LC-002
links: LC-003, LC-004
---

Everything below the --- block is the brief: context, links, definition of done.

## Notes
Findings get appended here.
```

| Field | Meaning |
| --- | --- |
| `id` | Permanent name. Quote it when reporting. **Never change it.** |
| `title` | One line, shown on the card |
| `status` | Which column — see below |
| `assignee` | `007`, `toni`, `Adi`, or empty |
| `due` | `YYYY-MM-DD`. **This is the calendar** — see below |
| `labels` | Comma-separated, free text |
| `prio` | `true` marks it urgent: red border and a flag on the card |
| `order` | Position within its column, low number first. See below |
| `parent` | Files this task under another (`parent: LC-002`) |
| `links` | Related tasks (`links: LC-003, LC-004`) |
| `archived` | `true` retires finished work: stays in the repo, leaves the board |

Only change the fields you mean to change — keep the rest of the file intact.

## The columns

`backlog` → `weekly` → `focus` → `review` → `done`, plus `admin`.

- **`admin` is human-only.** Never take, move, create or edit a task in that column.
- When you finish, put the task in **`review`, not `done`** — a human confirms it.
- Stuck? Put it in `focus`, write the question in the body, and stop. Do not guess.
- Prefer `archived: true` over deleting. Never delete a task a human created.

Older files may still say `todo`, `doing` or `blocked`; the board reads those as `backlog`,
`weekly` and `focus`. Write the new names.

## The calendar, and creating events

The Calendar tab is not a separate store — it is every date any task carries, drawn on a month
grid. A task can carry three kinds:

| Field | Puts on the calendar |
| --- | --- |
| `due: 2026-08-13` | one day — the deadline |
| `start: 2026-08-11` with `due: 2026-08-13` | the task itself, as a bar across 11–13 |
| `events: …` | any number of further dates, each its own entry |

**`events` is how an agent adds dates it found while reading a task.** One line, comma
separated. Each entry is a date, optionally `..` a second date for a range, then a label:

```
events: 2026-08-11..2026-08-13 London trip, 2026-08-11 Flight out 09:40, 2026-08-13 Flight back
```

That renders as a three-day bar plus two single-day entries. Without a label an entry shows the
task's title.

### Reading dates out of a task and putting them on the calendar

This is the job: a task called *Plan London Trip 11-13 Aug* with a brief mentioning flights has
its dates buried in prose, where the calendar cannot see them. So:

1. Read the task — title and body.
2. Pull out every date you can resolve to a real day. Resolve relative ones ("next Friday")
   against today, and bare ones ("11-13 Aug") against the current year unless the text says
   otherwise.
3. Append them to `events:`, each with a short label. **Keep what is already there** — read the
   field, add to it, write it back.
4. Write the file. They appear on everyone's calendar immediately.

If you are unsure a date is real, say so in `## Notes` rather than inventing a calendar entry.
A wrong date on a shared calendar is worse than a missing one.

Rules that keep this from going wrong:

- **`YYYY-MM-DD` only.** No times inside the date, no timezone. A date means that whole day —
  put a time in the label if it matters (`2026-08-11 Flight out 09:40`).
- **Never delete a date a human entered.** Add yours; leave theirs.
- **Do not duplicate.** Before appending, check the date is not already in `events` or in
  `due`/`start`.
- **An event always belongs to a task.** There is no calendar entry without one. If something
  needs a day of its own and belongs to no existing task, create a task for it with a `due`
  date — that is what keeps the board and the calendar from ever disagreeing.

## Priority and ordering

`prio: true` is the urgent flag — red border, a flag on the card, and its own filter in the
sidebar. Use it sparingly or it stops meaning anything. Humans set it too; do not clear a flag
a human set.

`order` is the card's position in its column, ascending. A column that nobody has hand-sorted
has no `order` fields at all and shows alphabetically. **An agent should normally leave `order`
alone** — it is how a human expresses "do this one first". If you must place a card, give it a
number between its two intended neighbours (they are spaced in thousands, so `1500` sits
between `1000` and `2000`).

## The loop

1. **Find your work** — list the tasks, keep the ones with `assignee: 007` whose `status` is
   not `done` and that are not `archived`. Do the `prio: true` ones first, then by `due`.
2. **Claim it** — set `status: weekly` and save, before you start, so a human can see it is
   being handled.
3. **Do the work** — the file body is the instruction.
4. **Report** — append your result under a `## Notes` heading in the same file. What you found,
   with links. This is how the human reads your output.
5. **Hand back** — set `status: review` and save.

One deliverable per file. If you discover more work, create new files rather than growing one.
Commit messages read like board activity: `task: LC-007 → review`.

## Calls — through the gateway

`BOARD` is the board's URL. Add `X-Board-Password: <password>` if one is set.

**Read everything** (one call, gives you the whole board and the calendar):

```
GET $BOARD/api/tasks
→ { "tasks": [ { "file": "LC-007.md", "sha": "…", "text": "---\nid: LC-007\n…" } ] }
```

**Write a task** (creates it if the file is new):

```
PUT $BOARD/api/tasks/LC-007.md
Content-Type: application/json

{ "text": "<the WHOLE new file as plain text>",
  "message": "task: LC-007 → review",
  "sha": "<the sha from the read>" }
```

**Delete a task** (rare — prefer `archived: true`):

```
DELETE $BOARD/api/tasks/LC-007.md
{ "message": "task: remove LC-007", "sha": "<sha>" }
```

**Attach a file** to a task:

```
PUT $BOARD/api/files/LC-007/report.pdf
{ "content": "<base64 of the file>" }
```

## Calls — straight to GitHub

**List:** `GET https://api.github.com/repos/toniilein/workforce/contents/tasks`
Returns `name`, `sha` and `download_url` per entry. Ignore `README.md`.

**Read one:** fetch its `download_url` (plain text, no auth needed — the repo is public), or
`GET …/contents/tasks/<file>.md`, which returns base64 `content` plus the `sha` you need to write.

**Write:**

```
PUT https://api.github.com/repos/toniilein/workforce/contents/tasks/LC-007.md
{ "message": "task: LC-007 → review",
  "content": "<the WHOLE new file, base64-encoded UTF-8>",
  "sha": "<the sha you just read>",
  "branch": "main" }
```

Two things that trip agents up:

- `content` is the **entire file**, base64 encoded — not a patch, not plain text.
- `sha` is required when updating and must be the current one. Omit it only when creating.

### The mistake that actually happens

Writing the whole file means **replacing** it — one `---` block at the top, then the body.
The common failure is emitting a fresh header above the content that is already there:

```markdown
---
id: LC-028
title: LC-028          ← a new block, with fields you did not carry over
status: backlog
---

---                    ← the real header, now buried in the body
id: LC-028
title: London Trip 11-13 Aug
status: focus
assignee: 007
---
```

The board reads the **first** block, so the card silently loses its title, status and
assignee. It has happened on this board. Before you write:

1. Parse the file you just read into fields + body.
2. Change only the fields you mean to change; **carry every other field through unchanged**.
3. Emit exactly one `---` block, then the body.
4. Check your output contains `---` exactly twice before sending it.

A card showing ⚠ on the board is this: two frontmatter blocks in one file.

## What the board will refuse

With `X-Agent-Id` set, the gateway rejects these with **403** and a message saying why:

| You tried to | Why it is refused |
| --- | --- |
| write a task assigned to someone else | agents work only their own tasks |
| change a task's `title` | the title is the human's words. Carry it through unchanged. |
| change a task's `id` | it is permanent and things point at it |
| write anything in the `admin` column | human-only |
| `DELETE` a task | use `archived: true` and say why in `## Notes` |
| create a task assigned to someone else | leave it unassigned and let a human route it |

A 403 is not a transient error. Do not retry it — read the message, fix what you were doing, and
if it still refuses, write the problem into `## Notes` on your own task and stop.

You may freely change your own task's `status`, `due`, `start`, `events`, `labels`, `archived`,
and the body below the frontmatter. That is the whole job.

## Working alongside humans and other agents

Everyone writes the same files at the same time, so:

- **Read immediately before you write.** The `sha` you send must be the one you just read.
- **On `409`, do not retry blindly** — re-read the file, reapply your change to the *new*
  content, then write. Blindly retrying is how a task loses someone's edit.
- **One task per agent.** Claim by setting `status` before working; that is the lock.
- **Never touch a task assigned to someone else**, and never touch the `admin` column. The
  gateway enforces both, but do not rely on being caught — an agent writing straight to GitHub
  is not checked at all.
- Humans drag cards while you work. Do not be surprised if `status` or `order` changed under
  you — take the new value, keep your own field edits.

## Errors you will meet

| Code | Meaning | Do this |
| --- | --- | --- |
| 401 | bad token, or wrong board password | ask the human |
| 403 | token lacks *Contents: Read and write* | ask the human to fix the token permission |
| 409 | the file changed since you read it | re-read, reapply, retry |
| 422 | usually a missing or wrong `sha` | re-read the file and use its current sha |
| 403 | *with a message* — you broke one of the rules above | read it, fix it, do not retry |
| 503 | the gateway has no token — board is read-only | ask the human to set `GITHUB_TOKEN` |

## Good manners

- Never touch a task that is not assigned to you.
- Never rename a task. The title is how a human recognises their own work.
- Never delete a task a human created; archive it and say why in the notes.
- Keep the frontmatter valid — a broken `---` block breaks the card.
- Say what you did in the notes, not just that you did it.
