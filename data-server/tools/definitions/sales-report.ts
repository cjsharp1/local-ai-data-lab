/**
 * sales-report.ts — one tool for a whole family of sales questions.
 *
 * Pick a METRIC, a GROUPING and optional FILTERS:
 *
 *   metric     units · revenue · gross · orders · customers · avg_order_value
 *   group_by   product · category · brand · customer · state · status ·
 *              week · month · year
 *   filters    from_date, to_date, category, status; lowest-first; limit ≤ 20
 *
 * and it answers "top products by revenue", "revenue by month", "best
 * customers by spend", "units by category in October", "which states
 * order most", "worst-selling products", "how many orders in each status",
 * "how many customers bought each year" — dozens of questions, one tool.
 *
 * ---------------------------------------------------------------------------
 * Why this, and not a tool per question — or a SQL tool
 * ---------------------------------------------------------------------------
 *
 * This replaced `top_products`, which ranked products by units and
 * nothing else. The first follow-up anyone asked — "by revenue?" — had no
 * tool. Adding `top_products_by_revenue`, then `revenue_by_month`, then
 * `top_customers` is the road to forty tools and a model that cannot
 * choose between them.
 *
 * The other road — let the model write SQL — is the one this project
 * refuses (see registry.ts). This sits between the two, and it is the
 * standard industry pattern, usually called a SEMANTIC LAYER (dbt
 * metrics, Cube, LookML): the business vocabulary — "revenue", "by
 * month" — is defined ONCE, in code, as SQL fragments; the model only
 * chooses from that vocabulary.
 *
 * ---------------------------------------------------------------------------
 * Why it is still safe
 * ---------------------------------------------------------------------------
 *
 * The model's choices are Zod ENUMS whose values are keys of the METRICS
 * and GROUPINGS maps below. The SQL is assembled from those maps' values
 * — fragments written here, by a person — never from anything the model
 * typed. Every VALUE (dates, category, status, limit) is a bound
 * parameter. Results are capped at 20 groups. Adding a metric or a
 * grouping is one entry in a map: the vocabulary grows, the attack
 * surface does not.
 *
 * ---------------------------------------------------------------------------
 * Two shapes of query — and the bug that made two necessary
 * ---------------------------------------------------------------------------
 *
 * Product, category and brand groupings start from the CATALOGUE and
 * LEFT JOIN the matching order lines; everything else starts from the
 * orders. The first version started every grouping from the orders, so a
 * product that never sold was simply absent — and "worst-selling
 * products" quietly left out the actual worst seller, the never-ordered
 * packraft. Starting from the catalogue lists it with zero. Discontinued
 * products are left out of those catalogue groupings unless they sold in
 * the period, so "worst sellers" is not a list of things nobody can buy.
 *
 * ---------------------------------------------------------------------------
 * Definitions worth knowing, because they are choices
 * ---------------------------------------------------------------------------
 *
 *   revenue          what the lines sold for — quantity × the price
 *                    snapshot — before tax and shipping
 *   gross            revenue plus each order's shipping and tax, shared
 *                    out across its lines in proportion to their value, so
 *                    it adds up under ANY grouping — to the cent, give or
 *                    take each group's rounding (checked: $152,032.72 both
 *                    ways across all orders) — where a plain join
 *                    would count an order's shipping once per line
 *   avg_order_value  revenue ÷ distinct orders, in cents, rounded
 *   cancelled        excluded unless `status` asks for them — except when
 *                    grouping BY status, where every status is shown;
 *                    returned orders count (they sold, then came back)
 *   state            the order's SHIPPING address, not the billing one
 */

import { z } from "zod";
import type { SalesReportResult, SalesReportRow } from "../../../shared/checkpoint.js";
import {
  isoDateSchema, lenientBoolean, lenientNumber, likePattern, money, orderStatusSchema,
} from "../common.js";
import { ToolError, defineTool } from "../types.js";

/**
 * The metrics: name → SQL over `x`, the matching order lines (see buildSql).
 * COALESCE because a catalogue group with no sales has only NULLs.
 */
const METRICS = {
  units: { sql: "COALESCE(SUM(x.quantity), 0)", label: "units sold", money: false },
  revenue: { sql: "COALESCE(SUM(x.quantity * x.unit_price_cents), 0)", label: "revenue", money: true },
  gross: {
    sql: "CAST(ROUND(COALESCE(SUM(1.0 * x.quantity * x.unit_price_cents * x.total_cents / x.subtotal_cents), 0)) AS INTEGER)",
    label: "gross sales (with shipping and tax)", money: true,
  },
  orders: { sql: "COUNT(DISTINCT x.order_id)", label: "orders", money: false },
  customers: { sql: "COUNT(DISTINCT x.customer_id)", label: "customers", money: false },
  avg_order_value: {
    sql: "CASE WHEN COUNT(DISTINCT x.order_id) = 0 THEN 0 ELSE " +
      "CAST(ROUND(1.0 * SUM(x.quantity * x.unit_price_cents) / COUNT(DISTINCT x.order_id)) AS INTEGER) END",
    label: "average order value", money: true,
  },
} as const;

/**
 * The groupings: name → key, human label, GROUP BY, and which query shape.
 * `catalogue` groupings include products with no matching sales; `time`
 * groupings are listed in date order rather than ranked.
 */
const GROUPINGS = {
  product: { key: "p.sku", label: "p.name", group: "p.id", catalogue: true, time: false },
  category: { key: "p.category", label: "p.category", group: "p.category", catalogue: true, time: false },
  brand: { key: "p.brand", label: "p.brand", group: "p.brand", catalogue: true, time: false },
  customer: { key: "CAST(c.id AS TEXT)", label: "c.first_name || ' ' || c.last_name", group: "c.id", catalogue: false, time: false },
  state: { key: "a.state", label: "a.state", group: "a.state", catalogue: false, time: false },
  status: { key: "x.status", label: "x.status", group: "x.status", catalogue: false, time: false },
  week: { key: "strftime('%Y-W%W', x.placed_at)", label: "strftime('%Y-W%W', x.placed_at)", group: "1", catalogue: false, time: true },
  month: { key: "strftime('%Y-%m', x.placed_at)", label: "strftime('%Y-%m', x.placed_at)", group: "1", catalogue: false, time: true },
  year: { key: "strftime('%Y', x.placed_at)", label: "strftime('%Y', x.placed_at)", group: "1", catalogue: false, time: true },
} as const;

type MetricName = keyof typeof METRICS;
type GroupName = keyof typeof GROUPINGS;
const metricNames = Object.keys(METRICS) as [MetricName, ...MetricName[]];
const groupNames = Object.keys(GROUPINGS) as [GroupName, ...GroupName[]];

const outputSchema: z.ZodType<SalesReportResult> = z.object({
  metric: z.enum(metricNames),
  groupBy: z.enum(groupNames),
  rows: z.array(z.object({
    rank: z.number().int(),
    key: z.string(),
    label: z.string(),
    value: z.number(),
    units: z.number().int(),
    revenueCents: z.number().int(),
    orders: z.number().int(),
  })),
  totalGroups: z.number().int(),
  filters: z.object({
    fromDate: z.string().nullable(),
    toDate: z.string().nullable(),
    category: z.string().nullable(),
    status: z.string().nullable(),
    lowest: z.boolean(),
  }),
});

interface Row {
  key: string; label: string; value: number; units: number; revenue_cents: number; orders: number; total: number;
}

/**
 * Builds the statement. Everything interpolated comes from METRICS and
 * GROUPINGS above; everything the caller supplied is a :named parameter.
 *
 * `x` is the matching order lines with their orders' columns, filtered by
 * status and date. Catalogue groupings LEFT JOIN it to products (so zero-
 * sales products survive); the others start from it.
 */
function buildSql(metric: MetricName, groupBy: GroupName, lowest: boolean): string {
  const m = METRICS[metric];
  const g = GROUPINGS[groupBy];
  // Grouping by status shows every status unless one is asked for;
  // otherwise cancelled orders are left out by default.
  const statusRule = groupBy === "status"
    ? "(:status IS NULL OR o.status = :status)"
    : "(CASE WHEN :status IS NULL THEN o.status <> 'cancelled' ELSE o.status = :status END)";
  const lines = `
      SELECT i.product_id, i.quantity, i.unit_price_cents,
             o.id AS order_id, o.customer_id, o.placed_at, o.status, o.shipping_address_id,
             o.subtotal_cents, o.total_cents
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE ${statusRule}
        AND (:from IS NULL OR o.placed_at >= :from)
        AND (:to IS NULL OR o.placed_at < date(:to, '+1 day'))`;

  const from = g.catalogue
    ? `FROM products p
       LEFT JOIN (${lines}) x ON x.product_id = p.id
       WHERE (:category IS NULL OR p.category LIKE :category ESCAPE '\\')
         AND (p.discontinued = 0 OR x.product_id IS NOT NULL)`
    : `FROM (${lines}) x
       JOIN products p ON p.id = x.product_id
       JOIN customers c ON c.id = x.customer_id
       JOIN addresses a ON a.id = x.shipping_address_id
       WHERE (:category IS NULL OR p.category LIKE :category ESCAPE '\\')`;

  const order = g.time ? "key DESC" : `value ${lowest ? "ASC" : "DESC"}, key`;
  return `
    SELECT ${g.key} AS key,
           ${g.label} AS label,
           ${m.sql} AS value,
           COALESCE(SUM(x.quantity), 0) AS units,
           COALESCE(SUM(x.quantity * x.unit_price_cents), 0) AS revenue_cents,
           COUNT(DISTINCT x.order_id) AS orders,
           COUNT(*) OVER () AS total
    ${from}
    GROUP BY ${g.group}
    ORDER BY ${order}
    LIMIT :limit`;
}

export const salesReport = defineTool({
  name: "sales_report",
  title: "Sales report",

  description:
    "Summarises Checkpoint Outfitters sales: choose a metric (units, revenue, gross, orders, " +
    "customers, avg_order_value) and what to group by (product, category, brand, customer, " +
    "state, status, week, month, year), with optional date range, category and order status. " +
    "Ranked highest first (set lowest for worst sellers — products with no sales are included); " +
    "weeks, months and years are listed in date order. Use it for best or worst sellers, top " +
    "products by revenue, sales over time, best customers by spend, orders per status, and " +
    "similar totals. Cancelled orders are excluded unless status asks for them. Not for one " +
    "order's lines (use get_order) or searching the catalogue (use find_products).",

  inputSchema: z.object({
    metric: z.enum(metricNames)
      .describe("What to measure: units (units sold), revenue (sales before tax and shipping), gross (sales including shipping and tax), orders (number of orders), customers (number of distinct buyers), avg_order_value."),
    group_by: z.enum(groupNames)
      .describe("What to break it down by: product, category, brand, customer, state (shipping state), status (order status), week, month or year."),
    from_date: isoDateSchema.optional()
      .describe("Only orders placed on or after this date, YYYY-MM-DD."),
    to_date: isoDateSchema.optional()
      .describe("Only orders placed on or before this date, YYYY-MM-DD."),
    category: z.string().trim().optional()
      .describe("Only products in this category (all or part of the name), e.g. \"Trail shoes\"."),
    status: orderStatusSchema.optional()
      .describe("Only orders with this status. Leave out to include every status except cancelled."),
    lowest: lenientBoolean(z.boolean()).default(false)
      .describe("Rank lowest first, for worst sellers. Defaults to false (highest first)."),
    limit: lenientNumber(z.number().int().min(1).max(20)).default(10)
      .describe("How many groups to return, 1 to 20. Defaults to 10."),
  }),

  outputSchema,

  run(input, db) {
    if (input.from_date && input.to_date && input.from_date > input.to_date) {
      throw new ToolError(`from_date ${input.from_date} is after to_date ${input.to_date}.`);
    }
    const category = input.category ? input.category : null; // "" counts as absent
    const g = GROUPINGS[input.group_by];

    const raw = db.all<Row>(buildSql(input.metric, input.group_by, input.lowest), {
      status: input.status ?? null,
      from: input.from_date ?? null,
      to: input.to_date ?? null,
      category: category ? likePattern(category) : null,
      limit: input.limit,
    });
    // Time periods came back newest first (to keep the newest `limit`); show them oldest first.
    const ordered = g.time ? [...raw].reverse() : raw;

    const rows: SalesReportRow[] = ordered.map((r, i) => ({
      rank: i + 1, key: String(r.key), label: String(r.label), value: r.value,
      units: r.units, revenueCents: r.revenue_cents, orders: r.orders,
    }));
    const data: SalesReportResult = {
      metric: input.metric,
      groupBy: input.group_by,
      rows,
      totalGroups: raw[0]?.total ?? 0,
      filters: {
        fromDate: input.from_date ?? null, toDate: input.to_date ?? null,
        category, status: input.status ?? null, lowest: input.lowest,
      },
    };

    const m = METRICS[input.metric];
    const fmt = (v: number) => (m.money ? money(v) : String(v));
    const statusScope = input.status ? `status ${input.status}`
      : input.group_by === "status" ? "every status" : "cancelled orders excluded";
    const scope = [
      category && `in "${category}"`,
      statusScope,
      input.from_date && `from ${input.from_date}`,
      input.to_date && `to ${input.to_date}`,
    ].filter(Boolean).join(", ");
    const heading = `${m.label[0]?.toUpperCase()}${m.label.slice(1)} by ${input.group_by}` +
      (g.time ? " (oldest first)" : input.lowest ? " (lowest first)" : " (highest first)") +
      ` — ${scope}`;

    if (rows.length === 0) return { data, summary: `${heading}: no sales match.` };

    // The other figures, without repeating the one already shown — every
    // token counts in a small context window.
    const others = (r: SalesReportRow) => [
      input.metric !== "units" && `${r.units} units`,
      input.metric !== "orders" && `${r.orders} orders`,
      input.metric !== "revenue" && `${money(r.revenueCents)} revenue`,
    ].filter(Boolean).join(", ");

    // The whole report goes to the model: at most 20 short lines, and a
    // "top 10" question needs all ten.
    return {
      data,
      summary:
        `${heading}. ${rows.length} of ${data.totalGroups} ${g.time ? "periods" : "groups"}` +
        `${g.catalogue ? " (products with no sales included)" : ""}:\n` +
        rows.map((r) =>
          `${g.time ? "-" : `${r.rank}.`} ${r.label}${input.group_by === "product" ? ` (${r.key})` : ""}` +
          `${input.group_by === "customer" ? ` (customer #${r.key})` : ""} — ${fmt(r.value)}` +
          ` (${others(r)})`,
        ).join("\n"),
    };
  },
});
