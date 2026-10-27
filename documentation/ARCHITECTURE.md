# Architecture

![How PookieWookie fits together](architecture.svg)

> The diagram is a real Excalidraw scene. Open [`architecture.excalidraw`](architecture.excalidraw)
> — or the SVG itself, which carries the scene inside it — at [excalidraw.com](https://excalidraw.com)
> to edit it. Export again with **Embed scene** ticked and replace both files.

## The idea in one paragraph

The board has no database. Every task is a markdown file in `tasks/` of a GitHub repo, and every
change is a git commit. The board UI, the calendar, the agents and the history all read the same
files. A small Node server, the **gateway**, sits in front of GitHub: it serves the UI, holds the
GitHub token so no browser ever needs one, and checks every write against the board's rules before
committing it.

## Components

| Component | Where | What it does |
| --- | --- | --- |
| **Board UI** | `docs/` | Static HTML, CSS and JS. Kanban with drag & drop, calendar, filters, task panel, attachments, lock screen. No build step. |
| **Gateway** | `gateway.js` | One Node file, standard library only. Serves `docs/`, exposes the REST API, checks the password and agent rules, commits to GitHub. |
| **Task files** | `tasks/LC-###.md` in the repo | The data. Frontmatter for fields, markdown body for the brief and notes. Format: [`tasks/README.md`](../tasks/README.md). |
| **Attachments** | `attachments/LC-###/` in the repo | Files dropped onto a task, linked from its body. |
| **MCP server** | `mcp/server.js` | The board as eight native tools for MCP clients (Claude Code, Claude Desktop, Cursor). Talks to the gateway. |
| **Agents** | outside the repo | Anything that makes HTTP calls. The team's Telegram bot (OpenClaw on a netcup server, agent `007`) uses the gateway API directly. |

## Data model

One task is one file, named after its id and nothing else: `tasks/LC-028.md`.

```markdown
---
id: LC-028
title: London Trip 11-13 Aug
status: focus
assignee: 007
start: 2026-08-11
due: 2026-08-13
labels: travel
prio: true
events: 2026-08-11 Flight out 09:40
order: 1500
---

The brief. Everything below the frontmatter is free markdown.

## Notes
Findings, appended and dated.
```

| Field | Meaning |
| --- | --- |
| `status` | the column: `backlog` → `weekly` → `focus` → `review` → `done`, plus human-only `admin` |
| `assignee` | a person or agent id |
| `due`, `start`, `events` | every date a task carries; the calendar is derived from these and stores nothing itself |
| `order` | hand-sorted position in its column, sparse numbers so one drag is one write |
| `prio`, `labels`, `parent`, `links`, `archived` | flags, tags, subtask and relation links, soft delete |

Because the filename never depends on the title, renaming a task is a one-line edit and a task
cannot fork into two files.

## Request flow

All gateway endpoints are same-origin JSON.

| Endpoint | Auth | Does |
| --- | --- | --- |
| `GET /api/config` | open | mode, repo, whether writes and a password are needed — the lock screen reads this |
| `GET /api/tasks` | password | every task file with its text and blob `sha` |
| `GET /api/tasks/state` | password | file names and shas only — the cheap change check the UI polls |
| `PUT /api/tasks/:file` | password, agent rules | create or update one file: `{ text, message, sha? }` |
| `DELETE /api/tasks/:file` | password, agent rules | remove one file: `{ sha, message }` |
| `PUT /api/files/:id/:name` | password | attach a file: `{ content }` base64, up to `MAX_UPLOAD_BYTES` |
| `DELETE /api/files/:id/:name` | password | remove an attachment |
| anything else | open | static files from `docs/` |

A write goes: client sends the whole new file plus the `sha` it last read → gateway checks the
password, then the agent rules → GitHub Contents API commits it → the new `sha` comes back.

## Consistency

The repo is shared by people and agents writing at the same time, so every write is optimistic.

- **Concurrent writes.** A write carries the `sha` it read. If the file changed since, GitHub answers
  `409`; the UI and the MCP server re-read, reapply the same change to the new content, and write once
  more. Nothing is overwritten blind.
- **Stale reads.** GitHub's API is eventually consistent, so a poll a second after a commit can still
  return the old version. The UI remembers the `sha` of its own writes and ignores older reads of those
  files for up to 45 seconds, so a move does not appear to undo itself.
- **Polling.** The UI checks `/api/tasks/state` every 20 seconds and on tab focus, and reloads the
  tasks only when a sha changed. It does not poll while a card is being dragged.
- **Ordering.** Dropping a card computes a number between its new neighbours, so a drag is one commit
  rather than renumbering the whole column.

## Security model

| Layer | Protects | Does not protect |
| --- | --- | --- |
| `GITHUB_TOKEN` | lives only in the gateway's environment; browsers never receive it | — |
| `BOARD_PASSWORD` | reading and writing through the gateway; entered once per browser, kept in `localStorage` | per-person identity: it is one shared password |
| Agent rules | writes carrying `X-Agent-Id`: an agent may not touch tasks assigned to others, rename, change an id, delete, or use the admin column | an agent that omits the header, or writes to GitHub directly with its own token |
| Repo visibility | — | the task files themselves when the repo is public: the password guards the app, not GitHub |

Agents listed in `PMO_AGENTS` may manage any task and the admin column. Renames, id changes and
deletes stay refused for every agent. The rules are a guard rail against careless writes, not a
security boundary against a hostile agent.

## Agents

Three ways in, from most to least protected:

1. **MCP** — `mcp/server.js`. The server builds every file itself, so a model cannot produce a broken
   one; with `AGENT_ID` set the board's rules apply and a refusal is reported as non-retryable.
   [`mcp/README.md`](../mcp/README.md).
2. **Gateway HTTP** — `GET /api/tasks` and `PUT /api/tasks/:file` with `X-Agent-Id`. The agent builds the
   file itself. [`BOT.md`](../BOT.md) has the full contract and the mistakes to avoid.
3. **GitHub directly** — the Contents API with the agent's own token. Unchecked; only for agents that
   cannot reach the gateway.

## Running it

| Where | How | Notes |
| --- | --- | --- |
| Local | `npm start` → `http://localhost:4747` | Without `GITHUB_TOKEN` and with a `tasks/` folder present, the gateway reads and writes `tasks/` on disk (local mode). |
| Replit | `.replit` runs `git pull --ff-only` then `node gateway.js`; Reserved VM | Port 3000 inside the Repl, mapped to 80. Secrets hold `GITHUB_TOKEN`, `BOARD_PASSWORD`, `PMO_AGENTS`. Pulls new code on every start. |
| Codespaces | `.devcontainer/` starts the gateway on 4747 | For working on it, not hosting it. |

Configuration is environment variables only; see the table in the [README](../README.md#configuration).

## Tests

```bash
cd mcp && npm install && npm test
```

End to end: a real gateway on a scratch folder, the real MCP server over stdio, the SDK's client
driving it. Eight tests cover reads, the write cycle, calendar derivation, every agent refusal, PMO
mode, the unreachable-board path and the doubled-frontmatter guard. The repo's own `tasks/` is never
touched. The gateway and UI have no unit tests of their own yet.

## Known limitations

- **Team and columns are hardcoded** in `docs/app.js` (`PEOPLE`, `SECTIONS`). Changing either means
  editing the file.
- **The UI's GitHub links** ("Files", "open on GitHub") use the repo named in `docs/app.js`, not the
  gateway's `REPO_OWNER`/`REPO_NAME`. Change both if you point the gateway at another repo.
- **One shared password**, no per-person accounts.
- **Polling, not push.** Other people's changes arrive within about 20 seconds.

## Legacy

`server.js`, `storage.js`, `public/`, `data/seed.json` and the `postgres` dependency are the board's
earlier lineage: one JSON document in Postgres, served over Server-Sent Events. Nothing runs them —
`.replit`, `npm start` and the devcontainer all start `gateway.js` — and they are due for removal.
