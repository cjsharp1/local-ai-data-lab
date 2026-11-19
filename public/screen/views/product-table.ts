/**
 * product-table.ts — rep screen view for find_products: a catalogue table.
 *
 * SKU, name, category, brand and price for every product the search
 * returned, discontinued ones tagged. Each SKU opens the product card
 * (get_product, called directly).
 */

import { el, money } from "../../dom.js";
import type { ProductSearchResult, ScreenContext } from "../../types.js";
import { discontinuedTag, link } from "./parts.js";

export function renderProductTable(data: ProductSearchResult, ctx: ScreenContext): HTMLElement {
  if (data.products.length === 0) {
    return el("p", { class: "screen-empty-note", text: "No products match." });
  }

  const rows = data.products.map((p) =>
    el("tr", {}, [
      el("td", {}, [link(p.sku, () => ctx.open("get_product", { sku: p.sku }))]),
      el("td", {}, [p.name, p.discontinued ? " " : "", p.discontinued ? discontinuedTag() : ""]),
      el("td", { text: p.category }),
      el("td", { text: p.brand }),
      el("td", { class: "num", text: money(p.priceCents) }),
    ]),
  );

  return el("div", {}, [
    el("p", { class: "screen-count", text:
      `${data.total} product${data.total === 1 ? "" : "s"}` +
      (data.products.length < data.total ? ` — showing ${data.products.length}` : "") }),
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, ["SKU", "Product", "Category", "Brand", "Price"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}
