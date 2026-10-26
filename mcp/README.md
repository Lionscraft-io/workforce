# PookieWookie board — MCP server

Work the board as native tools from Claude Desktop, Claude Code, Cursor, or any
MCP client: list and read tasks, create them, change fields, append notes, read
the calendar.

It talks to the board's gateway over HTTP. No GitHub token is needed, and every
write passes through the same checks the board applies to everyone else.

## Setup

Three environment variables:

| Variable | | |
| --- | --- | --- |
| `BOARD_URL` | required | where the board runs, e.g. `https://your-board.replit.app` |
| `BOARD_PASSWORD` | if the board has one | the board's password |
| `AGENT_ID` | optional | act as this agent — see *Who is writing* below |

**Claude Code**

```bash
claude mcp add pookiewookie-board \
  -e BOARD_URL=https://your-board.replit.app \
  -e BOARD_PASSWORD=… \
  -- node /path/to/workforce/mcp/server.js
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pookiewookie-board": {
      "command": "node",
      "args": ["/path/to/workforce/mcp/server.js"],
      "env": { "BOARD_URL": "https://your-board.replit.app", "BOARD_PASSWORD": "…" }
    }
  }
}
```

**Cursor** — the same block in `.cursor/mcp.json`.

Run `npm install` in this folder once first. When the package is published,
`npx -y pookiewookie-board-mcp` replaces the `node …/server.js` part.

## Who is writing

Leave `AGENT_ID` unset when **a person is driving the assistant** — "move LC-14
to done", "rename LC-3". Writes count as that person's, with full access.

Set `AGENT_ID` (e.g. `007`) for **anything autonomous**. Writes then carry
`X-Agent-Id`, and the board refuses, with a reason, what an agent must not do:
touching a task assigned to someone else, changing a title or id, anything in
the `admin` column, assigning new work to a human. The tool result says the
refusal is a rule, not a transient error, so a model does not retry it.

## Tools

| Tool | Does |
| --- | --- |
| `board_info` | columns and their meaning, assignees seen, how this connection is acting |
| `list_tasks` | compact list; filter by `assignee`, `status`, `prio`, text `query`; archived hidden unless asked |
| `get_task` | one task in full — fields, body (brief + notes), subtasks |
| `create_task` | new task; the id is assigned (next `LC-` number) |
| `update_task` | change fields; only the fields given are touched; `add_events` puts dates on the calendar |
| `move_task` | change the column |
| `add_note` | append a dated note under `## Notes` — how work is reported |
| `list_calendar` | every dated entry in a window: due dates, start–due spans, events |

Read tools are annotated `readOnlyHint`, so clients that auto-approve reads can.

## How it writes

The model never writes a task file. The server parses the file into fields and
body, changes only what the tool call asked for, and emits exactly one
frontmatter block — it refuses to write otherwise. A file that already has two
blocks (an earlier agent prepended a header) is reported as `malformed` and
nothing will write through it until a human repairs it.

Writes read the file immediately before, send its `sha`, and on a `409` (someone
wrote first) read again and reapply the same change once.

## Tests

```bash
npm test
```

Starts a real gateway on a scratch task folder, the real server over stdio, and
drives it with the SDK's client. The repo's own `tasks/` is never touched.
