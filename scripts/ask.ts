/**
 * ask.ts — one question through the whole agent, in the terminal. No UI.
 *
 * Run it with:
 *
 *   npm run ask -- "What has dana.whitlock@example.com ordered?"
 *   npm run ask -- "Write a poem about trail shoes" --no-prompt --no-format --no-gate
 *   npm run ask -- "Sam Rivera's last order" --model qwen3.5:4b --verbose
 *
 * Flags:
 *
 *   --no-prompt   layer 1 off: a minimal system prompt instead of the scoped one
 *   --no-format   layer 2 off: free-text replies
 *   --no-gate     layer 3 off: warn instead of block
 *   --all-off     all three
 *   --model NAME  a different local model
 *   --verbose     print each log row's full detail (requests, responses, SQL)
 *
 * This runs exactly the code the web app runs — `runTurn` from
 * server/agent/loop.ts, the same MCP client, the same data server — with
 * a logger that prints instead of streaming to a browser. That makes it
 * the fastest way to debug the loop: no page to reload, every row in
 * order, the reply at the end.
 *
 * Read the output top to bottom and you can follow the turn: the model
 * request, the tool it chose, the SQL behind that tool, what came back,
 * the next request, and which guardrail (if any) stepped in.
 */

import "dotenv/config";
import type { GuardrailSettings, LogEvent, StreamEvent } from "../shared/types.js";
import { Logger } from "../server/logger.js";
import { DataServerClient } from "../server/mcp/client.js";
import { ollamaConfig } from "../server/model/ollama.js";
import { runTurn } from "../server/agent/loop.js";
import { DEFAULT_GUARDRAILS } from "../server/guardrails/settings.js";

// --- Arguments ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const modelIndex = argv.indexOf("--model");
const model = modelIndex >= 0 ? argv[modelIndex + 1] ?? ollamaConfig().model : ollamaConfig().model;
const words = argv.filter((a, i) => !a.startsWith("--") && !(modelIndex >= 0 && i === modelIndex + 1));
const question = words.join(" ");

if (!question) {
  console.error('Usage: npm run ask -- "your question" [--no-prompt] [--no-format] [--no-gate] [--all-off] [--model NAME] [--verbose]');
  process.exit(1);
}

const allOff = flag("--all-off");
const guardrails: GuardrailSettings = {
  scopedPrompt: !(allOff || flag("--no-prompt")) && DEFAULT_GUARDRAILS.scopedPrompt,
  structuredReplies: !(allOff || flag("--no-format")) && DEFAULT_GUARDRAILS.structuredReplies,
  answerGate: !(allOff || flag("--no-gate")) && DEFAULT_GUARDRAILS.answerGate,
};
const verbose = flag("--verbose");

// --- Printing ----------------------------------------------------------------------

/** Arrows for direction, so a request and its response read as a pair. */
const ARROW: Record<string, string> = { out: "→", in: "←", call: "⇢", back: "⇠", none: " " };

function printRow(event: LogEvent): void {
  const iter = event.iteration !== undefined ? `#${event.iteration}` : "  ";
  const arrow = ARROW[event.direction ?? "none"] ?? " ";
  console.log(`${iter} ${event.level.padEnd(5)} ${arrow} ${event.label}`);
  if (event.because && (event.level === "warn" || event.level === "error")) {
    console.log(`              because ${event.because}`);
  }
  if (verbose && event.detail !== undefined) {
    console.log(JSON.stringify(event.detail, null, 2).split("\n").map((l) => `              ${l}`).join("\n"));
  }
}

function onEvent(event: StreamEvent): void {
  if (event.type === "screen") {
    const s = event.screen;
    console.log(`   screen  ▣ rep screen shows ${s.tool}${s.isError ? " (error)" : ""} — ${Object.keys(
      (s.data ?? {}) as object).join(", ") || "no data"}`);
  }
}

// --- Run ---------------------------------------------------------------------------

const logger = new Logger(printRow);
const dataServer = new DataServerClient((line) => {
  // The ExperimentalWarning from node:sqlite is expected; keep it out of the way.
  if (line.includes("ExperimentalWarning") || line.includes("--trace-warnings")) return;
  console.log(`   data server: ${line}`);
});

console.log(`\nQ: ${question}\n`);

const result = await runTurn(
  { message: question, history: [], model, guardrails },
  { logger, emit: onEvent, tools: dataServer },
);

await dataServer.close();

console.log("");
if (result.done) {
  const d = result.done;
  console.log(`A [${d.kind}]: ${d.text}`);
  console.log(`\n   ${d.requests} model request${d.requests === 1 ? "" : "s"} · ${(d.elapsedMs / 1000).toFixed(1)} s · ` +
    `${d.tokensPerSecond ?? "?"} tok/s · cost $0 — ran on this machine`);
} else {
  console.log(`Failed: ${result.error}`);
  process.exitCode = 1;
}
