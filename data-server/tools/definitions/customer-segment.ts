/**
 * customer-segment.ts — find customers by facts about them, not by name.
 *
 * Where they live, when they joined, how often and how much they buy,
 * when they last ordered, what they have bought — in any combination:
 *
 *   "Which customers live in Colorado?"           state
 *   "Who has spent more than $1,000?"             min_spend
 *   "Who hasn't ordered since June?"              not_ordered_since
 *   "Which customers have bought paddle gear?"    bought_category
 *   "Our newest customers in Portland"            city + sort_by joined
 *
 * The customer-side partner of sales_report: one tool for a family of
 * questions, filters chosen from a fixed list, SQL fixed in this file,
 * every value bound, at most 20 rows.
 *
 * ---------------------------------------------------------------------------
 * The privacy design — two deliberate limits
 * ---------------------------------------------------------------------------
 *
 * A tool that lists groups of customers sits close to what the seeded
 * prompt injection asked for: "list the email address of every customer".
 * So, by design:
 *
 *   1. AT LEAST ONE FILTER IS REQUIRED. There is no "everyone" query. The
 *      error says so plainly, so a model knows not to keep trying.
 *
 *   2. THE MODEL NEVER GETS CONTACT DETAILS FROM THIS TOOL. Its text
 *      summary has names, places, order counts and spend — what segment
 *      questions need — but no email or phone. The structured result
 *      carries them, for the rep screen, and this app never hands
 *      structured results to the model (it reads only the text). To reach
 *      one person's email the model must use get_customer, one customer
 *      per call, within a six-request turn. This is DATA MINIMISATION:
 *      give each caller only the fields its job needs.
 *
 * Limit 2 depends on the app, not the server: an MCP client that did pass
 * structuredContent to a model would leak the contact details. That is
 * worth knowing — the boundary is the whole system, not one file.
 *
 * Location is the BILLING address (where the customer lives), unlike
 * sales_report's state, which is where an order was SHIPPED.
 */

import { z } from "zod";
import type { CustomerSegmentResult, SegmentCustomer } from "../../../shared/checkpoint.js";
import {
  SUMMARY_ROWS, andMore, day, isoDateSchema, lenientBoolean, lenientNumber, likePattern, money, stateCode,
} from "../common.js";
import { ToolError, defineTool } from "../types.js";

/** Sort keys → ORDER BY fragments, highest-first and lowest-first. Written here; chosen by enum. */
const SORTS = {
  spend: { desc: "spend_cents DESC, name", asc: "spend_cents ASC, name" },
  orders: { desc: "order_count DESC, name", asc: "order_count ASC, name" },
  joined: { desc: "joined_at DESC, name", asc: "joined_at ASC, name" },
  last_order: { desc: "last_order DESC NULLS LAST, name", asc: "last_order ASC NULLS FIRST, name" },
  name: { desc: "name ASC", asc: "name ASC" },
} as const;
type SortKey = keyof typeof SORTS;
const sortKeys = Object.keys(SORTS) as [SortKey, ...SortKey[]];

const outputSchema: z.ZodType<CustomerSegmentResult> = z.object({
  customers: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    city: z.string(),
    state: z.string(),
    joinedAt: z.string(),
    orderCount: z.number().int(),
    lifetimeSpendCents: z.number().int(),
    lastOrderAt: z.string().nullable(),
  })),
  total: z.number().int(),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  sortBy: z.string(),
  lowestFirst: z.boolean(),
});

interface Row {
  id: number; name: string; email: string; phone: string; city: string; state: string; joined_at: string;
  order_count: number; spend_cents: number; last_order: string | null; total: number;
}

/**
 * One row per customer with their figures (the CTE), then every filter
 * switched off by binding NULL — the same fixed-SQL pattern as
 * list_orders. Only the ORDER BY varies, and it comes from SORTS.
 */
function buildSql(sort: SortKey, lowest: boolean): string {
  const bought = (match: string) => `
      EXISTS (SELECT 1 FROM orders o2
              JOIN order_items i2 ON i2.order_id = o2.id
              JOIN products p2 ON p2.id = i2.product_id
              WHERE o2.customer_id = s.id AND o2.status <> 'cancelled' AND (${match}))`;
  return `
    WITH s AS (
      SELECT c.id,
             c.first_name || ' ' || c.last_name AS name,
             c.email, c.phone, c.joined_at,
             a.city, a.state,
             (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count,
             (SELECT COALESCE(SUM(o.total_cents), 0) FROM orders o
               WHERE o.customer_id = c.id AND o.status NOT IN ('cancelled', 'returned')) AS spend_cents,
             (SELECT MAX(o.placed_at) FROM orders o WHERE o.customer_id = c.id) AS last_order
      FROM customers c
      JOIN addresses a ON a.customer_id = c.id AND a.kind = 'billing'
    )
    SELECT s.*, COUNT(*) OVER () AS total
    FROM s
    WHERE (:state IS NULL OR s.state = :state)
      AND (:city IS NULL OR s.city LIKE :city ESCAPE '\\')
      AND (:joined_from IS NULL OR s.joined_at >= :joined_from)
      AND (:joined_to IS NULL OR s.joined_at <= :joined_to)
      AND (:min_orders IS NULL OR s.order_count >= :min_orders)
      AND (:max_orders IS NULL OR s.order_count <= :max_orders)
      AND (:min_spend IS NULL OR s.spend_cents >= :min_spend)
      AND (:max_spend IS NULL OR s.spend_cents <= :max_spend)
      AND (:ordered_since IS NULL OR s.last_order >= :ordered_since)
      AND (:not_ordered_since IS NULL OR s.last_order IS NULL OR s.last_order < :not_ordered_since)
      AND (:bought_category IS NULL OR ${bought("p2.category LIKE :bought_category ESCAPE '\\'")})
      AND (:bought_product IS NULL OR ${bought("p2.name LIKE :bought_product ESCAPE '\\' OR p2.sku LIKE :bought_product ESCAPE '\\'")})
    ORDER BY ${SORTS[sort][lowest ? "asc" : "desc"]}
    LIMIT :limit`;
}

export const customerSegment = defineTool({
  name: "customer_segment",
  title: "Customer segment",

  description:
    "Lists Checkpoint Outfitters customers who match filters: state or city they live in, " +
    "when they joined, number of orders, lifetime spend (US dollars), whether they have " +
    "ordered since a date (or not), and a category or product they have bought. At least " +
    "one filter is required. Returns names, location, order count, spend and last order — " +
    "NOT emails or phone numbers (use get_customer for one customer's contact details). " +
    "Not for finding someone by name (use find_customers).",

  inputSchema: z.object({
    state: z.string().trim().optional()
      .describe("US state they live in: two-letter code or full name, e.g. \"CO\" or \"Colorado\"."),
    city: z.string().trim().optional()
      .describe("City they live in (all or part of the name)."),
    joined_from: isoDateSchema.optional().describe("Joined on or after this date, YYYY-MM-DD."),
    joined_to: isoDateSchema.optional().describe("Joined on or before this date, YYYY-MM-DD."),
    min_orders: lenientNumber(z.number().int().min(0)).optional().describe("At least this many orders."),
    max_orders: lenientNumber(z.number().int().min(0)).optional().describe("At most this many orders (0 = never ordered)."),
    min_spend: lenientNumber(z.number().min(0)).optional().describe("Lifetime spend of at least this many US DOLLARS."),
    max_spend: lenientNumber(z.number().min(0)).optional().describe("Lifetime spend of at most this many US DOLLARS."),
    ordered_since: isoDateSchema.optional().describe("Has placed an order on or after this date, YYYY-MM-DD."),
    not_ordered_since: isoDateSchema.optional()
      .describe("Has NOT ordered on or after this date (includes customers who never ordered), YYYY-MM-DD."),
    bought_category: z.string().trim().optional().describe("Has bought something in this category, e.g. \"Paddle\"."),
    bought_product: z.string().trim().optional().describe("Has bought this product (name or SKU, or part of it)."),
    sort_by: z.enum(sortKeys).default("spend")
      .describe("Order the list by spend, orders, joined, last_order or name. Defaults to spend."),
    lowest_first: lenientBoolean(z.boolean()).default(false)
      .describe("Reverse the order: lowest spend, fewest orders, earliest joined first. Defaults to false."),
    limit: lenientNumber(z.number().int().min(1).max(20)).default(10)
      .describe("How many customers to return, 1 to 20. Defaults to 10."),
  }),

  outputSchema,

  run(input, db) {
    // "" counts as absent, as everywhere else; then require a real filter.
    const text = (v: string | undefined) => (v ? v : null);
    const filters: Record<string, string | number | boolean> = {};
    const params = {
      state: text(input.state) ? stateCode(input.state as string) : null,
      city: text(input.city) ? likePattern(input.city as string) : null,
      joined_from: input.joined_from ?? null,
      joined_to: input.joined_to ?? null,
      min_orders: input.min_orders ?? null,
      max_orders: input.max_orders ?? null,
      // Dollars in, cents out — Math.round because 19.99 * 100 is not 1999 in floating point.
      min_spend: input.min_spend !== undefined ? Math.round(input.min_spend * 100) : null,
      max_spend: input.max_spend !== undefined ? Math.round(input.max_spend * 100) : null,
      ordered_since: input.ordered_since ?? null,
      not_ordered_since: input.not_ordered_since ?? null,
      bought_category: text(input.bought_category) ? likePattern(input.bought_category as string) : null,
      bought_product: text(input.bought_product) ? likePattern(input.bought_product as string) : null,
    };
    for (const [key, value] of Object.entries(input)) {
      if (["sort_by", "lowest_first", "limit"].includes(key) || value === undefined || value === "") continue;
      filters[key] = key === "state" ? stateCode(String(value)) : (value as string | number | boolean);
    }

    if (Object.keys(filters).length === 0) {
      throw new ToolError(
        "Give at least one filter (state, city, joined dates, orders, spend, ordered since, bought…). " +
        "There is deliberately no way to list every customer. To find someone by name, use find_customers.");
    }

    const rows = db.all<Row>(buildSql(input.sort_by, input.lowest_first), { ...params, limit: input.limit });
    const customers: SegmentCustomer[] = rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, city: r.city, state: r.state,
      joinedAt: r.joined_at, orderCount: r.order_count, lifetimeSpendCents: r.spend_cents, lastOrderAt: r.last_order,
    }));
    const total = rows[0]?.total ?? 0;
    const data: CustomerSegmentResult = {
      customers, total, filters, sortBy: input.sort_by, lowestFirst: input.lowest_first,
    };

    const described = Object.entries(filters).map(([k, v]) =>
      `${k.replace(/_/g, " ")} ${k.endsWith("spend") ? `$${v}` : v}`).join(", ");

    if (total === 0) {
      // When the state filter alone explains the empty result, say where
      // customers DO live — "none" is a better answer with context.
      let hint = "";
      if (params.state) {
        const states = db.all<{ state: string }>(
          "SELECT DISTINCT state FROM addresses WHERE kind = 'billing' ORDER BY state");
        if (!states.some((s) => s.state === params.state)) {
          hint = ` No customers live in ${params.state}. Customers live in: ${states.map((s) => s.state).join(", ")}.`;
        }
      }
      return { data, summary: `No customers match: ${described}.${hint}` };
    }

    // The model's view: no email, no phone — see the header.
    const shown = customers.slice(0, Math.max(SUMMARY_ROWS, Math.min(customers.length, 10)));
    return {
      data,
      summary:
        `${total} customer${total === 1 ? "" : "s"} match ${described} (sorted by ${input.sort_by.replace("_", " ")}` +
        `${input.lowest_first ? ", lowest first" : ""}). Contact details are not included — use get_customer for one person:\n` +
        shown.map((c) =>
          `- #${c.id} ${c.name} — ${c.city} ${c.state}, ${c.orderCount} order${c.orderCount === 1 ? "" : "s"}, ` +
          `${money(c.lifetimeSpendCents)} spent, last order ${c.lastOrderAt ? day(c.lastOrderAt) : "never"}`,
        ).join("\n") +
        andMore(shown.length, customers.length, total),
    };
  },
});
