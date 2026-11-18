/**
 * find-products.ts — search the catalogue by words, category, brand and price.
 *
 * Every filter is optional and they combine with AND. With none at all it
 * lists the catalogue from the top, capped by `limit`.
 *
 * Three small decisions, each made for a small model:
 *
 *   `max_price` is in DOLLARS. Everything is stored in cents, but a model
 *   asked for "under $100" will send 100, not 10000. The conversion
 *   happens here, once, rather than relying on the model to get it right.
 *
 *   `category` is matched loosely (a substring), not as an exact enum. A
 *   model will say "shoes" or "lighting", not "Trail shoes" or "Headlamps
 *   & lighting". The description lists the real names so a model can use
 *   them, and a partial name still works.
 *
 *   Discontinued products are hidden unless asked for. A rep searching
 *   the catalogue wants things that can be sold; an old order still shows
 *   its discontinued lines through get_order regardless.
 *
 * Like list_orders, the SQL is fixed text, with each filter switched off
 * by binding NULL. See that file for why.
 */

import { z } from "zod";
import type { ProductRow, ProductSearchResult } from "../../../shared/checkpoint.js";
import { SUMMARY_ROWS, andMore, lenientBoolean, lenientNumber, likePattern, money } from "../common.js";
import { defineTool } from "../types.js";

const outputSchema: z.ZodType<ProductSearchResult> = z.object({
  products: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    category: z.string(),
    brand: z.string(),
    priceCents: z.number().int(),
    discontinued: z.boolean(),
  })),
  total: z.number().int(),
});

interface Row {
  sku: string; name: string; category: string; brand: string;
  price_cents: number; discontinued: number; total: number;
}

const SQL = `
  SELECT p.sku, p.name, p.category, p.brand, p.price_cents, p.discontinued,
         COUNT(*) OVER () AS total
  FROM products p
  WHERE (:query IS NULL OR p.name LIKE :query ESCAPE '\\'
                        OR p.brand LIKE :query ESCAPE '\\'
                        OR p.description LIKE :query ESCAPE '\\')
    AND (:category IS NULL OR p.category LIKE :category ESCAPE '\\')
    AND (:brand IS NULL OR p.brand LIKE :brand ESCAPE '\\')
    AND (:max_cents IS NULL OR p.price_cents <= :max_cents)
    AND (:include_discontinued = 1 OR p.discontinued = 0)
  ORDER BY p.category, p.price_cents, p.sku
  LIMIT :limit`;

export const findProducts = defineTool({
  name: "find_products",
  title: "Find products",

  description:
    "Searches the Checkpoint Outfitters product catalogue and returns matching " +
    "products with SKU, name, category, brand and price. All filters are " +
    "optional. Categories: Trail shoes, Packs & hydration, Headlamps & lighting, " +
    "Navigation, Paddle, Bike, Apparel, Nutrition, Mandatory kit & safety. " +
    "Discontinued products are left out unless include_discontinued is true. " +
    "Not for one product's full details or sales (use get_product).",

  inputSchema: z.object({
    query: z.string().trim().min(1).optional()
      .describe("A word or short phrase to find in the product name, brand or description, e.g. \"headlamp\" or \"waterproof\"."),
    category: z.string().trim().min(1).optional()
      .describe("All or part of a category name, e.g. \"Trail shoes\" or \"paddle\"."),
    brand: z.string().trim().min(1).optional()
      .describe("All or part of a brand name, e.g. \"Switchfell\"."),
    max_price: lenientNumber(z.number().positive()).optional()
      .describe("Highest price in US DOLLARS, e.g. 100 for products up to $100."),
    include_discontinued: lenientBoolean(z.boolean()).default(false)
      .describe("Include products no longer sold. Defaults to false."),
    limit: lenientNumber(z.number().int().min(1).max(50)).default(20)
      .describe("Most products to return, 1 to 50. Defaults to 20."),
  }),

  outputSchema,

  run(input, db) {
    const rows = db.all<Row>(SQL, {
      query: input.query ? likePattern(input.query) : null,
      category: input.category ? likePattern(input.category) : null,
      brand: input.brand ? likePattern(input.brand) : null,
      // Dollars in, cents out. Math.round, because 19.99 * 100 is
      // 1998.9999999999998 in floating point — the reason the database
      // stores cents in the first place.
      max_cents: input.max_price !== undefined ? Math.round(input.max_price * 100) : null,
      include_discontinued: input.include_discontinued ? 1 : 0,
      limit: input.limit,
    });

    const products: ProductRow[] = rows.map((r) => ({
      sku: r.sku, name: r.name, category: r.category, brand: r.brand,
      priceCents: r.price_cents, discontinued: r.discontinued === 1,
    }));
    const total = rows[0]?.total ?? 0;
    const data: ProductSearchResult = { products, total };

    if (total === 0) {
      return {
        data,
        summary: "No products match. Try a shorter query, a broader category, or fewer filters." +
          (input.include_discontinued ? "" : " Discontinued products were not included."),
      };
    }

    const shown = products.slice(0, SUMMARY_ROWS);
    return {
      data,
      summary:
        `${total} product${total === 1 ? "" : "s"} match:\n` +
        shown.map((p) =>
          `- ${p.sku} ${p.name} — ${p.category}, ${money(p.priceCents)}` +
          (p.discontinued ? " [discontinued]" : ""),
        ).join("\n") +
        andMore(shown.length, total),
    };
  },
});
