/**
 * types.ts — what a data tool is, and what it is allowed to touch.
 *
 * Every tool in definitions/ is a `DataTool`. This file defines that
 * shape and nothing else, and it imports nothing from this project — it
 * is the bottom of the dependency graph on purpose:
 *
 *   types.ts  ←  definitions/*.ts  ←  registry.ts  ←  mcp-server.ts
 *
 * That order is a rule, not tidiness. Put the interface in the registry
 * instead, and each definition imports the registry while the registry
 * imports each definition: a cycle. It works with one tool and throws
 * "Cannot access '…' before initialization" with two, depending on which
 * file Node happens to load first.
 *
 * ---------------------------------------------------------------------------
 * What a tool can reach
 * ---------------------------------------------------------------------------
 *
 * A tool's `run` receives its validated arguments and a `QueryRunner` —
 * and nothing else. No database handle, no file system, no network. The
 * runner can only execute a SELECT with bound parameters against a
 * database opened read-only. That narrow door is what makes "the model
 * cannot change the data" true by construction: there is no code path
 * from a tool call to a write.
 *
 * A tool returns two things:
 *
 *   data     the structured result, for the rep screen — may be large
 *   summary  a short text for the MODEL — kept small on purpose, because
 *            a small local model has a small context window
 *
 * MCP suggests that the text content repeat the structured JSON. These
 * tools deliberately do not: the model reads a few lines, the screen
 * gets the whole table. Capping what the model sees, not what the user
 * sees, is a real-world pattern for small context windows.
 */

import type { z } from "zod";

/** A value that can be bound to a placeholder. */
export type SqlValue = string | number | null;

/** Values for `:name` placeholders, keyed by name without the colon. */
export type NamedParams = Record<string, SqlValue>;

/**
 * Parameters for one statement: positional values for `?` placeholders,
 * or a single object for `:name` placeholders.
 *
 * Use named parameters whenever a value appears more than once. The
 * obvious alternative, SQLite's numbered `?1`, does NOT work positionally
 * in node:sqlite — it counts `?1` as a named parameter, so values passed
 * in order find no slot and the call fails with "column index out of
 * range". Named parameters bound from an object are the portable way.
 */
export type SqlParams = SqlValue[] | [NamedParams];

/**
 * Runs read-only SQL on a tool's behalf, and records each query.
 *
 * Implemented in db.ts. Declared here so tool files depend on this
 * interface rather than on the database module.
 */
export interface QueryRunner {
  /** Every row the statement returns. */
  all<Row>(sql: string, ...params: SqlParams): Row[];

  /** The first row, or undefined when there are none. */
  get<Row>(sql: string, ...params: SqlParams): Row | undefined;
}

/** What a successful tool run produces. */
export interface ToolOutput<TData> {
  data: TData;
  summary: string;
}

/**
 * A failure the MODEL should read and act on.
 *
 * "No customer with that email. Try find_customers." is information, not
 * a crash: it tells a small model what to do next. Throwing one of these
 * turns into an MCP result with `isError: true` and this message as its
 * text. Anything else that throws is a real bug and is reported as one.
 *
 * Matched by class (`instanceof ToolError`), never by message text.
 */
export class ToolError extends Error {
  override name = "ToolError";
}

/** One tool, as the data server registers it. */
export interface DataTool<TInput, TData> {
  /** What a client calls it by: lowercase with underscores. */
  name: string;

  /** A short human name, e.g. "Find customers". */
  title: string;

  /**
   * Written for the MODEL. Says what the tool is for and — just as
   * important for a small model — what it is NOT for, and which tool to
   * use instead. This string is prompt text, not documentation.
   */
  description: string;

  /**
   * The arguments, as a Zod object. The SDK turns it into the JSON Schema
   * that clients (and so the model) see, and validates every call against
   * it before `run` is reached. Every field carries `.describe()`, because
   * that text is all a model knows about the field.
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * The structured result's shape. Advertised to clients, and checked by
   * the SDK on every successful call — a result that does not match comes
   * back as an error, so a drifting tool fails loudly.
   */
  outputSchema: z.ZodType<TData>;

  /** Does the work. Throws `ToolError` for anything the model can fix. */
  run(input: TInput, db: QueryRunner): ToolOutput<TData>;
}

/**
 * The registry's view of a tool: input and output types erased, so tools
 * with different shapes can share one array. `defineTool` is where each
 * tool's own types are checked; after that, the SDK's validation is what
 * guarantees `run` receives what its schema describes.
 */
export type AnyDataTool = DataTool<never, unknown>;

/** Checks a tool against its own types, then widens it for the registry. */
export function defineTool<TInput, TData>(tool: DataTool<TInput, TData>): AnyDataTool {
  return tool as unknown as AnyDataTool;
}
