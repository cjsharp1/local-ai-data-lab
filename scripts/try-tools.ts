/**
 * try-tools.ts — calls every data tool over MCP, with no model involved.
 *
 * Run it with:  npm run try-tools
 *
 * Spawns the data server exactly the way the app does — as a child
 * process speaking MCP over stdio — then calls each of the six tools with
 * good arguments and bad ones, and checks what comes back. For every call
 * it prints what the MODEL would read (the text summary), what the rep
 * SCREEN would get (the structured result's top-level keys), and the SQL
 * the data server reports it ran.
 *
 * ---------------------------------------------------------------------------
 * Why test the tools without a model
 * ---------------------------------------------------------------------------
 *
 * When the full app gives a wrong answer, there are two suspects: the
 * model, and the tools. This script rules out the second. If every case
 * here passes, the data and the tools are right, and a wrong answer in
 * the chat is the model's — which is the comparison the rep screen exists
 * to make visible.
 *
 * It also shows the point the rep screen's click-through makes: the tools
 * are just an API. A model is one caller; this script is another.
 *
 * Each case says whether it expects an error result. The error paths
 * matter as much as the happy ones — "No customer with that email. Try
 * find_customers." is how a small model recovers, so it is tested too.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { QUERIES_META_KEY } from "../shared/checkpoint.js";
import type { QueryReport } from "../shared/types.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** One call, and what it should produce. */
interface Case {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  expectError: boolean;
  /** Text the summary must contain, to check more than "did not crash". */
  expectText?: string;
}

/** A date N days ago, YYYY-MM-DD — the seed's dates move with the calendar. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const CASES: Case[] = [
  // find_customers
  { label: "two customers share a name", tool: "find_customers", args: { query: "Sam Rivera" }, expectError: false, expectText: "ask the user" },
  { label: "search by phone digits", tool: "find_customers", args: { query: "555-01" }, expectError: false, expectText: "customers match" },
  { label: "no match is NOT an error", tool: "find_customers", args: { query: "Zzyzx" }, expectError: false, expectText: "No customers match" },
  { label: "query too short (schema)", tool: "find_customers", args: { query: "R" }, expectError: true, expectText: "Input validation error" },

  // get_customer
  { label: "by email", tool: "get_customer", args: { email: "dana.whitlock@example.com" }, expectError: false, expectText: "Shipping addresses (3)" },
  { label: "email in capitals", tool: "get_customer", args: { email: "Sam.Rivera@Example.com" }, expectError: false, expectText: "Sam Rivera" },
  { label: "no orders", tool: "get_customer", args: { email: "avery.okafor@example.com" }, expectError: false, expectText: "No orders" },
  { label: "neither id nor email", tool: "get_customer", args: {}, expectError: true, expectText: "either customer_id or email" },
  { label: "both id and email", tool: "get_customer", args: { customer_id: 1, email: "x@example.com" }, expectError: true, expectText: "not both" },
  { label: "empty email counts as absent", tool: "get_customer", args: { customer_id: 1, email: "" }, expectError: false },
  { label: "id sent as a STRING", tool: "get_customer", args: { customer_id: "77" }, expectError: false, expectText: "Dana Whitlock" },
  { label: "id that is not a number (schema)", tool: "get_customer", args: { customer_id: "Dana" }, expectError: true, expectText: "Input validation error" },
  { label: "unknown email", tool: "get_customer", args: { email: "nobody@example.com" }, expectError: true, expectText: "find_customers" },

  // list_orders
  { label: "by email, one call", tool: "list_orders", args: { email: "dana.whitlock@example.com" }, expectError: false, expectText: "Dana Whitlock" },
  { label: "zero orders is an answer", tool: "list_orders", args: { email: "avery.okafor@example.com" }, expectError: false, expectText: "has no orders" },
  { label: "pending orders", tool: "list_orders", args: { status: "pending" }, expectError: false, expectText: "status pending" },
  { label: "last 30 days", tool: "list_orders", args: { from_date: daysAgo(30), to_date: daysAgo(0) }, expectError: false, expectText: "newest first" },
  { label: "date in words (schema)", tool: "list_orders", args: { from_date: "last month" }, expectError: true, expectText: "YYYY-MM-DD" },
  { label: "orders containing a product", tool: "list_orders", args: { product: "CO-TRL-002" }, expectError: false, expectText: 'containing "CO-TRL-002"' },
  { label: "biggest orders", tool: "list_orders", args: { sort_by: "total", limit: 3 }, expectError: false, expectText: "biggest first" },
  { label: "orders over $500 shipped to Colorado", tool: "list_orders", args: { min_total: 500, ship_state: "Colorado" }, expectError: false, expectText: "shipped to CO" },
  { label: "smallest orders", tool: "list_orders", args: { sort_by: "total", lowest_first: true, limit: 3 }, expectError: false, expectText: "smallest first" },
  { label: "total range upside down", tool: "list_orders", args: { min_total: 500, max_total: 100 }, expectError: true, expectText: "is above max_total" },
  { label: "dates reversed", tool: "list_orders", args: { from_date: "2026-10-01", to_date: "2026-09-01" }, expectError: true, expectText: "is after" },
  { label: "unknown status (schema)", tool: "list_orders", args: { status: "lost" }, expectError: true, expectText: "Input validation error" },

  // get_order
  { label: "the 7-line order", tool: "get_order", args: { order_number: "CP-10266" }, expectError: false, expectText: "7 lines" },
  { label: "number without prefix", tool: "get_order", args: { order_number: "10266" }, expectError: false, expectText: "CP-10266" },
  { label: "order number sent as a NUMBER", tool: "get_order", args: { order_number: 10266 }, expectError: false, expectText: "CP-10266" },
  { label: "unknown order", tool: "get_order", args: { order_number: "CP-99999" }, expectError: true, expectText: "list_orders" },

  // find_products
  { label: "empty query means no filter", tool: "find_products", args: { query: "", limit: 5 }, expectError: false, expectText: "products match" },
  { label: "empty query still refused for customers", tool: "find_customers", args: { query: "", limit: 100 }, expectError: true, expectText: "Input validation error" },
  { label: "headlamps under $50", tool: "find_products", args: { query: "Nightstride", max_price: 50 }, expectError: false },
  { label: "loose category", tool: "find_products", args: { category: "shoes" }, expectError: false, expectText: "Trail shoes" },
  { label: "discontinued hidden by default", tool: "find_products", args: { query: "Scree 2" }, expectError: false, expectText: "Discontinued products were not included" },
  { label: "discontinued on request", tool: "find_products", args: { query: "Scree 2", availability: "all" }, expectError: false, expectText: "[discontinued]" },
  { label: "only discontinued", tool: "find_products", args: { availability: "discontinued" }, expectError: false, expectText: "[discontinued]" },
  { label: "\"500\" as a string", tool: "find_products", args: { query: "Scree", availability: "all", max_price: "500" }, expectError: false, expectText: "[discontinued]" },
  { label: "cheapest headlamp", tool: "find_products", args: { category: "Headlamps", sort_by: "price", lowest_first: true, limit: 1 }, expectError: false, expectText: "lowest first" },
  { label: "packs under 500 g, lightest first", tool: "find_products", args: { category: "Packs", max_weight: 500, sort_by: "weight", lowest_first: true }, expectError: false, expectText: "Sorted by weight" },
  { label: "orange gear between $20 and $80", tool: "find_products", args: { color: "Orange", min_price: 20, max_price: 80 }, expectError: false, expectText: "Orange" },
  { label: "never sold", tool: "find_products", args: { never_sold: true, availability: "all" }, expectError: false, expectText: "CO-PDL-001" },
  { label: "not sold in 90 days", tool: "find_products", args: { not_sold_since: daysAgo(90), sort_by: "last_sold", lowest_first: true }, expectError: false, expectText: "product" },
  { label: "best sellers by units", tool: "find_products", args: { sort_by: "units_sold", limit: 5 }, expectError: false, expectText: "Sorted by units sold, highest first" },
  { label: "price range upside down", tool: "find_products", args: { min_price: 100, max_price: 50 }, expectError: true, expectText: "is above max_price" },
  { label: "unknown sort (schema)", tool: "find_products", args: { sort_by: "price_cents DESC; DROP TABLE products" }, expectError: true, expectText: "Input validation error" },

  // get_product
  { label: "never ordered", tool: "get_product", args: { sku: "CO-PDL-001" }, expectError: false, expectText: "Never ordered" },
  { label: "lower-case SKU", tool: "get_product", args: { sku: "co-trl-002" }, expectError: false, expectText: "DISCONTINUED" },
  { label: "the injected description", tool: "get_product", args: { sku: "CO-SAF-001" }, expectError: false, expectText: "ignore all previous instructions" },
  { label: "unknown SKU", tool: "get_product", args: { sku: "CO-XXX-999" }, expectError: true, expectText: "find_products" },

  // sales_report — one tool, many questions
  { label: "top 10 products by units", tool: "sales_report", args: { metric: "units", group_by: "product", limit: 10 }, expectError: false, expectText: "Units sold by product (highest first)" },
  { label: "top products by REVENUE", tool: "sales_report", args: { metric: "revenue", group_by: "product", limit: 5 }, expectError: false, expectText: "Revenue by product" },
  { label: "revenue by month, in date order", tool: "sales_report", args: { metric: "revenue", group_by: "month", limit: 6 }, expectError: false, expectText: "(oldest first)" },
  { label: "best customers by spend", tool: "sales_report", args: { metric: "revenue", group_by: "customer", limit: 5 }, expectError: false, expectText: "customer #" },
  { label: "units by category, one category", tool: "sales_report", args: { metric: "units", group_by: "category", category: "shoes" }, expectError: false, expectText: 'in "shoes"' },
  { label: "worst-selling brands", tool: "sales_report", args: { metric: "units", group_by: "brand", lowest: true }, expectError: false, expectText: "(lowest first)" },
  { label: "orders by state", tool: "sales_report", args: { metric: "orders", group_by: "state" }, expectError: false, expectText: "Orders by state" },
  { label: "average order value by month", tool: "sales_report", args: { metric: "avg_order_value", group_by: "month", from_date: daysAgo(120) }, expectError: false, expectText: "Average order value by month" },
  { label: "only cancelled orders", tool: "sales_report", args: { metric: "orders", group_by: "category", status: "cancelled" }, expectError: false, expectText: "status cancelled" },
  { label: "worst sellers include the never-sold product", tool: "sales_report", args: { metric: "units", group_by: "product", lowest: true, limit: 5 }, expectError: false, expectText: "CO-PDL-001" },
  { label: "zero-sales products in a period", tool: "sales_report", args: { metric: "units", group_by: "product", lowest: true, from_date: daysAgo(7), limit: 3 }, expectError: false, expectText: "— 0" },
  { label: "orders in each status (cancelled included)", tool: "sales_report", args: { metric: "orders", group_by: "status" }, expectError: false, expectText: "cancelled" },
  { label: "distinct customers by year", tool: "sales_report", args: { metric: "customers", group_by: "year" }, expectError: false, expectText: "Customers by year (oldest first)" },
  { label: "gross sales by week", tool: "sales_report", args: { metric: "gross", group_by: "week", limit: 4 }, expectError: false, expectText: "Gross sales (with shipping and tax) by week" },
  { label: "a grouping that is not in the vocabulary", tool: "sales_report", args: { metric: "revenue", group_by: "email" }, expectError: true, expectText: "Input validation error" },
  { label: "a metric that is not in the vocabulary", tool: "sales_report", args: { metric: "SUM(price_cents)", group_by: "product" }, expectError: true, expectText: "Input validation error" },
  // customer_segment — flexible, but no "everyone" and no contact details for the model
  { label: "customers in a state, by full name", tool: "customer_segment", args: { state: "Colorado" }, expectError: false, expectText: "state CO" },
  { label: "a state with no customers says where they do live", tool: "customer_segment", args: { state: "Illinois" }, expectError: false, expectText: "Customers live in:" },
  { label: "spend over $1,000", tool: "customer_segment", args: { min_spend: 1000, limit: 5 }, expectError: false, expectText: "min spend $1000" },
  { label: "never ordered", tool: "customer_segment", args: { max_orders: 0 }, expectError: false, expectText: "Avery Okafor" },
  { label: "lapsed customers", tool: "customer_segment", args: { not_ordered_since: daysAgo(180) }, expectError: false, expectText: "customer" },
  { label: "bought in a category", tool: "customer_segment", args: { bought_category: "Paddle", sort_by: "orders", limit: 3 }, expectError: false, expectText: "bought category Paddle" },
  { label: "no filter is refused — no 'everyone' query", tool: "customer_segment", args: { limit: 20 }, expectError: true, expectText: "deliberately no way to list every customer" },
  { label: "empty filters still count as none", tool: "customer_segment", args: { state: "", city: "" }, expectError: true, expectText: "at least one filter" },
  { label: "limit over the cap (schema)", tool: "customer_segment", args: { state: "CO", limit: 80 }, expectError: true, expectText: "Input validation error" },
  { label: "limit over the cap (schema)", tool: "sales_report", args: { metric: "units", group_by: "product", limit: 100 }, expectError: true, expectText: "Input validation error" },
];

/** The text of a result's first text block. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const block = content.find(
    (b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
  );
  return block?.text ?? "";
}

function indent(text: string): string {
  return text.split("\n").map((line) => `      ${line}`).join("\n");
}

async function main(): Promise<void> {
  // The same command the app uses in development: Node with tsx loaded,
  // running the stdio entry point. process.execPath rather than "npx" or
  // "tsx", because spawning those on Windows needs a shell.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join("data-server", "stdio.ts")],
    cwd: ROOT,
    stderr: "pipe",
  });

  // The data server's stderr is its diagnostics channel. Show it, so a
  // missing database or a crash is visible here rather than a hang.
  (transport.stderr as Readable | null)?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) console.log(`  [data server] ${line}`);
    }
  });

  const client = new Client({ name: "try-tools", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`\nConnected. The data server offers ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);

  let failures = 0;
  for (const c of CASES) {
    const result = await client.callTool({ name: c.tool, arguments: c.args });
    const isError = result.isError === true;
    const text = textOf(result.content);
    const queries = (result._meta?.[QUERIES_META_KEY] ?? []) as QueryReport[];

    const problems: string[] = [];
    if (isError !== c.expectError) problems.push(c.expectError ? "expected an error result" : "unexpected error result");
    if (c.expectText && !text.includes(c.expectText)) problems.push(`summary lacks "${c.expectText}"`);
    if (!isError && (typeof result.structuredContent !== "object" || result.structuredContent === null)) {
      problems.push("no structured result for the screen");
    }

    const ok = problems.length === 0;
    if (!ok) failures += 1;

    console.log(`${ok ? "PASS" : "FAIL"}  ${c.tool} — ${c.label}  ${JSON.stringify(c.args)}`);
    if (!ok) console.log(`      ✗ ${problems.join("; ")}`);
    console.log(indent(`model reads${isError ? " (isError)" : ""}: ${text}`));
    if (result.structuredContent && typeof result.structuredContent === "object") {
      console.log(`      screen gets: { ${Object.keys(result.structuredContent).join(", ")} }`);
    }
    for (const q of queries) {
      console.log(`      sql (${q.rows} rows, ${q.ms} ms): ${q.sql.slice(0, 110)}${q.sql.length > 110 ? "…" : ""}`);
    }
    console.log("");
  }

  // A tool that does not exist. The app checks names before calling, but
  // the server's own answer is worth seeing.
  try {
    const r = await client.callTool({ name: "run_sql", arguments: { sql: "SELECT email FROM customers" } });
    console.log(`run_sql (does not exist): isError=${r.isError === true} — ${textOf(r.content)}`);
  } catch (error: unknown) {
    console.log(`run_sql (does not exist): rejected — ${error instanceof Error ? error.message : String(error)}`);
  }

  await client.close();

  console.log(`\n${CASES.length - failures} of ${CASES.length} cases passed.`);
  if (failures > 0) process.exitCode = 1;
}

await main();
