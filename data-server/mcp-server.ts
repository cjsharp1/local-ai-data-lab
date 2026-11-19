/**
 * mcp-server.ts — builds the Checkpoint data MCP server.
 *
 * Exports `createServer()`, a FACTORY that returns a new `McpServer` with
 * the eight tools registered. Both entry points hand this function to the
 * SDK — stdio.ts to `serveStdio`, http.ts to `createMcpHandler`.
 *
 * ---------------------------------------------------------------------------
 * Why a factory, not a server
 * ---------------------------------------------------------------------------
 *
 * The SDK's serving functions call the factory more than once: for a
 * discovery probe whose result is thrown away, and over HTTP once per
 * request. Passing one shared instance compiles, serves the first client,
 * and then breaks during version negotiation. Each call here builds a
 * fresh server; the database connection underneath is shared, which is
 * safe because nothing writes to it.
 *
 * ---------------------------------------------------------------------------
 * What each tool call returns
 * ---------------------------------------------------------------------------
 *
 *   content            one text block — the short summary for the model
 *   structuredContent  the full result, matching the tool's outputSchema,
 *                      for the rep screen
 *   _meta              { "checkpoint/queries": [...] } — every SQL
 *                      statement the call ran, with parameters, row count
 *                      and timing, for the activity log
 *
 * The SQL travels in `_meta` rather than in MCP logging notifications:
 * logging is deprecated as of the 2026-07-28 protocol revision, and
 * `_meta` arrives identically over stdio and HTTP, attached to the very
 * result it explains.
 *
 * ---------------------------------------------------------------------------
 * Two kinds of failure
 * ---------------------------------------------------------------------------
 *
 * A `ToolError` ("No order CP-99999…") is for the model: it comes back as
 * a result with `isError: true` and the message as its text, so the model
 * can correct itself. Anything else that throws is a bug in this server —
 * it is still returned as an error result (so the client is not left
 * hanging) but its message says so, and the details go to stderr.
 *
 * Bad ARGUMENTS never reach a tool at all: the SDK validates them against
 * the tool's Zod schema first and returns an "Input validation error"
 * result itself. The app relays that verdict to the model unchanged
 * rather than validating a second time.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { QUERIES_META_KEY } from "../shared/checkpoint.js";
import { createRecorder } from "./db.js";
import { TOOLS, ToolError, assertUniqueToolNames, type AnyDataTool } from "./tools/registry.js";

/** What this server calls itself in the MCP handshake. */
export const SERVER_NAME = "checkpoint-data";
export const SERVER_VERSION = "1.0.0";

// At import, not per request: a duplicate name is a programming error,
// and the earlier it fails the less confusing it is.
assertUniqueToolNames();

function registerOneTool(server: McpServer, tool: AnyDataTool): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    },
    async (args) => {
      // A fresh recorder per call, so this result reports only its own SQL.
      const { runner, queries } = createRecorder();
      const _meta = { [QUERIES_META_KEY]: queries };

      try {
        // `args as never` pairs with the widening in tools/types.ts. Safe
        // here and only here: the SDK has already validated these
        // arguments against the same schema that typed the tool's input.
        const { data, summary } = tool.run(args as never, runner);
        return {
          content: [{ type: "text", text: summary }],
          // Every tool's data is an object (checked by its outputSchema),
          // which is the shape MCP requires of structuredContent.
          structuredContent: data as Record<string, unknown>,
          _meta,
        };
      } catch (error: unknown) {
        if (error instanceof ToolError) {
          return { content: [{ type: "text", text: error.message }], isError: true, _meta };
        }
        // stderr, never stdout — over stdio, stdout is the protocol.
        console.error(`[${SERVER_NAME}] ${tool.name} failed:`, error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Internal error in ${tool.name} (a bug in the data server, not a mistake in the call): ${message}` }],
          isError: true,
          _meta,
        };
      }
    },
  );
}

/** The factory. A new server every call — see the header for why. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of TOOLS) registerOneTool(server, tool);
  return server;
}
