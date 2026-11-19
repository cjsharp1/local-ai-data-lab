# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A teaching app for local, locked-down AI over private data: a small model
running through Ollama, a SQLite customer database it can reach only
through eight read-only MCP tools, and a UI that shows every step. People
read this code to learn from it, which changes what "good" means here:
**the explanation is part of the deliverable, not decoration on top of
it.** A terse, clever rewrite makes this codebase worse even when the
code is objectively better.

It is standalone. Do not mention or link other projects in code,
comments or docs.

## The comment convention

Every `.ts` file opens with a block comment that names the file and
explains what it does, why it exists and what it teaches. Enforced by:

```bash
npm run audit-comments
```

It checks a header exists, names its file and is long enough to be an
explanation. It cannot judge quality — that part is on you.

Inline comments explain **why**, and especially the trap. Many comments
here record a bug that was hit (the numbered-parameter failure, the 58
false "dropped history" alarms, the model reading "not included" as
"none exist"). Do not delete one because the code looks obvious — the
comment is why it looks obvious. When behaviour changes, update the
comment in the same edit.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | App on 3200 (compiles the browser half first) |
| `npm run typecheck` | **Both** halves |
| `npm run audit-comments` | Every file has a header |
| `npm run try-tools` | Every tool over MCP, no model — run after any tool change |
| `npm run ask -- "…"` | One turn through the real agent, in the terminal |
| `npm run eval` | The model eval (long: ~40 min for two models) |
| `npm run seed` | Rebuild the database (stop the app first on Windows) |
| `npm run check-env` | Each dependency checked separately |
| `npm run data:browse` / `data-server:http` | Data browser on 3202 / MCP over HTTP on 3201 |

Before finishing any change: `npm run typecheck`, `npm run
audit-comments`, and `npm run try-tools` if a tool changed.

## Architecture

- `data-server/` — the MCP server, a **separate process**. The only code
  that opens the database. Tools follow `types.ts` → `definitions/` →
  `registry.ts`, in that dependency order (`types.ts` imports nothing; a
  registry-held interface makes a cycle once there are two tools).
- `server/` — the app. `agent/loop.ts` is the tool loop; it takes a
  `Logger` and an `emit` function, never an HTTP response, so `ask.ts`
  and `eval.ts` run the same code. `mcp/client.ts` spawns the data server
  (`tsx` in dev, `dist/` after build — it picks by its own extension).
- `public/` — the browser half, compiled in place. Client tsconfig keeps
  `"types": []`; the browser imports only types from `shared/`.
- `data-browser/` — a read-only table browser for people, its own server.
  It must stay separate from the app.
- `shared/` — types both halves agree on.

## Invariants — changing one is a decision, not a refactor

- **No API key, ever, and no outbound calls.** Local models only; cloud
  models (`:cloud`) are refused by name in `ollama.ts` and `index.ts`.
- **No write access and no SQL tool.** The database is opened read-only.
  A question the tools cannot answer gets a new narrow tool, or a new
  entry in `sales_report`'s / `customer_segment`'s vocabulary — never a
  tool that runs model-written SQL.
- **SQL identifiers come from code, values are bound.** Flexible tools
  build SQL from maps of fragments chosen by Zod enum. Never interpolate
  anything a caller sent.
- **The model reads tool TEXT, never `structuredContent`.** The rep screen
  gets the structured result. `customer_segment` relies on this to keep
  contact details from the model.
- **The rep screen renders tool results, never model text.**
- **`textContent`, never `innerHTML`**, for anything from the model, a
  tool or the database — the seed contains a deliberate prompt injection.
- **Every request sends `think`, `stream: false` and `num_ctx`**
  (`buildRequest` in `ollama.ts`). `think` is false unless the user turns on
  Show reasoning, and the server only allows it for models whose
  capabilities include "thinking" — always send it explicitly, because
  leaving it out lets a thinking model think.
- **Layer 2 is a separate request.** `format` alongside `tools` stops
  tool calling entirely; do not "optimise" them into one request.
- **Empty searches are results, not errors** — the answer gate needs a
  successful lookup behind "Avery Okafor has no orders".
- **Every server binds 127.0.0.1 and checks Host and Origin.**
- **`stdio.ts` never writes to stdout** — stdout is the protocol there.
- **The MCP serving entry points take a factory**, not a server instance.
- **Guardrails are switchable, on by default, and say how strong they
  are.** Never describe a prompt-based layer as a guarantee.
- **Never hide a model failure.** Retries are logged; heuristics are
  labelled as heuristics.

## Things that bite

Verified facts live in `docs/verified-facts.md`; read it before trusting
a remembered API shape. The short list:

- `node:sqlite` does not bind `?1` positionally — use `:named` params.
- `StdioClientTransport` is in `@modelcontextprotocol/client/stdio`.
- MCP logging notifications are deprecated; SQL reports travel in result
  `_meta` under `checkpoint/queries`.
- Express 5 passes a failed `listen()` to the callback — check the error.
- Chat templates differ: llama3.2 drops tool definitions after a tool
  result, so do not infer anything from a shrinking `prompt_eval_count`.
- Tool wording is prompt text: how a summary describes withheld data
  becomes how the model describes it to the user.

## Documentation to keep in sync

Changing tools, routes, scripts or counts means updating, in the same
change: `README.md` (tools, scripts, layout), `index.html` (fact strip,
tables — measure counts, do not estimate), `PLAN.md` §4/§5.3, and
`scripts/try-tools.ts` cases. `docs/model-eval.md` is generated; re-run
`npm run eval` rather than editing its numbers.

## GitHub Pages

`index.html` at the repo root is the project overview, served by Pages
from `main`. It is a complete HTML document — doctype, `<html lang>`,
`<meta charset="utf-8">` — and self-contained. Without the doctype Pages
renders in quirks mode; without the charset em-dashes become mojibake.
`docs/build-plan.html` is the plan as a historical record; leave its
contents as they were when written.

Commits: plain imperative, descriptive, no prefixes.
