/**
 * sales-report.ts — one tool for a whole family of sales questions.
 *
 * Pick a METRIC, a GROUPING and optional FILTERS:
 *
 *   metric     units · revenue · orders · avg_order_value
 *   group_by   product · category · brand · customer · month · state
 *   filters    from_date, to_date, category, status; lowest-first; limit ≤ 20
 *
 * and it answers "top products by revenue", "revenue by month", "best
 * customers by spend", "units by category in October", "which states
 * order most", "worst-selling brands" — dozens of questions, one tool.
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
 * Definitions worth knowing, because they are choices:
 *   revenue          what the lines sold for — quantity × the price
 *                    snapshot — before tax and shipping
 *   avg_order_value  revenue ÷ distinct orders, in cents, rounded
 *   cancelled        excluded unless `status` asks for them; returned
 *                    orders count (they sold, then came back)
 *   state            the order's SHIPPING address, not the billing one
 */

import { z } from "zod";
import type { SalesReportResult, SalesReportRow } from "../../../shared/checkpoint.js";
import {
  isoDateSchema, lenientBoolean, lenientNumber, likePattern, money, orderStatusSchema,
} from "../common.js";
import { ToolError, defineTool } from "../types.js";

/** The metrics: name → SQL expression over the joined rows. */
const METRICS = {
  units: { sql: "SUM(i.quantity)", label: "units sold", money: false },
  revenue: { sql: "SUM(i.quantity * i.unit_price_cents)", label: "revenue", money: true },
  orders: { sql: "COUNT(DISTINCT o.id)", label: "orders", money: false },
  avg_order_value: {
    sql: "CAST(ROUND(1.0 * SUM(i.quantity * i.unit_price_cents) / COUNT(DISTINCT o.id)) AS INTEGER)",
    label: "average order value", money: true,
  },
} as const;

/** The groupings: name → the key, the human label, and what to GROUP BY. */
const GROUPINGS = {
  product: { key: "p.sku", label: "p.name", group: "p.id" },
  category: { key: "p.category", label: "p.category", group: "p.category" },
  brand: { key: "p.brand", label: "p.brand", group: "p.brand" },
  customer: { key: "CAST(c.id AS TEXT)", label: "c.first_name || ' ' || c.last_name", group: "c.id" },
  month: { key: "strftime('%Y-%m', o.placed_at)", label: "strftime('%Y-%m', o.placed_at)", group: "1" },
  state: { key: "a.state", label: "a.state", group: "a.state" },
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
 * Builds the statement from the two chosen map entries. Everything
 * interpolated here comes from METRICS / GROUPINGS above; everything the
 * caller supplied is a :named parameter.
 *
 * Months are listed in date order (newest `limit` months, oldest first) —
 * "revenue by month" is a timeline, not a ranking. Everything else is
 * ranked by the metric.
 */
function buildSql(metric: MetricName, groupBy: GroupName, lowest: boolean): string {
  const m = METRICS[metric];
  const g = GROUPINGS[groupBy];
  const order = groupBy === "month" ? "key DESC" : `value ${lowest ? "ASC" : "DESC"}, key`;
  return `
    SELECT ${g.key} AS key,
           ${g.label} AS label,
           ${m.sql} AS value,
           SUM(i.quantity) AS units,
           SUM(i.quantity * i.unit_price_cents) AS revenue_cents,
           COUNT(DISTINCT o.id) AS orders,
           COUNT(*) OVER () AS total
    FROM order_items i
    JOIN orders o ON o.id = i.order_id
    JOIN products p ON p.id = i.product_id
    JOIN customers c ON c.id = o.customer_id
    JOIN addresses a ON a.id = o.shipping_address_id
    WHERE (CASE WHEN :status IS NULL THEN o.status <> 'cancelled' ELSE o.status = :status END)
      AND (:from IS NULL OR o.placed_at >= :from)
      AND (:to IS NULL OR o.placed_at < date(:to, '+1 day'))
      AND (:category IS NULL OR p.category LIKE :category ESCAPE '\\')
    GROUP BY ${g.group}
    ORDER BY ${order}
    LIMIT :limit`;
}

export const salesReport = defineTool({
  name: "sales_report",
  title: "Sales report",

  description:
    "Summarises Checkpoint Outfitters sales: choose a metric (units, revenue, orders, " +
    "avg_order_value) and what to group by (product, category, brand, customer, month, " +
    "state), with optional date range, category and order status. Ranked highest first " +
    "(set lowest for worst sellers); months are listed in date order. Use it for best " +
    "sellers, top products by revenue, sales by month or category, best customers by " +
    "spend, and similar totals. Cancelled orders are excluded unless status asks for them. " +
    "Not for one order's lines (use get_order) or searching the catalogue (use find_products).",

  inputSchema: z.object({
    metric: z.enum(metricNames)
      .describe("What to measure: units (units sold), revenue (sales before tax and shipping), orders (number of orders), avg_order_value."),
    group_by: z.enum(groupNames)
      .describe("What to break it down by: product, category, brand, customer, month, or state (shipping state)."),
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

    const raw = db.all<Row>(buildSql(input.metric, input.group_by, input.lowest), {
      status: input.status ?? null,
      from: input.from_date ?? null,
      to: input.to_date ?? null,
      category: category ? likePattern(category) : null,
      limit: input.limit,
    });
    // Months came back newest first (to keep the newest `limit`); show them oldest first.
    const ordered = input.group_by === "month" ? [...raw].reverse() : raw;

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
    const scope = [
      category && `in "${category}"`,
      input.status ? `status ${input.status}` : "cancelled orders excluded",
      input.from_date && `from ${input.from_date}`,
      input.to_date && `to ${input.to_date}`,
    ].filter(Boolean).join(", ");
    const heading = `${m.label[0]?.toUpperCase()}${m.label.slice(1)} by ${input.group_by}` +
      (input.group_by === "month" ? " (oldest first)" : input.lowest ? " (lowest first)" : " (highest first)") +
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
        `${heading}. ${rows.length} of ${data.totalGroups} ${input.group_by === "month" ? "months" : "groups"}:\n` +
        rows.map((r) =>
          `${input.group_by === "month" ? "-" : `${r.rank}.`} ${r.label}${input.group_by === "product" ? ` (${r.key})` : ""}` +
          `${input.group_by === "customer" ? ` (customer #${r.key})` : ""} — ${fmt(r.value)}` +
          ` (${others(r)})`,
        ).join("\n"),
    };
  },
});
