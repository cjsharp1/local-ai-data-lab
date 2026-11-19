/**
 * product-table.ts — rep screen view for find_products: a catalogue table.
 *
 * SKU, name, category, price, weight, colour, units sold and last sale for
 * every product the search returned, discontinued ones tagged. The heading
 * says how it is sorted, so "cheapest first" or "fewest sold first" is
 * visible rather than implied. Each SKU opens the product card
 * (get_product, called directly).
 */

import { day, el, money } from "../../dom.js";
import type { ProductSearchResult, ScreenContext } from "../../types.js";
import { discontinuedTag, link } from "./parts.js";

export function renderProductTable(data: ProductSearchResult, ctx: ScreenContext): HTMLElement {
  const sort = data.sortBy === "category" ? "by category"
    : `by ${data.sortBy.replace("_", " ")}, ${data.lowestFirst ? "lowest first" : "highest first"}`;
  const availability = data.availability === "for_sale" ? "for sale" : data.availability === "all" ? "including discontinued" : "discontinued only";
  const heading = el("p", { class: "screen-count", text:
    `${data.total} product${data.total === 1 ? "" : "s"} · ${availability} · sorted ${sort}` +
    (data.products.length < data.total ? ` · showing ${data.products.length}` : "") });

  if (data.products.length === 0) {
    return el("div", {}, [heading, el("p", { class: "screen-empty-note", text: "No products match." })]);
  }

  const rows = data.products.map((p) =>
    el("tr", {}, [
      el("td", {}, [link(p.sku, () => ctx.open("get_product", { sku: p.sku }))]),
      el("td", {}, [p.name, p.discontinued ? " " : "", p.discontinued ? discontinuedTag() : ""]),
      el("td", { text: p.category }),
      el("td", { class: "num", text: money(p.priceCents) }),
      el("td", { class: "num", text: `${p.weightGrams} g` }),
      el("td", { text: p.color }),
      el("td", { class: "num", text: String(p.unitsSold) }),
      el("td", { text: p.lastSoldAt ? day(p.lastSoldAt) : "never" }),
    ]),
  );

  return el("div", {}, [
    heading,
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, ["SKU", "Product", "Category", "Price", "Weight", "Colour", "Sold", "Last sold"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}
