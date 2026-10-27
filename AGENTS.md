# AGENTS.md

Orientation for an AI agent that opens this repository. Two different jobs live here:

- **Working the board** — reading tasks, moving them, writing notes. Read [BOT.md](BOT.md), or use
  the MCP server in [`mcp/`](mcp/README.md). Do not edit `tasks/` by hand from a checkout unless a
  human asked you to; the board writes those files through the gateway.
- **Changing the code** — the rest of this file.

## What runs

| File | Role |
| --- | --- |
| `gateway.js` | the server: static UI, REST API, password, agent rules, GitHub commits. Node standard library only |
| `docs/` | the board UI: `index.html`, `app.js`, `github.js`, `styles.css`. No build step |
| `mcp/server.js` | MCP server; talks to the gateway over HTTP |
| `tasks/` | the board's data, one markdown file per task |

`server.js`, `storage.js`, `public/` and `data/` are a retired earlier version. Nothing starts them.
Do not extend them or document against them.

Architecture, API and invariants: [documentation/ARCHITECTURE.md](documentation/ARCHITECTURE.md).

## Run and test

```bash
npm start                         # gateway on http://localhost:4747, local mode without GITHUB_TOKEN
cd mcp && npm install && npm test  # end-to-end tests
```

The tests start their own gateway on a scratch folder; they never touch `tasks/`.

## Rules for code changes

- **Keep the gateway dependency-free.** Standard library only; it must start anywhere with `node gateway.js`.
- **Never emit more than one frontmatter block.** Any code that writes a task file parses it into
  fields and body, changes only what it means to, and writes one `---` block. A file with two blocks
  silently loses its title and status on the board.
- **Writes are optimistic.** Send the `sha` you read; on `409`, re-read and reapply rather than overwrite.
- **Agent rules live in `agentRefusal` in `gateway.js`.** Renames, id changes and deletes are refused
  for every agent, including those in `PMO_AGENTS`. Keep it that way unless a human decides otherwise.
- **Bump the `?v=` query** on the script and style tags in `docs/index.html` when you change UI files,
  so browsers and the Replit deployment pick up the new version.
- **No secrets in the repo.** Tokens and passwords come from the environment. The repo is public.
