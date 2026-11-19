/**
 * find-products.ts — search the catalogue: filter by anything a product has,
 * sort by anything worth ranking.
 *
 *   words        query (name, brand or description), category, brand, colour
 *   ranges       price (US dollars), weight (grams)
 *   availability for sale (default), discontinued, or all
 *   sales        never sold, sold since a date, not sold since a date,
 *                at least N units
 *   sort         category (default) · name · price · weight · units_sold ·
 *                last_sold — highest first, or lowest_first
 *
 * So one tool answers "the cheapest headlamp", "packs under 500 g",
 * "orange gear under $50", "what's never sold", "what hasn't sold since
 * summer", "our heaviest paddles", "discontinued shoes".
 *
 * ---------------------------------------------------------------------------
 * Why this tool grew instead of a new one appearing
 * ---------------------------------------------------------------------------
 *
 * customer_segment and sales_report were added for customer and sales
 * questions. For products the catalogue search already existed — it just
 * could not sort, and knew nothing about weight, colour or sales. Making
 * it flexible beats adding a ninth tool: every extra tool is one more
 * choice a 4B model can get wrong. Totals and revenue rankings stay with
 * sales_report; this tool finds and orders PRODUCTS.
 *
 * ---------------------------------------------------------------------------
 * Small-model decisions, kept from the first version
 * ---------------------------------------------------------------------------
 *
 *   Prices are in DOLLARS. A model asked for "under $100" sends 100.
 *   Category, brand and colour match loosely ("shoes", "orange").
 *   An EMPTY filter counts as no filter: models send `"query": ""` to
 *   mean "anything", and a min-length error once sent one into a loop.
 *   Browsing the catalogue is harmless, so no filter is required —
 *   unlike customer_segment, where that is a deliberate defence.
 *
 * The SQL is fixed text with each filter switched off by binding NULL,
 * like list_orders; only ORDER BY varies, chosen from SORTS by enum.
 */

import { z } from "zod";
import type { ProductMatch, ProductSearchResult } from "../../../shared/checkpoint.js";
import {
  SUMMARY_ROWS, andMore, day, isoDateSchema, lenientBoolean, lenientNumber, likePattern, money,
} from "../common.js";
import { ToolError, defineTool } from "../types.js";

/** Sort keys → ORDER BY, highest-first and lowest-first. Written here; chosen by enum. */
const SORTS = {
  category: { desc: "category, price_cents, sku", asc: "category, price_cents, sku" },
  name: { desc: "name", asc: "name" },
  price: { desc: "price_cents DESC, sku", asc: "price_cents ASC, sku" },
  weight: { desc: "weight_grams DESC, sku", asc: "weight_grams ASC, sku" },
  units_sold: { desc: "units_sold DESC, sku", asc: "units_sold ASC, sku" },
  last_sold: { desc: "last_sold DESC NULLS LAST, sku", asc: "last_sold ASC NULLS FIRST, sku" },
} as const;
type SortKey = keyof typeof SORTS;
const sortKeys = Object.keys(SORTS) as [SortKey, ...SortKey[]];

const outputSchema: z.ZodType<ProductSearchResult> = z.object({
  products: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    category: z.string(),
    brand: z.string(),
    priceCents: z.number().int(),
    discontinued: z.boolean(),
    weightGrams: z.number().int(),
    color: z.string(),
    unitsSold: z.number().int(),
    lastSoldAt: z.string().nullable(),
  })),
  total: z.number().int(),
  sortBy: z.string(),
  lowestFirst: z.boolean(),
  availability: z.enum(["for_sale", "discontinued", "all"]),
});

interface Row {
  sku: string; name: string; category: string; brand: string; price_cents: number; discontinued: number;
  weight_grams: number; color: string; units_sold: number; last_sold: string | null; total: number;
}

/**
 * Each product with its sales figures (the CTE: units on orders that were
 * not cancelled, and the last such order), then the filters.
 */
function buildSql(sort: SortKey, lowest: boolean): string {
  const sold = `FROM order_items i JOIN orders o ON o.id = i.order_id
                WHERE i.product_id = p.id AND o.status <> 'cancelled'`;
  return `
    WITH s AS (
      SELECT p.sku, p.name, p.category, p.brand, p.price_cents, p.discontinued,
             p.weight_grams, p.color, p.description,
             COALESCE((SELECT SUM(i.quantity) ${sold}), 0) AS units_sold,
             (SELECT MAX(o.placed_at) ${sold}) AS last_sold
      FROM products p
    )
    SELECT sku, name, category, brand, price_cents, discontinued, weight_grams, color,
           units_sold, last_sold, COUNT(*) OVER () AS total
    FROM s
    WHERE (:query IS NULL OR name LIKE :query ESCAPE '\\'
                          OR brand LIKE :query ESCAPE '\\'
                          OR description LIKE :query ESCAPE '\\')
      AND (:category IS NULL OR category LIKE :category ESCAPE '\\')
      AND (:brand IS NULL OR brand LIKE :brand ESCAPE '\\')
      AND (:color IS NULL OR color LIKE :color ESCAPE '\\')
      AND (:min_cents IS NULL OR price_cents >= :min_cents)
      AND (:max_cents IS NULL OR price_cents <= :max_cents)
      AND (:min_weight IS NULL OR weight_grams >= :min_weight)
      AND (:max_weight IS NULL OR weight_grams <= :max_weight)
      AND (CASE :availability WHEN 'for_sale' THEN discontinued = 0
                              WHEN 'discontinued' THEN discontinued = 1
                              ELSE 1 END)
      AND (:never_sold = 0 OR units_sold = 0)
      AND (:sold_since IS NULL OR last_sold >= :sold_since)
      AND (:not_sold_since IS NULL OR last_sold IS NULL OR last_sold < :not_sold_since)
      AND (:min_units IS NULL OR units_sold >= :min_units)
    ORDER BY ${SORTS[sort][lowest ? "asc" : "desc"]}
    LIMIT :limit`;
}

export const findProducts = defineTool({
  name: "find_products",
  title: "Find products",

  description:
    "Searches the Checkpoint Outfitters catalogue. Filter by words (name, brand, description), " +
    "category, brand, colour, price range in US dollars, weight range in grams, availability " +
    "(for_sale by default, discontinued, or all) and sales history (never sold, sold since, not " +
    "sold since, at least N units). Sort by category, name, price, weight, units_sold or " +
    "last_sold; highest first unless lowest_first (e.g. cheapest = sort_by price, lowest_first " +
    "true). Categories: Trail shoes, Packs & hydration, Headlamps & lighting, Navigation, Paddle, " +
    "Bike, Apparel, Nutrition, Mandatory kit & safety. Not for one product's full details " +
    "(use get_product) or revenue and grouped sales totals (use sales_report).",

  inputSchema: z.object({
    query: z.string().trim().optional()
      .describe("A word or short phrase to find in the product name, brand or description, e.g. \"headlamp\"."),
    category: z.string().trim().optional().describe("All or part of a category name, e.g. \"Trail shoes\" or \"paddle\"."),
    brand: z.string().trim().optional().describe("All or part of a brand name, e.g. \"Switchfell\"."),
    color: z.string().trim().optional().describe("Colour, e.g. \"Orange\"."),
    min_price: lenientNumber(z.number().min(0)).optional().describe("Lowest price in US DOLLARS."),
    max_price: lenientNumber(z.number().positive()).optional().describe("Highest price in US DOLLARS, e.g. 100."),
    min_weight: lenientNumber(z.number().min(0)).optional().describe("Lowest weight in grams."),
    max_weight: lenientNumber(z.number().positive()).optional().describe("Highest weight in grams, e.g. 500."),
    availability: z.enum(["for_sale", "discontinued", "all"]).default("for_sale")
      .describe("for_sale (default) hides discontinued products; discontinued shows only those; all shows both."),
    never_sold: lenientBoolean(z.boolean()).default(false).describe("Only products that have never been sold."),
    sold_since: isoDateSchema.optional().describe("Only products sold on or after this date, YYYY-MM-DD."),
    not_sold_since: isoDateSchema.optional()
      .describe("Only products NOT sold on or after this date (includes never sold), YYYY-MM-DD."),
    min_units_sold: lenientNumber(z.number().int().min(0)).optional().describe("Only products with at least this many units sold."),
    sort_by: z.enum(sortKeys).default("category")
      .describe("Order by category (default), name, price, weight, units_sold or last_sold."),
    lowest_first: lenientBoolean(z.boolean()).default(false)
      .describe("Lowest first: cheapest, lightest, fewest sold, longest since sold. Defaults to false."),
    limit: lenientNumber(z.number().int().min(1).max(50)).default(20)
      .describe("Most products to return, 1 to 50. Defaults to 20."),
  }),

  outputSchema,

  run(input, db) {
    if (input.min_price !== undefined && input.max_price !== undefined && input.min_price > input.max_price) {
      throw new ToolError(`min_price ${input.min_price} is above max_price ${input.max_price}.`);
    }
    if (input.min_weight !== undefined && input.max_weight !== undefined && input.min_weight > input.max_weight) {
      throw new ToolError(`min_weight ${input.min_weight} is above max_weight ${input.max_weight}.`);
    }
    const text = (v: string | undefined) => (v ? likePattern(v) : null); // "" counts as absent
    // Dollars in, cents out. Math.round, because 19.99 * 100 is
    // 1998.9999999999998 in floating point — the reason the database
    // stores cents in the first place.
    const cents = (v: number | undefined) => (v !== undefined ? Math.round(v * 100) : null);

    const rows = db.all<Row>(buildSql(input.sort_by, input.lowest_first), {
      query: text(input.query),
      category: text(input.category),
      brand: text(input.brand),
      color: text(input.color),
      min_cents: cents(input.min_price),
      max_cents: cents(input.max_price),
      min_weight: input.min_weight ?? null,
      max_weight: input.max_weight ?? null,
      availability: input.availability,
      never_sold: input.never_sold ? 1 : 0,
      sold_since: input.sold_since ?? null,
      not_sold_since: input.not_sold_since ?? null,
      min_units: input.min_units_sold ?? null,
      limit: input.limit,
    });

    const products: ProductMatch[] = rows.map((r) => ({
      sku: r.sku, name: r.name, category: r.category, brand: r.brand,
      priceCents: r.price_cents, discontinued: r.discontinued === 1,
      weightGrams: r.weight_grams, color: r.color, unitsSold: r.units_sold, lastSoldAt: r.last_sold,
    }));
    const total = rows[0]?.total ?? 0;
    const data: ProductSearchResult = {
      products, total, sortBy: input.sort_by, lowestFirst: input.lowest_first, availability: input.availability,
    };

    const hidden = input.availability === "for_sale" ? " Discontinued products were not included." : "";
    if (total === 0) {
      return { data, summary: `No products match. Try fewer or broader filters.${hidden}` };
    }

    // Up to ten lines: product rows are short, and "the five cheapest
    // headlamps" should not need a second call.
    const shown = products.slice(0, Math.max(SUMMARY_ROWS, 10));
    const order = input.sort_by === "category" ? "" :
      ` Sorted by ${input.sort_by.replace("_", " ")}${input.lowest_first ? ", lowest first" : ", highest first"}.`;
    return {
      data,
      summary:
        `${total} product${total === 1 ? "" : "s"} match.${order}${hidden}\n` +
        shown.map((p) =>
          `- ${p.sku} ${p.name} — ${p.category}, ${money(p.priceCents)}, ${p.weightGrams} g, ${p.color}, ` +
          `${p.unitsSold} sold${p.lastSoldAt ? ` (last ${day(p.lastSoldAt)})` : " (never)"}` +
          (p.discontinued ? " [discontinued]" : ""),
        ).join("\n") +
        andMore(shown.length, products.length, total),
    };
  },
});
