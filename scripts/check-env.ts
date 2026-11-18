/**
 * check-env.ts — checks that this machine can run the lab, one piece at a time.
 *
 * Run it with:  npm run check-env
 *
 * The app depends on several separate things, and when it does not work
 * the useful question is WHICH one is missing. A single "something is
 * wrong" teaches nothing and fixes nothing. So each check prints its own
 * PASS / FAIL / note line with what to do next.
 *
 * Checked here:
 *
 *   1. Node version — node:sqlite, which the data server uses to read
 *      the database, needs Node 24 or later.
 *   2. Settings — every value in .env (or its default) is usable: ports
 *      are ports and do not collide, the context window is a number, the
 *      Ollama URL points at this machine, the model is a local one.
 *   3. The database — data/checkpoint.db exists. It is generated, not
 *      committed, so a fresh clone does not have one until `npm run seed`.
 *
 * Ollama itself (running? model pulled? cloud models installed?) is
 * checked once the model client exists to do it.
 *
 * ---------------------------------------------------------------------------
 * Why settings are checked as well as read
 * ---------------------------------------------------------------------------
 *
 * Two settings carry the project's promise that nothing leaves the
 * machine. OLLAMA_URL pointing at another host, or MODEL naming a
 * ":cloud" model, would each quietly send customer data elsewhere — and
 * the app would still work, which is exactly why it is worth a check
 * that fails loudly.
 */

import "dotenv/config"; // reads .env and puts its values on process.env
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The project root, derived from this file rather than from cwd. */
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Defaults — kept in step with .env.example. */
const DEFAULTS = {
  PORT: "3200",
  DATA_SERVER_PORT: "3201",
  OLLAMA_URL: "http://127.0.0.1:11434",
  MODEL: "llama3.2:3b",
  NUM_CTX: "8192",
} as const;

/** The lowest Node major with node:sqlite usable unflagged, read-only. */
const MIN_NODE_MAJOR = 24;

/** Hostnames that mean "this machine". */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** A running tally, so the summary line can say what failed. */
let failures = 0;

function pass(message: string): void {
  console.log(`PASS  ${message}`);
}

function fail(message: string, ...fix: string[]): void {
  failures += 1;
  console.error(`FAIL  ${message}`);
  for (const line of fix) console.error(`      ${line}`);
}

function note(message: string, ...more: string[]): void {
  console.log(`note  ${message}`);
  for (const line of more) console.log(`      ${line}`);
}

/**
 * A setting's value, or its default when unset.
 *
 * An empty string counts as unset: `PORT=` in a .env file is almost
 * always a line someone cleared, not a request for port "".
 */
function setting(name: keyof typeof DEFAULTS): string {
  const value = process.env[name];
  return value === undefined || value === "" ? DEFAULTS[name] : value;
}

/**
 * Parses a port, or returns null if it is not one.
 *
 * Number("") is 0 and Number("abc") is NaN, so both a blank and a typo
 * land in the null branch rather than becoming a port nothing can bind.
 */
function parsePort(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : null;
}

// --- 1. Node -----------------------------------------------------------------

function checkNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    pass(`Node ${process.versions.node}`);
  } else {
    fail(
      `Node ${process.versions.node} is too old.`,
      `The data server reads the database with node:sqlite, which needs`,
      `Node ${MIN_NODE_MAJOR} or later. Install a current Node 24 release.`,
    );
  }
}

// --- 2. Settings -------------------------------------------------------------

function checkPorts(): void {
  const app = parsePort(setting("PORT"));
  const data = parsePort(setting("DATA_SERVER_PORT"));

  if (app === null) {
    fail(`PORT is "${setting("PORT")}", which is not a usable port.`,
      "Expected a whole number between 1 and 65535.");
  }
  if (data === null) {
    fail(`DATA_SERVER_PORT is "${setting("DATA_SERVER_PORT")}", which is not a usable port.`,
      "Expected a whole number between 1 and 65535.");
  }
  if (app === null || data === null) return;

  if (app === data) {
    // Only breaks when both run at once — and the error you get then
    // (EADDRINUSE) does not say which setting caused it.
    fail(`PORT and DATA_SERVER_PORT are both ${app}.`,
      "The app and the HTTP data server need different ports.");
    return;
  }
  if (app === 11434 || data === 11434) {
    fail("A port is set to 11434, which is Ollama's.",
      "Whichever starts second will fail to bind.");
    return;
  }
  pass(`PORT = ${app}, DATA_SERVER_PORT = ${data}`);
}

function checkOllamaUrl(): void {
  const raw = setting("OLLAMA_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    // new URL throws TypeError for anything unparseable; anything else is
    // a real bug and should surface.
    if (!(error instanceof TypeError)) throw error;
    fail(`OLLAMA_URL is "${raw}", which is not a URL.`,
      `Expected something like ${DEFAULTS.OLLAMA_URL}.`);
    return;
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    // The app would work — that is the danger. Every question, and the
    // customer data the tools return, would cross the network.
    fail(`OLLAMA_URL points at ${url.hostname}, not this machine.`,
      "Every prompt and every tool result would be sent there.",
      `Use ${DEFAULTS.OLLAMA_URL} to keep the data local.`);
    return;
  }
  pass(`OLLAMA_URL = ${url.origin}`);
}

function checkModel(): void {
  const model = setting("MODEL");
  // The ":cloud" suffix is how Ollama names models it runs on ollama.com
  // rather than locally (see docs/verified-facts.md). "-cloud" is checked
  // too, because older cloud model names used it as part of the tag.
  if (/[:-]cloud$/i.test(model)) {
    fail(`MODEL is "${model}", which runs on ollama.com, not here.`,
      "The app refuses cloud models: they would send customer data off",
      "the machine. Pick a local model, e.g. llama3.2:3b.");
    return;
  }
  pass(`MODEL = ${model}`);
}

function checkContext(): void {
  const raw = setting("NUM_CTX");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 2048) {
    fail(`NUM_CTX is "${raw}".`,
      "Expected a whole number of tokens, at least 2048. Six tool",
      "definitions and the system prompt alone use a good part of that.");
    return;
  }
  if (parsed < 8192) {
    note(`NUM_CTX = ${parsed} is small.`,
      "Ollama trims long conversations from the front, which removes the",
      "system prompt first. Expect the guardrails to weaken after a few turns.");
    return;
  }
  pass(`NUM_CTX = ${parsed}`);
}

// --- 3. The database ---------------------------------------------------------

function checkDatabase(): void {
  const path = join(ROOT, "data", "checkpoint.db");
  if (existsSync(path)) {
    pass("data/checkpoint.db exists");
  } else {
    fail("data/checkpoint.db does not exist.",
      "It is generated, not committed. Run:  npm run seed");
  }
}

// --- Run ---------------------------------------------------------------------

console.log("Checking environment...\n");
checkNode();
checkPorts();
checkOllamaUrl();
checkModel();
checkContext();
checkDatabase();

if (failures === 0) {
  console.log("\nEnvironment looks good.");
} else {
  console.error(`\n${failures} check(s) failed.`);
  // A non-zero exit code is how a shell script or CI job notices.
  process.exitCode = 1;
}
