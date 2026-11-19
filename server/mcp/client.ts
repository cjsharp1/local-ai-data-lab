/**
 * client.ts — the app's connection to the data server, over MCP and stdio.
 *
 * The app never opens the database. It starts the data server as a CHILD
 * PROCESS and speaks MCP to it over the child's stdin and stdout: list the
 * tools, call one, read the result. Everything the model learns about a
 * customer crosses this process boundary, through one of eight tools.
 *
 * ---------------------------------------------------------------------------
 * Which command to spawn
 * ---------------------------------------------------------------------------
 *
 * Under `npm run dev` this file runs as TypeScript through tsx; after
 * `npm run build` it runs as JavaScript from dist/. The data server has
 * to be started the same way:
 *
 *   dev     node --import tsx data-server/stdio.ts
 *   built   node dist/data-server/stdio.js
 *
 * The trick that makes this one line: this file's own extension says
 * which world we are in, and because dist/ mirrors the source tree,
 * `../../data-server/stdio` + that extension is the right file either
 * way. `process.execPath` (the running Node) rather than "node", "npx"
 * or "tsx", because spawning those by name on Windows needs a shell.
 *
 * ---------------------------------------------------------------------------
 * The data server's stderr is part of the log
 * ---------------------------------------------------------------------------
 *
 * Over stdio, the child's stdout is the protocol and its stderr is its
 * only voice. A missing database, a crash, a stack trace — all arrive on
 * stderr. Each line is handed to `onStderr`, which the app turns into a
 * log row, so "the data server would not start" comes with its reason.
 *
 * ---------------------------------------------------------------------------
 * Connection lifetime
 * ---------------------------------------------------------------------------
 *
 * Connected lazily, on first use, and kept. If the child exits, the
 * client notices (`onclose`) and the next call starts a new one — so
 * running `npm run seed` while the app is up, which needs the database
 * file released, costs one failed call rather than a restart.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { QUERIES_META_KEY } from "../../shared/checkpoint.js";
import type { QueryReport } from "../../shared/types.js";
import type { McpToolDefinition } from "../agent/tool-format.js";

/** How this app identifies itself in the MCP handshake. */
const CLIENT_NAME = "local-ai-data-lab";
const CLIENT_VERSION = "1.0.0";

/** What one tool call produced, unpacked from the MCP result. */
export interface ToolCallOutcome {
  /** The text content — the short summary the model reads. */
  text: string;
  isError: boolean;
  /** The structured result for the rep screen; null on error. */
  data: unknown;
  /** The SQL the data server reported in `_meta`. */
  queries: QueryReport[];
  elapsedMs: number;
}

/** The data server could not be started or reached. */
export class DataServerUnavailableError extends Error {
  override name = "DataServerUnavailableError";
}

/** The command that starts the data server, matching how THIS file is running. */
export function dataServerCommand(): { command: string; args: string[] } {
  const built = import.meta.url.endsWith(".js");
  const entry = fileURLToPath(new URL(`../../data-server/stdio.${built ? "js" : "ts"}`, import.meta.url));
  return {
    command: process.execPath,
    args: built ? [entry] : ["--import", "tsx", entry],
  };
}

/** The first text block of an MCP result. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
      return String((block as { text?: unknown }).text ?? "");
    }
  }
  return "";
}

export class DataServerClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private toolList: McpToolDefinition[] | undefined;
  /** The last thing the data server said on stderr — the likeliest reason for a failure. */
  private lastStderr = "";

  constructor(private readonly onStderr: (line: string) => void = () => {}) {}

  /** Whether a live connection exists right now. */
  get connected(): boolean {
    return this.client !== undefined;
  }

  /** Connects if needed. Concurrent callers share one attempt. */
  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const { command, args } = dataServerCommand();
    const transport = new StdioClientTransport({ command, args, stderr: "pipe" });

    (transport.stderr as Readable | null)?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.lastStderr = line.trim();
        this.onStderr(line.trim());
      }
    });

    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    client.onclose = () => {
      // The child exited or the pipe broke. Forget it; the next call
      // starts a fresh one.
      this.client = undefined;
      this.toolList = undefined;
    };

    try {
      await client.connect(transport);
    } catch (error: unknown) {
      const reason = this.lastStderr || (error instanceof Error ? error.message : String(error));
      throw new DataServerUnavailableError(`The data server did not start: ${reason}`);
    }
    this.client = client;
    return client;
  }

  /** The data server's tools, as advertised. Cached for the connection's life. */
  async tools(): Promise<McpToolDefinition[]> {
    if (this.toolList) return this.toolList;
    const client = await this.connection();
    const { tools } = await client.listTools();
    this.toolList = tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    return this.toolList;
  }

  /** Calls one tool and unpacks the result. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const client = await this.connection();
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    const isError = result.isError === true;
    const meta = (result._meta ?? {}) as Record<string, unknown>;

    return {
      text: textOf(result.content),
      isError,
      data: isError ? null : (result.structuredContent ?? null),
      queries: Array.isArray(meta[QUERIES_META_KEY]) ? (meta[QUERIES_META_KEY] as QueryReport[]) : [],
      elapsedMs: Date.now() - started,
    };
  }

  /** Stops the data server. */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}
