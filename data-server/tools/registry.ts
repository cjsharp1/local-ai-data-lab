/**
 * registry.ts — the complete list of tools the data server offers.
 *
 * Seven read-only tools, and that list IS the fence. Whatever the model is
 * told or tricked into wanting, these seven calls are the only things it
 * can ask the database for. Adding a tool here widens what a model can
 * reach; nothing else in the project does.
 *
 *   find_customers   search people by name, email or phone
 *   get_customer     one person's full record
 *   list_orders      orders, filtered by customer, status, date
 *   get_order        one order's lines and totals
 *   find_products    search the catalogue
 *   get_product      one product, with sales figures
 *   sales_report     totals and rankings: a metric × a grouping × filters
 *
 * There were six. A seventh, top_products, was added when "What are the
 * 10 most popular products?" could not be answered — and the next
 * question, "by revenue?", showed that a tool per question does not
 * scale. It became sales_report: a SEMANTIC LAYER, where metrics and
 * groupings are defined once in code and the model only picks from them
 * (see sales-report.ts). Still narrow in the way that matters — fixed
 * SQL fragments, bound values, capped results — but one tool now covers
 * a whole family of questions.
 *
 * ---------------------------------------------------------------------------
 * Why there is no run_sql tool
 * ---------------------------------------------------------------------------
 *
 * A tool that runs SQL the model writes is the obvious shortcut — one
 * tool instead of seven, and it can answer anything. It would also hand the
 * model the whole database: every customer's email in one SELECT, joins
 * nobody designed, queries that scan every row. The read-only connection
 * would still stop writes, but every other guarantee in this project —
 * capped results, fixed queries, an answer that can be traced to a
 * specific lookup — would become decorative.
 *
 * Narrow tools are more work to write and they are the security model.
 * Do not add a raw SQL tool; if a question cannot be answered with these
 * seven, the right fix is a new narrow tool, or a new metric or grouping
 * in sales_report's vocabulary.
 */

import { findCustomers } from "./definitions/find-customers.js";
import { getCustomer } from "./definitions/get-customer.js";
import { listOrders } from "./definitions/list-orders.js";
import { getOrder } from "./definitions/get-order.js";
import { findProducts } from "./definitions/find-products.js";
import { getProduct } from "./definitions/get-product.js";
import { salesReport } from "./definitions/sales-report.js";
import type { AnyDataTool } from "./types.js";

export type { AnyDataTool, DataTool, QueryRunner, ToolOutput } from "./types.js";
export { ToolError } from "./types.js";

/** In the order a typical question uses them: find, then get. */
export const TOOLS: AnyDataTool[] = [
  findCustomers,
  getCustomer,
  listOrders,
  getOrder,
  findProducts,
  getProduct,
  salesReport,
];

/**
 * Fails at startup if two tools share a name.
 *
 * The SDK would register both, and clients would only ever reach one —
 * a tool that silently never runs is much harder to notice than a crash
 * at startup.
 */
export function assertUniqueToolNames(): void {
  const seen = new Set<string>();
  for (const tool of TOOLS) {
    if (seen.has(tool.name)) {
      throw new Error(`Two tools are registered as "${tool.name}". Tool names must be unique.`);
    }
    seen.add(tool.name);
  }
}
