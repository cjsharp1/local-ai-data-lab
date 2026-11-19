/**
 * server.ts — a read-only browser for the whole database, for PEOPLE.
 *
 * Run it with:  npm run data:browse    then open http://127.0.0.1:3202
 *
 * Every table, every row, sortable and searchable, with each table's
 * commented definition from data/schema.sql alongside. No model, no
 * prompt, no tools — just the data as it is stored.
 *
 * ---------------------------------------------------------------------------
 * Why it is a separate server, not a page in the app
 * ---------------------------------------------------------------------------
 *
 * The app's central rule is that it reaches the data ONLY through the
 * data server's six narrow tools — it never opens the database itself.
 * A "show me everything" page inside the app would break that rule, and
 * blur the line the whole lab is about: what the model can reach versus
 * what exists.
 *
 * So this runs on its own port, as its own process, and the app neither
 * knows nor cares that it exists. Seeing the two side by side is the
 * point: here is all of customers.email, every row at once; the model can
 * get at most twenty rows of it at a time, and only by searching for a
 * name it already has.
 *
 * ---------------------------------------------------------------------------
 * Still read-only, still parameterised, still localhost
 * ---------------------------------------------------------------------------
 *
 * It opens the database through data-server/db.ts — the same read-only
 * connection, so nothing here can write either. Table and column names
 * cannot be bound as SQL parameters, so they are checked against the
 * database's own catalogue (sqlite_master, PRAGMA table_info) before being
 * put into a statement; every VALUE is bound. And like every server in
 * this project it binds to 127.0.0.1 and checks Host and Origin, because
 * it serves every customer's details to whoever can reach it.
 */

import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/node";
import { DatabaseMissingError, openDatabase } from "../data-server/db.js";

const PORT = Number(process.env.DATA_BROWSER_PORT || 3202);
const HOST = "127.0.0.1";
const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;

let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase();
} catch (error: unknown) {
  if (error instanceof DatabaseMissingError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

// --- The catalogue: which tables and columns exist ------------------------------------

interface Column { name: string; type: string; pk: boolean }
interface ForeignKey { from: string; table: string; to: string }
interface TableInfo { name: string; rows: number; columns: Column[]; foreignKeys: ForeignKey[]; schema: string }

/**
 * Each table's definition from data/schema.sql, with the comment block
 * above it — the commented copy is the teaching copy, so it is shown as
 * written rather than reconstructed from the catalogue.
 */
function schemaBlocks(): Map<string, string> {
  const path = fileURLToPath(new URL("../data/schema.sql", import.meta.url));
  const sql = readFileSync(path, "utf8");
  const blocks = new Map<string, string>();
  // A table's block runs from the "-- ----" rule before its CREATE TABLE
  // to the next such rule (which also takes in its indexes).
  const sections = sql.split(/\n(?=-- -{20,}\n-- [a-z_]+ —)/);
  for (const section of sections) {
    const match = /CREATE TABLE (\w+)/.exec(section);
    if (match?.[1]) blocks.set(match[1], section.trim());
  }
  return blocks;
}

/** Read once at startup: the database is read-only, so its shape cannot change underneath us. */
function loadCatalogue(): Map<string, TableInfo> {
  const blocks = schemaBlocks();
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  ).all() as Array<{ name: string }>;

  const catalogue = new Map<string, TableInfo>();
  for (const { name } of names) {
    // Safe to interpolate: `name` came from sqlite_master, not from a request.
    const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; type: string; pk: number }>)
      .map((c) => ({ name: c.name, type: c.type, pk: c.pk > 0 }));
    // A composite key — orders' (shipping_address_id, customer_id) →
    // addresses (id, customer_id) — lists one row per column, with `seq`
    // 0, 1, …. Only seq 0 becomes a link: following customer_id to
    // addresses.customer_id would be a strange place to land, and the
    // column's own single-column key (→ customers.id) is the useful one.
    const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ from: string; table: string; to: string | null; seq: number }>)
      .filter((f) => f.seq === 0)
      .map((f) => ({ from: f.from, table: f.table, to: f.to ?? "id" }));
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
    catalogue.set(name, { name, rows, columns, foreignKeys, schema: blocks.get(name) ?? "" });
  }
  return catalogue;
}

const catalogue = loadCatalogue();

// --- App ------------------------------------------------------------------------------

const app = express();
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
app.use((req, res, next) => {
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;
  next();
});
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

/** GET /api/tables — every table, its columns, row count and commented schema. */
app.get("/api/tables", (_req, res) => {
  res.json({ tables: [...catalogue.values()] });
});

/**
 * GET /api/tables/:name — one page of rows.
 *
 *   sort, dir      a column name (checked against the table), asc | desc
 *   q              text to find in ANY column (LIKE, bound as a parameter)
 *   col, eq        exact match on one column — used when you click a
 *                  foreign key, e.g. orders where customer_id = 77
 *   limit, offset  paging; limit capped at 500
 */
app.get("/api/tables/:name", (req, res) => {
  const table = catalogue.get(req.params.name);
  if (!table) {
    res.status(404).json({ error: `No table ${req.params.name}` });
    return;
  }
  const columnNames = new Set(table.columns.map((c) => c.name));
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  const sort = columnNames.has(str(req.query.sort)) ? str(req.query.sort) : (table.columns[0]?.name ?? "rowid");
  const dir = str(req.query.dir) === "desc" ? "DESC" : "ASC";
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where: string[] = [];
  const params: Record<string, string | number> = {};

  const q = str(req.query.q).trim();
  if (q) {
    // CAST so numbers and dates are searchable as text too.
    where.push(`(${table.columns.map((c) => `CAST(${c.name} AS TEXT) LIKE :q`).join(" OR ")})`);
    params.q = `%${q}%`;
  }
  const col = str(req.query.col);
  if (columnNames.has(col) && req.query.eq !== undefined) {
    where.push(`${col} = :eq`);
    const eq = str(req.query.eq);
    params.eq = /^-?\d+$/.test(eq) ? Number(eq) : eq;
  }

  // Identifiers come from the catalogue (checked above); values are bound.
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT *, COUNT(*) OVER () AS __total FROM ${table.name} ${whereSql} ORDER BY ${sort} ${dir} LIMIT :limit OFFSET :offset`;
  const rows = db.prepare(sql).all({ ...params, limit, offset }) as Array<Record<string, unknown>>;
  const total = Number(rows[0]?.__total ?? 0);
  for (const row of rows) delete row.__total;

  res.json({ table: table.name, total, offset, limit, sort, dir: dir.toLowerCase(), rows, sql, params: { ...params, limit, offset } });
});

app.listen(PORT, HOST, () => {
  console.log(`Data browser — http://${HOST}:${PORT}`);
  console.log("Read-only. For people: the model never sees this page — it can only use the six tools.");
});
