/**
 * http.ts — serves the data MCP server over Streamable HTTP, on port 3201.
 *
 * Run it with:  npm run data-server:http
 *
 * The app does not need this — it talks to the data server over stdio.
 * This entry point exists so other MCP clients can connect to the same
 * six tools without starting the app: MCP Inspector, for instance,
 * pointed at http://127.0.0.1:3201/mcp. Same factory, same database, same
 * read-only guarantees; only the transport differs.
 *
 * ---------------------------------------------------------------------------
 * Four rules, each one load-bearing
 * ---------------------------------------------------------------------------
 *
 * 1. Bound to 127.0.0.1. Listening on every interface would put the
 *    customer database on the local network.
 *
 * 2. Localhost Host and Origin checks on every request. Binding to
 *    127.0.0.1 is not enough on its own: a web page you visit can make
 *    your browser POST to a local port, and a DNS name can be made to
 *    resolve to 127.0.0.1. Without these checks, any site could call
 *    find_customers through your browser and read the results. The SDK's
 *    own validators are used, because a hand-rolled one is easy to get
 *    subtly wrong (IPv6 brackets, port suffixes, a missing header).
 *
 * 3. `/mcp` is mounted BEFORE any body parser. The MCP adapter reads the
 *    raw request body itself; a parser like express.json() that ran first
 *    would drain the stream and leave it nothing. This server has no JSON
 *    routes, so there is no parser at all — but if one is ever added, it
 *    goes after /mcp.
 *
 * 4. `responseMode: "auto"`, not "json". "json" drops every message except
 *    the final response. These tools send nothing mid-call today (their
 *    SQL reports ride in the result's _meta, so they survive either way),
 *    but "auto" is the mode that keeps the protocol whole if one ever does.
 *
 * Stateless: `createMcpHandler` calls the factory for every request, so
 * there are no sessions to keep. The server holds nothing between calls
 * except the read-only database connection.
 *
 * Unlike stdio.ts, stdout here is just a terminal, so console.log is fine.
 */

import "dotenv/config"; // read DATA_SERVER_PORT from .env, if there is one
import express from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { DatabaseMissingError, openDatabase } from "./db.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./mcp-server.js";

const PORT = Number(process.env.DATA_SERVER_PORT || 3201);
const HOST = "127.0.0.1";

// Fail at startup, with the fix, if the database has not been seeded.
try {
  openDatabase();
} catch (error: unknown) {
  if (error instanceof DatabaseMissingError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const mcpHandler = createMcpHandler(createServer, {
  responseMode: "auto",
  onerror(error) {
    console.error(`[${SERVER_NAME}] handler error: ${error.message}`);
  },
});

const mcpNodeHandler = toNodeHandler(mcpHandler, {
  onerror(error) {
    console.error(`[${SERVER_NAME}] adapter error: ${error.message}`);
  },
});

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const app = express();

/**
 * The MCP endpoint. `app.all`, not `app.post`: Streamable HTTP also uses
 * GET (a standalone event stream) and DELETE (ending a session), and the
 * handler needs to see those to answer them correctly.
 */
app.all("/mcp", (req, res) => {
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;

  const started = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} /mcp → ${res.statusCode} (${Date.now() - started} ms)`);
  });

  void mcpNodeHandler(req, res);
});

/** A plain answer for anyone who opens the port in a browser. */
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `${SERVER_NAME} ${SERVER_VERSION}\n\n` +
      `This is an MCP server. Point an MCP client at http://${HOST}:${PORT}/mcp\n` +
      "There is nothing to see in a browser.\n",
  );
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVER_NAME} ${SERVER_VERSION} — MCP over HTTP at http://${HOST}:${PORT}/mcp`);
  console.log("Database opened read-only. Localhost only.");
});
