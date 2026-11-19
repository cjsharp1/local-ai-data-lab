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
  SUMMARY_ROWS, andMore, customerRefSchema, day, isoDateSchema, lenientNumber, money,
  orderStatusSchema,
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

/**
 * The query. `to_date` is inclusive of the whole day: placed_at is a
 * timestamp, so "on or before 2026-10-31" means "before 2026-11-01",
 * which is what `date(:to, '+1 day')` computes. Comparing a timestamp to
 * the bare date '2026-10-31' would quietly drop everything placed on the
 * 31st after midnight.
 */
const SQL = `
  SELECT o.order_number,
         o.placed_at,
         o.status,
         c.first_name || ' ' || c.last_name AS customer_name,
         (SELECT SUM(i.quantity) FROM order_items i WHERE i.order_id = o.id) AS item_count,
         o.total_cents,
         COUNT(*) OVER () AS total
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  WHERE (:customer IS NULL OR o.customer_id = :customer)
    AND (:status IS NULL OR o.status = :status)
    AND (:from IS NULL OR o.placed_at >= :from)
    AND (:to IS NULL OR o.placed_at < date(:to, '+1 day'))
  ORDER BY o.placed_at DESC
  LIMIT :limit`;

interface CustomerRow { id: number; name: string; email: string }

export const listOrders = defineTool({
  name: "list_orders",
  title: "List orders",

  description:
    "Lists Checkpoint Outfitters orders, newest first, with order number, date, " +
    "status, item count and total. Filter by customer (customer_id OR email), " +
    "status, and a date range — all optional. Use it for questions like \"what " +
    "has this customer ordered\", \"which orders are still pending\" or \"orders " +
    "last month\". Not for the line items of one order (use get_order).",

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

    const rows = db.all<Row>(SQL, {
      customer: customer?.id ?? null,
      status: input.status ?? null,
      from: input.from_date ?? null,
      to: input.to_date ?? null,
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
    ].filter(Boolean).join(", ");
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
        `${total} order${total === 1 ? "" : "s"} for ${scope}, newest first:\n` +
        shown.map((o) =>
          `- ${o.orderNumber} ${day(o.placedAt)} ${o.status}, ` +
          `${o.itemCount} item${o.itemCount === 1 ? "" : "s"}, ${money(o.totalCents)}` +
          (customer ? "" : ` — ${o.customerName}`),
        ).join("\n") +
        andMore(shown.length, orders.length, total),
    };
  },
});
