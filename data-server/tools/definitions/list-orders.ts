/**
 * list-orders.ts — a table of orders, filtered by customer, status and date.
 *
 * Coarse-grained on purpose. "What has Dana Whitlock ordered since
 * September?" is one call: this tool takes the customer's EMAIL directly
 * (as well as an id), so a small model does not have to chain
 * find_customers → get_customer → list_orders and lose its way halfway.
 * Fewer steps is the single biggest help a small model can be given.
 *
 * ---------------------------------------------------------------------------
 * Optional filters without building SQL strings
 * ---------------------------------------------------------------------------
 *
 * Every filter is optional, and the obvious implementation glues WHERE
 * clauses together depending on which arguments arrived. That works, but
 * it means the SQL that runs is different on every call and has to be
 * assembled correctly each time.
 *
 * Instead the statement below is FIXED, and each filter reads
 *
 *     (:customer IS NULL OR o.customer_id = :customer)
 *
 * Bind NULL and the condition is true for every row — the filter is off.
 * Bind a value and it filters. `:customer` is a NAMED parameter, so the
 * same value can appear twice while being bound once, from an object.
 * The SQL in the activity log is then the same text every time, with only
 * the parameters changing, which makes it much easier to read.
 *
 * (Named, not SQLite's numbered `?1`: node:sqlite treats `?1` as a named
 * parameter too, so binding values to it by position fails with "column
 * index out of range". See SqlParams in tools/types.ts.)
 *
 * ---------------------------------------------------------------------------
 * Zero orders is an answer
 * ---------------------------------------------------------------------------
 *
 * Avery Okafor has never ordered anything. "Avery Okafor has no orders"
 * comes back as an ordinary result, not an error — it is the correct
 * answer, and the answer gate needs to see a SUCCESSFUL lookup behind it.
 */

import { z } from "zod";
import type { CustomerRef, OrderListResult, OrderRow } from "../../../shared/checkpoint.js";
import {
  SUMMARY_ROWS, andMore, customerRefSchema, day, isoDateSchema, lenientBoolean, lenientNumber,
  likePattern, money, orderStatusSchema, stateCode,
} from "../common.js";
import { ToolError, defineTool } from "../types.js";

const outputSchema: z.ZodType<OrderListResult> = z.object({
  customer: customerRefSchema.nullable(),
  orders: z.array(z.object({
    orderNumber: z.string(),
    placedAt: z.string(),
    status: orderStatusSchema,
    customerName: z.string(),
    itemCount: z.number().int(),
    totalCents: z.number().int(),
  })),
  total: z.number().int(),
});

interface Row {
  order_number: string; placed_at: string; status: OrderRow["status"];
  customer_name: string; item_count: number; total_cents: number; total: number;
}

/** Sort keys → ORDER BY, newest/biggest first and oldest/smallest first. Chosen by enum. */
const SORTS = {
  placed_at: { desc: "o.placed_at DESC", asc: "o.placed_at ASC" },
  total: { desc: "o.total_cents DESC, o.placed_at DESC", asc: "o.total_cents ASC, o.placed_at DESC" },
} as const;
type SortKey = keyof typeof SORTS;

/**
 * The query. `to_date` is inclusive of the whole day: placed_at is a
 * timestamp, so "on or before 2026-10-31" means "before 2026-11-01",
 * which is what `date(:to, '+1 day')` computes. Comparing a timestamp to
 * the bare date '2026-10-31' would quietly drop everything placed on the
 * 31st after midnight.
 *
 * The product filter is an EXISTS over the order's lines, so an order
 * with two matching lines is still listed once. The state is the order's
 * SHIPPING address — where it went, not where the customer lives.
 */
function buildSql(sort: SortKey, lowest: boolean): string {
  return `
  SELECT o.order_number,
         o.placed_at,
         o.status,
         c.first_name || ' ' || c.last_name AS customer_name,
         (SELECT SUM(i.quantity) FROM order_items i WHERE i.order_id = o.id) AS item_count,
         o.total_cents,
         COUNT(*) OVER () AS total
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN addresses a ON a.id = o.shipping_address_id
  WHERE (:customer IS NULL OR o.customer_id = :customer)
    AND (:status IS NULL OR o.status = :status)
    AND (:from IS NULL OR o.placed_at >= :from)
    AND (:to IS NULL OR o.placed_at < date(:to, '+1 day'))
    AND (:min_total IS NULL OR o.total_cents >= :min_total)
    AND (:max_total IS NULL OR o.total_cents <= :max_total)
    AND (:ship_state IS NULL OR a.state = :ship_state)
    AND (:product IS NULL OR EXISTS (
          SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id
          WHERE i.order_id = o.id
            AND (p.sku LIKE :product ESCAPE '\\' OR p.name LIKE :product ESCAPE '\\')))
  ORDER BY ${SORTS[sort][lowest ? "asc" : "desc"]}
  LIMIT :limit`;
}

interface CustomerRow { id: number; name: string; email: string }

export const listOrders = defineTool({
  name: "list_orders",
  title: "List orders",

  description:
    "Lists Checkpoint Outfitters orders with order number, date, status, item count " +
    "and total. Filter by customer (customer_id OR email), status, date range, a product " +
    "on the order (SKU or name), order total range in US dollars, and shipping state — all " +
    "optional. Newest first by default; sort_by total for the biggest (or, with " +
    "lowest_first, smallest) orders. Use it for \"what has this customer ordered\", " +
    "\"which orders are pending\", \"orders last month\", \"orders containing CO-TRL-001\", " +
    "\"our biggest orders\". Not for the line items of one order (use get_order) or totals " +
    "(use sales_report).",

  inputSchema: z.object({
    customer_id: lenientNumber(z.number().int().positive()).optional()
      .describe("Only this customer's orders, by numeric id."),
    email: z.string().trim().optional()
      .describe("Only this customer's orders, by exact email address. Use instead of customer_id."),
    status: orderStatusSchema.optional()
      .describe("Only orders with this status."),
    from_date: isoDateSchema.optional()
      .describe("Only orders placed on or after this date, YYYY-MM-DD."),
    to_date: isoDateSchema.optional()
      .describe("Only orders placed on or before this date, YYYY-MM-DD."),
    product: z.string().trim().optional()
      .describe("Only orders containing this product: SKU or name, or part of it, e.g. \"CO-TRL-001\" or \"Ridge Runner\"."),
    min_total: lenientNumber(z.number().min(0)).optional()
      .describe("Only orders whose total is at least this many US DOLLARS."),
    max_total: lenientNumber(z.number().min(0)).optional()
      .describe("Only orders whose total is at most this many US DOLLARS."),
    ship_state: z.string().trim().optional()
      .describe("Only orders shipped to this US state: code or full name, e.g. \"CO\" or \"Colorado\"."),
    sort_by: z.enum(["placed_at", "total"]).default("placed_at")
      .describe("placed_at (default, newest first) or total (biggest first)."),
    lowest_first: lenientBoolean(z.boolean()).default(false)
      .describe("Reverse the order: oldest first, or smallest total first. Defaults to false."),
    limit: lenientNumber(z.number().int().min(1).max(50)).default(20)
      .describe("Most orders to return, 1 to 50. Defaults to 20."),
  }),

  outputSchema,

  run(input, db) {
    const email = input.email ? input.email : undefined; // "" counts as absent
    if (input.customer_id !== undefined && email !== undefined) {
      throw new ToolError("Send customer_id or email, not both.");
    }
    if (input.from_date && input.to_date && input.from_date > input.to_date) {
      throw new ToolError(`from_date ${input.from_date} is after to_date ${input.to_date}.`);
    }
    if (input.min_total !== undefined && input.max_total !== undefined && input.min_total > input.max_total) {
      throw new ToolError(`min_total ${input.min_total} is above max_total ${input.max_total}.`);
    }
    const product = input.product ? input.product : null; // "" counts as absent
    const shipState = input.ship_state ? stateCode(input.ship_state) : null;

    // Resolve the customer first, so an unknown one is an error the model
    // can act on — rather than an empty list that looks like "no orders".
    let customer: CustomerRef | null = null;
    if (input.customer_id !== undefined || email !== undefined) {
      const row = input.customer_id !== undefined
        ? db.get<CustomerRow>(
            "SELECT id, first_name || ' ' || last_name AS name, email FROM customers WHERE id = ?",
            input.customer_id)
        : db.get<CustomerRow>(
            "SELECT id, first_name || ' ' || last_name AS name, email FROM customers WHERE email = ? COLLATE NOCASE",
            email ?? "");
      if (!row) {
        throw new ToolError(input.customer_id !== undefined
          ? `No customer with id ${input.customer_id}. Use find_customers to look them up.`
          : `No customer with email ${email}. Use find_customers to search by name.`);
      }
      customer = { id: row.id, name: row.name, email: row.email };
    }

    const rows = db.all<Row>(buildSql(input.sort_by, input.lowest_first), {
      customer: customer?.id ?? null,
      status: input.status ?? null,
      from: input.from_date ?? null,
      to: input.to_date ?? null,
      // Dollars in, cents out — Math.round because 19.99 * 100 is not 1999.
      min_total: input.min_total !== undefined ? Math.round(input.min_total * 100) : null,
      max_total: input.max_total !== undefined ? Math.round(input.max_total * 100) : null,
      ship_state: shipState,
      product: product ? likePattern(product) : null,
      limit: input.limit,
    });

    const orders: OrderRow[] = rows.map((r) => ({
      orderNumber: r.order_number,
      placedAt: r.placed_at,
      status: r.status,
      customerName: r.customer_name,
      itemCount: r.item_count,
      totalCents: r.total_cents,
    }));
    const total = rows[0]?.total ?? 0;
    const data: OrderListResult = { customer, orders, total };

    // Describe the filters in words, so the model can repeat them back.
    const filters = [
      input.status && `status ${input.status}`,
      input.from_date && `from ${input.from_date}`,
      input.to_date && `to ${input.to_date}`,
      product && `containing "${product}"`,
      input.min_total !== undefined && `total at least $${input.min_total}`,
      input.max_total !== undefined && `total at most $${input.max_total}`,
      shipState && `shipped to ${shipState}`,
    ].filter(Boolean).join(", ");
    const order = input.sort_by === "total"
      ? (input.lowest_first ? "smallest first" : "biggest first")
      : (input.lowest_first ? "oldest first" : "newest first");
    const whose = customer ? `${customer.name} (customer #${customer.id})` : "all customers";
    const scope = filters ? `${whose}, ${filters}` : whose;

    if (total === 0) {
      return {
        data,
        summary: customer && !filters
          ? `${customer.name} (customer #${customer.id}) has no orders.`
          : `No orders for ${scope}.`,
      };
    }

    const shown = orders.slice(0, SUMMARY_ROWS);
    return {
      data,
      summary:
        `${total} order${total === 1 ? "" : "s"} for ${scope}, ${order}:\n` +
        shown.map((o) =>
          `- ${o.orderNumber} ${day(o.placedAt)} ${o.status}, ` +
          `${o.itemCount} item${o.itemCount === 1 ? "" : "s"}, ${money(o.totalCents)}` +
          (customer ? "" : ` — ${o.customerName}`),
        ).join("\n") +
        andMore(shown.length, orders.length, total),
    };
  },
});
