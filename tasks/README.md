# Tasks

One task per file. Every `.md` file in this folder (except this README) is a card on the board at
the lc_kanban board (or https://lionscraft-io.github.io/workforce/docs/)

## Format

```markdown
---
id: LC-004
title: Renew passport before October trip
status: weekly
assignee: toni
due: 2026-09-01
labels: errands, travel
---

Book the appointment, bring the old passport and two photos.
Everything under the `---` block is the description — the brief.
```

| Field | Values |
| --- | --- |
| `id` | `LC-###`, assigned once and never changed — the stable way to refer to a task |
| `title` | any text. Falls back to the filename if missing. |
| `status` | `backlog`, `weekly`, `focus`, `review`, `done`, `admin` — decides the column. Default `backlog`. |
| `assignee` | `toni`, `Adi`, `007` (Pookachu Bot), or empty for unassigned |
| `due` | `YYYY-MM-DD`, or leave empty — one day on the calendar |
| `start` | `YYYY-MM-DD`, optional. With `due` the task spans those days on the calendar. |
| `events` | further dates, comma separated: `2026-08-11..2026-08-13 London trip, 2026-09-01 Invoice` |
| `labels` | comma-separated, or leave empty |
| `prio` | `true` for urgent — red border, a flag on the card, and its own sidebar filter |
| `order` | position in the column, low first. Absent means the column is alphabetical. |
| `parent` | another task's id, e.g. `LC-002` — makes this a subtask of it |
| `links` | comma-separated ids of related tasks, e.g. `LC-003, LC-004` |
| `archived` | `true` to keep the task in the repo but off the board |

## Label conventions

Use only these four top-level project/context labels: `personal`, `lionscraft`, `risk`, and `lido`.

ADB work is classified under `risk`. Do not create action, workstream, location, or organization labels; the task title and description hold that detail.

Files are named after the id alone: `LC-004.md`. Because the filename never depends on the title,
renaming a task is a one-line edit inside the file — nothing has to move, and a task can never be
accidentally forked into two files.

## The calendar

The Calendar tab is not a second store. It is every date any task carries, drawn on a month grid:
`due` for a deadline, `start` + `due` for a task that spans days, and `events` for any number of
further dates. There is no calendar entry without a task, which is why the calendar and the board
can never disagree.

## For agents

The full brief — both APIs, the loop, and how to share the board with humans without clobbering
their edits — is in [BOT.md](../BOT.md) at the repo root. In short:

1. Read your queue: every file where `assignee:` is you and `status:` is not `done`.
2. Claim it: set `status: weekly`, commit, *before* starting.
3. Report: append findings to the bottom of the file under a `## Notes` heading.
4. Hand back: set `status: review` — not `done`. A human confirms.
5. Stuck? Set `status: focus`, write the question in the file, commit. Do not guess.

`admin` is a human-only column: never take, move or edit a task in it. Prefer `archived: true`
over deleting, and never delete a task a human created.

Keep one deliverable per file. If you discover more work, add new files rather than growing one.
Commit messages should read like board activity: `task: LC-004 → review`.
