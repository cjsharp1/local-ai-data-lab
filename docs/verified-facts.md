# Verified facts (Phase 0)

Checked on 2026-11-18 against installed packages, a live Node run and
current Ollama docs — not memory. Where a fact needs a running Ollama, it
is marked **pending (Phase 4)** and must be confirmed before the code
that depends on it is written.

Machine: Windows 11, Node 24.4.1. Ollama: **not installed yet**.

---

## Packages (npm, today)

| Package | Version |
|---|---|
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/client` | 2.4.0 |
| `@modelcontextprotocol/node` | 2.1.2 |
| `express` | 5.3.0 |
| `zod` | 4.6.7 |
| `dotenv` | 18.0.10 |
| `tsx` | 4.23.15 |
| `typescript` | 7.0.2 |
| `@types/node` (24 line) | 24.19.2 |
| `@types/express` | 5.0.6 |

Use `@types/node@^24` to match the Node target, not the latest major.

---

## MCP SDK 2.4 (read from the installed `.d.mts` files)

| Fact | Finding |
|---|---|
| Structured results | **Confirmed.** `registerTool(name, { inputSchema, outputSchema, … }, handler)` with Zod `z.object(...)`; the handler returns `structuredContent`. The raw-shape form is deprecated. |
| Text alongside structured | If `structuredContent` is a non-object and the handler wrote no `text` block, the SDK appends `JSON.stringify(value)` as text. **Return an object and always write our own short text block** — that keeps the model's summary short (§5.3). |
| Logging notifications | **Deprecated** as of protocol revision 2026-07-28 (SEP-2577): `sendLoggingMessage` and the `logging` capability still work for a ≥12-month window, but the SDK says to migrate to stderr logging or OpenTelemetry. |
| Result `_meta` | `ResultMetaObject` is a loose record — custom keys are allowed. |
| Serving | `serveStdio(factory)` and `createMcpHandler(factory)` both take a factory. `responseMode: 'auto' \| 'sse' \| 'json'`, default `auto`; `json` drops every message except the terminal response. |

**Decision:** SQL reports travel in the tool result's `_meta`
(key `checkpoint/queries`: an array of `{ sql, params, rows, ms }`), not in
logging notifications. The fallback in the plan becomes the design: it
avoids a deprecated API, works identically over stdio and HTTP, and does
not depend on `responseMode`. `responseMode: "auto"` stays as the HTTP
default anyway.

---

## `node:sqlite` on Node 24.4.1 (run, not read)

| Fact | Finding |
|---|---|
| Flag needed | **No.** `import { DatabaseSync } from 'node:sqlite'` works unflagged. |
| Read-only | `new DatabaseSync(path, { readOnly: true })` — reads work; a write throws `Error` with `code: 'ERR_SQLITE_ERROR'`, message "attempt to write a readonly database". |
| Parameters | `prepare(sql).all(...params)` with `?` placeholders works; rows are null-prototype objects. |
| Warning | Prints `ExperimentalWarning: SQLite is an experimental feature…` **to stderr**. Harmless for the stdio server (stdout is the protocol); explain it in `db.ts`. |
| Error class | Writes fail with a plain `Error` carrying `code` — match on `code`, not message text. |

`engines`: `"node": ">=24"`. `node:sqlite` has been unflagged with
`readOnly` since before 24.0, so any 24.x works. Note: 24.4.1 predates
Node 24's LTS promotion; upgrading within 24 is recommended but not
required.

---

## Ollama (docs — docs.ollama.com and `docs/api.md`)

| Fact | Finding | Status |
|---|---|---|
| Chat with tools | `POST /api/chat` with `tools` (JSON Schema function definitions). Response `message.tool_calls[]` = `{ function: { name, arguments } }`, **`arguments` is an object**, no call `id` in the examples. | Docs |
| Tool result messages | `{ role: "tool", content: string, tool_name?: string }` — `tool_name` is optional but documented; **always send it** (small models need the hint, and it's what pairs results with calls when there is no id). | Docs |
| Streaming + tools | Documented as supported (streamed chunk carries `tool_calls`). | Docs; v1 uses `stream: false` |
| `format` | `"json"` or a JSON Schema. | Docs |
| `format` + `tools` together | **Not documented.** | **pending (Phase 4)** — test per candidate model |
| `think` | Boolean or `low`/`medium`/`high`/`max`. `think: false` turns it off. | Docs; confirm per model |
| Options | `options.temperature`, `options.seed`, `options.num_ctx` per request. | Docs |
| Default context | **4096 tokens** by default; newer builds scale by VRAM (<24 GiB → 4k, 24–48 → 32k, ≥48 → 256k). `OLLAMA_CONTEXT_LENGTH` overrides server-wide; `ollama ps` shows the real `CONTEXT`. | Docs |
| Truncation | **Not documented** for chat. | **pending (Phase 4)** — confirm empirically (send an over-long prompt, compare `prompt_eval_count`, check server log) |
| Timings | `load_duration`, `prompt_eval_duration`, `eval_duration`, `total_duration` in **nanoseconds**; `prompt_eval_count`, `eval_count` in tokens. tok/s = `eval_count / eval_duration × 1e9`. | Docs |
| `/api/tags` | `models[]` with `name`, `model`, `size`, `digest`, `details{ family, parameter_size, quantization_level, … }`. | Docs |
| Cloud models | Named with a **`:cloud` suffix** (e.g. `gemma4:cloud`), runnable through the local API. Docs don't say how they appear in `/api/tags` or whether a remote field marks them. | **pending (Phase 4)** — inspect a real `/api/tags`; filter on `:cloud`/`-cloud` name suffix **and** any `remote_*` field |
| Local-only mode | `OLLAMA_NO_CLOUD=1`, or `"disable_ollama_cloud": true` in `~/.ollama/server.json`, disables cloud models and web search. | Docs — **recommend in README**; `check-env` reports it |
| Bind address | `127.0.0.1:11434` by default (`OLLAMA_HOST` changes it). | Docs |
| Ollama's own network use | Auto-updates on Windows/macOS; pulls models from the internet. "We don't see your prompts or data when you run locally." | Docs — supports the §1 wording "Ollama itself is a separate program" |
| Docs location | API docs are moving to docs.ollama.com/api. | Docs |

---

## Corrections made to PLAN.md

- §2, §5.3, §6.5, §6.7, §8: SQL reporting uses result `_meta`, not MCP
  logging (deprecated).
- §2, Phase 1: `engines` `>=24`; `@types/node@^24`.
- §1, §6.1, README: recommend `OLLAMA_NO_CLOUD=1`; `check-env` reports
  whether it is set. App-side filtering stays, because the setting is
  outside this repo's control.
- §6.2: default context is 4096 on most laptops — setting `num_ctx`
  explicitly is required, not optional.
