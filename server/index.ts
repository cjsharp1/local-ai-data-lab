/**
 * index.ts — the app: a local web server for the chat, log and rep screen.
 *
 * Run it with:  npm run dev    then open http://127.0.0.1:3200
 *
 * Serves the browser UI from public/ and five routes:
 *
 *   GET  /api/health        model server, model, data server — separately
 *   GET  /api/models        installed LOCAL models, for the picker
 *   GET  /api/tools         the six tools exactly as the model sees them
 *   POST /api/tools/:name   call one tool directly — no model involved
 *   POST /api/chat          one turn, streamed back as Server-Sent Events
 *
 * On first use it starts the data server as a child process (see
 * mcp/client.ts) and talks to it over MCP. It never opens the database
 * itself.
 *
 * ---------------------------------------------------------------------------
 * Why a chat turn is streamed
 * ---------------------------------------------------------------------------
 *
 * A turn takes seconds to tens of seconds on a small local model, and a
 * lot happens inside it: model requests, tool calls, SQL, guardrail
 * decisions. Streaming each event as it happens is what makes the
 * activity log and the rep screen move WHILE the model works, instead of
 * everything appearing at once at the end. SSE rather than a WebSocket:
 * the data only flows one way, and SSE is plain HTTP.
 *
 * The browser POSTs (it has a body to send), so it cannot use the
 * EventSource API, which only does GET. It reads the response stream
 * with fetch instead — see public/app.ts.
 *
 * ---------------------------------------------------------------------------
 * Guardrail settings travel with each request
 * ---------------------------------------------------------------------------
 *
 * Not stored on the server. The transcript then records exactly which
 * layers were on for each turn, and two browser tabs cannot change each
 * other's settings.
 *
 * ---------------------------------------------------------------------------
 * Security: localhost only, and checked
 * ---------------------------------------------------------------------------
 *
 * The routes return customer data, so the server binds to 127.0.0.1 AND
 * checks every /api request's Host and Origin headers. Binding alone is
 * not enough: any web page you visit can make your browser send requests
 * to a local port, and a DNS name can be pointed at 127.0.0.1. The SDK's
 * localhost validators reject both. There is no authentication; this is a
 * teaching tool for one person's machine, not a service.
 */

import "dotenv/config"; // load .env before anything reads process.env
import express from "express";
import { z } from "zod";
import { localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/node";
import type {
  HealthReport, LogEvent, ModelsResponseBody, StreamEvent, ToolCallResponseBody, ToolsResponseBody,
} from "../shared/types.js";
import { Logger, truncate } from "./logger.js";
import { DataServerClient, DataServerUnavailableError } from "./mcp/client.js";
import {
  OllamaUnreachableError, isRemoteModel, listModels, ollamaConfig, ollamaVersion,
} from "./model/ollama.js";
import { runTurn } from "./agent/loop.js";
import { toOllamaTool } from "./agent/tool-format.js";
import { parseGuardrails } from "./guardrails/settings.js";

const PORT = Number(process.env.PORT || 3200);
const HOST = "127.0.0.1";

// --- The data server ----------------------------------------------------------------

/**
 * The data server's stderr, kept briefly so the health check can say WHY
 * it is down ("No database at …  Run: npm run seed"). The node:sqlite
 * ExperimentalWarning is expected on every start and is left out.
 */
let lastDataServerMessage = "";
const dataServer = new DataServerClient((line) => {
  if (line.includes("ExperimentalWarning") || line.includes("--trace-warnings")) return;
  lastDataServerMessage = line;
  // stdout is just a terminal here — unlike in the data server itself.
  console.log(`[data server] ${line}`);
});

// --- App -----------------------------------------------------------------------------

const app = express();
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

// Every /api route: localhost Host and Origin only. See the header.
app.use("/api", (req, res, next) => {
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// --- GET /api/health ---------------------------------------------------------------

/**
 * Three checks, reported separately. "Ollama is not running" and "Ollama
 * is running but the model is not pulled" need different fixes, and a
 * single red light would hide which one you have.
 */
app.get("/api/health", async (_req, res) => {
  const { model } = ollamaConfig();
  const report: HealthReport = {
    modelServer: { ok: false, detail: "" },
    model: { ok: false, detail: "" },
    dataServer: { ok: false, detail: "" },
  };

  try {
    report.modelServer = { ok: true, detail: `Ollama ${await ollamaVersion()}` };
    const models = await listModels();
    const wanted = model.includes(":") ? model : `${model}:latest`;
    const found = models.find((m) => m.name === wanted);
    report.model = !found
      ? { ok: false, detail: `${model} is not installed. Run: ollama pull ${model}` }
      : !found.supportsTools
        ? { ok: false, detail: `${model} cannot call tools.` }
        : { ok: true, detail: `${model} · ${found.parameterSize} · ${found.quantization}` };
  } catch (error: unknown) {
    if (!(error instanceof OllamaUnreachableError)) throw error;
    report.modelServer = { ok: false, detail: "Ollama is not running. Start the Ollama app." };
    report.model = { ok: false, detail: "Unknown until Ollama is running." };
  }

  try {
    const tools = await dataServer.tools();
    report.dataServer = { ok: true, detail: `${tools.length} read-only tools over MCP (stdio)` };
  } catch (error: unknown) {
    if (!(error instanceof DataServerUnavailableError)) throw error;
    report.dataServer = { ok: false, detail: lastDataServerMessage || error.message };
  }

  res.json(report);
});

// --- GET /api/models ---------------------------------------------------------------

app.get("/api/models", async (_req, res) => {
  const { model, numCtx } = ollamaConfig();
  try {
    const body: ModelsResponseBody = { defaultModel: model, numCtx, models: await listModels() };
    res.json(body);
  } catch (error: unknown) {
    if (!(error instanceof OllamaUnreachableError)) throw error;
    const body: ModelsResponseBody = { defaultModel: model, numCtx, models: [] };
    res.json(body);
  }
});

// --- GET /api/tools ----------------------------------------------------------------

app.get("/api/tools", async (_req, res) => {
  try {
    const body: ToolsResponseBody = { tools: (await dataServer.tools()).map(toOllamaTool) };
    res.json(body);
  } catch (error: unknown) {
    if (!(error instanceof DataServerUnavailableError)) throw error;
    res.status(503).json({ error: error.message });
  }
});

// --- POST /api/tools/:name ---------------------------------------------------------

/**
 * Calls one tool with no model in the loop — the rep screen's
 * click-through. Clicking an order number runs get_order exactly as the
 * model would, and the log rows say `actor: user`.
 *
 * The point it makes: the tools are just an API. The model is one caller
 * among several; a person clicking is another. The data server cannot
 * tell them apart and does not need to.
 *
 * Only names in the data server's own tool list are accepted, and the
 * data server still validates the arguments.
 */
app.post("/api/tools/:name", async (req, res) => {
  const name = req.params.name;
  const args = (typeof req.body?.args === "object" && req.body.args !== null ? req.body.args : {}) as Record<string, unknown>;

  try {
    const known = (await dataServer.tools()).some((t) => t.name === name);
    if (!known) {
      res.status(404).json({ error: `No such tool: ${name}` });
      return;
    }

    const rows: LogEvent[] = [];
    const logger = new Logger((event) => rows.push(event));
    logger.tool(`call ${name}(${truncate(JSON.stringify(args), 100)})`, args, {
      direction: "call", actor: "user", because: "you clicked it on the rep screen — no model involved",
    });
    const outcome = await dataServer.call(name, args);
    for (const q of outcome.queries) {
      logger.data(`SQL ${truncate(q.sql, 80)} → ${q.rows} row${q.rows === 1 ? "" : "s"}, ${q.ms} ms`, q);
    }
    logger.tool(`${name} → ${outcome.isError ? "error: " : ""}${truncate(outcome.text, 100)}`,
      { text: outcome.text, isError: outcome.isError, data: outcome.data },
      { direction: "back", actor: "tool" });

    const body: ToolCallResponseBody = {
      screen: {
        tool: name, args, data: outcome.data, summary: outcome.text,
        isError: outcome.isError, calledBy: "user", at: Date.now(),
      },
      log: rows,
    };
    res.json(body);
  } catch (error: unknown) {
    if (!(error instanceof DataServerUnavailableError)) throw error;
    res.status(503).json({ error: error.message });
  }
});

// --- POST /api/chat ----------------------------------------------------------------

const chatBody = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).max(50).default([]),
  model: z.string().trim().min(1).optional(),
  guardrails: z.unknown().optional(),
});

app.post("/api/chat", async (req, res) => {
  const parsed = chatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const body = parsed.data;
  const model = body.model ?? ollamaConfig().model;

  // Refused here as well as in the loop, so a cloud model never even
  // opens a stream. Belt and braces: this is the promise the app makes.
  if (isRemoteModel(model)) {
    res.status(400).json({ error: `${model} is a cloud model. This app only uses local models.` });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: StreamEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // If the browser goes away mid-turn, stop asking the model for things
  // nobody will read. `close` fires on the response when the client
  // disconnects before we finish.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const logger = new Logger((event) => send({ type: "log", event }));
  try {
    await runTurn(
      { message: body.message, history: body.history, model, guardrails: parseGuardrails(body.guardrails) },
      { logger, emit: send, tools: dataServer },
      { signal: abort.signal },
    );
  } finally {
    res.end();
  }
});

// --- Start -------------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  const { model, numCtx, url } = ollamaConfig();
  console.log(`Local AI Data Lab — http://${HOST}:${PORT}`);
  console.log(`Model ${model} via Ollama at ${url} · context ${numCtx} tokens · no API key, nothing leaves this machine`);
});

// Stop the data server child with us, so a restart (tsx watch) does not
// leave orphaned processes holding the database file open.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void dataServer.close().finally(() => {
      server.close();
      process.exit(0);
    });
  });
}
