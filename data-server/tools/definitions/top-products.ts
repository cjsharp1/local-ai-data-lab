/**
 * top-products.ts — best sellers: products ranked by units sold.
 *
 * Added after a real question failed. "What are the 10 most popular
 * products?" is plainly in scope, but none of the first six tools could
 * answer it: find_products knows nothing about sales, and get_product
 * gives one product's figures at a time. The model saw that — its draft
 * began "To determine the most popular selling products, I need to see
 * which products have been sold the most…" — and, with no honest way to
 * say "I can't", the reply came out as an off-topic refusal.
 *
 * The fix for a capability gap is what registry.ts says it should be: one
 * more NARROW tool, not a general one. This answers exactly one kind of
 * question — a ranking — with a fixed query, a 20-row cap and bound
 * parameters. It does not open the door to arbitrary aggregation.
 *
 * Ranked by units sold, then by revenue, over orders that were not
 * cancelled. Revenue is what the units were SOLD for (the order_items
 * price snapshots), not units × today's price. Discontinued products are
 * included and flagged: they really did sell, and "what used to sell
 * well" is a fair question.
 */

import { z } from "zod";
import type { TopProductRow, TopProductsResult } from "../../../shared/checkpoint.js";
import { isoDateSchema, lenientNumber, likePattern, money } from "../common.js";
import { ToolError, defineTool } from "../types.js";

const outputSchema: z.ZodType<TopProductsResult> = z.object({
  products: z.array(z.object({
    rank: z.number().int(),
    sku: z.string(),
    name: z.string(),
    category: z.string(),
    brand: z.string(),
    discontinued: z.boolean(),
    unitsSold: z.number().int(),
    orderCount: z.number().int(),
    revenueCents: z.number().int(),
  })),
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
  category: z.string().nullable(),
});

interface Row {
  sku: string; name: string; category: string; brand: string; discontinued: number;
  units_sold: number; order_count: number; revenue_cents: number;
}

/** Fixed SQL; each filter switched off by binding NULL (see list-orders.ts). */
const SQL = `
  SELECT p.sku, p.name, p.category, p.brand, p.discontinued,
         SUM(i.quantity) AS units_sold,
         COUNT(DISTINCT o.id) AS order_count,
         SUM(i.quantity * i.unit_price_cents) AS revenue_cents
  FROM order_items i
  JOIN orders o ON o.id = i.order_id
  JOIN products p ON p.id = i.product_id
  WHERE o.status <> 'cancelled'
    AND (:from IS NULL OR o.placed_at >= :from)
    AND (:to IS NULL OR o.placed_at < date(:to, '+1 day'))
    AND (:category IS NULL OR p.category LIKE :category ESCAPE '\\')
  GROUP BY p.id
  ORDER BY units_sold DESC, revenue_cents DESC, p.sku
  LIMIT :limit`;

export const topProducts = defineTool({
  name: "top_products",
  title: "Top products",

  description:
    "Ranks Checkpoint Outfitters products by how many units sold (most first), " +
    "with order count and revenue. Use it for best sellers, most popular or top " +
    "products, optionally within a date range or a category. Cancelled orders " +
    "are not counted. Not for searching the catalogue (use find_products) or one " +
    "product's details (use get_product).",

  inputSchema: z.object({
    limit: lenientNumber(z.number().int().min(1).max(20)).default(10)
      .describe("How many products to return, 1 to 20. Defaults to 10."),
    from_date: isoDateSchema.optional()
      .describe("Only count orders placed on or after this date, YYYY-MM-DD."),
    to_date: isoDateSchema.optional()
      .describe("Only count orders placed on or before this date, YYYY-MM-DD."),
    category: z.string().trim().optional()
      .describe("Only products in this category (all or part of the name), e.g. \"Trail shoes\"."),
  }),

  outputSchema,

  run(input, db) {
    if (input.from_date && input.to_date && input.from_date > input.to_date) {
      throw new ToolError(`from_date ${input.from_date} is after to_date ${input.to_date}.`);
    }
    const category = input.category ? input.category : null; // "" counts as absent

    const rows = db.all<Row>(SQL, {
      from: input.from_date ?? null,
      to: input.to_date ?? null,
      category: category ? likePattern(category) : null,
      limit: input.limit,
    });

    const products: TopProductRow[] = rows.map((r, i) => ({
      rank: i + 1,
      sku: r.sku, name: r.name, category: r.category, brand: r.brand,
      discontinued: r.discontinued === 1,
      unitsSold: r.units_sold, orderCount: r.order_count, revenueCents: r.revenue_cents,
    }));
    const data: TopProductsResult = {
      products,
      fromDate: input.from_date ?? null,
      toDate: input.to_date ?? null,
      category,
    };

    const scope = [
      category && `in "${category}"`,
      input.from_date && `from ${input.from_date}`,
      input.to_date && `to ${input.to_date}`,
    ].filter(Boolean).join(", ");

    if (products.length === 0) {
      return { data, summary: `No sales${scope ? ` ${scope}` : ""}.` };
    }

    // The whole ranking goes to the model: at most 20 short lines, and a
    // "top 10" question needs all ten.
    return {
      data,
      summary:
        `Top ${products.length} products by units sold${scope ? ` ${scope}` : ""} (cancelled orders excluded):\n` +
        products.map((p) =>
          `${p.rank}. ${p.name} (${p.sku}) — ${p.unitsSold} units in ${p.orderCount} orders, ${money(p.revenueCents)}` +
          (p.discontinued ? " [discontinued]" : ""),
        ).join("\n"),
    };
  },
});
