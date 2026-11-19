/**
 * top-products.ts — rep screen view for top_products: a best-seller ranking.
 *
 * Rank, product, units sold, orders and revenue, with a bar showing each
 * product's units relative to the top seller — a ranking reads faster as
 * lengths than as numbers. Each SKU opens the product card (get_product,
 * called directly). Revenue is what the units actually sold for, from the
 * order-line price snapshots.
 */

import { day, el, money } from "../../dom.js";
import type { ScreenContext, TopProductsResult } from "../../types.js";
import { discontinuedTag, link } from "./parts.js";

export function renderTopProducts(data: TopProductsResult, ctx: ScreenContext): HTMLElement {
  const scope = [
    data.category ? `in "${data.category}"` : "",
    data.fromDate ? `from ${day(data.fromDate)}` : "",
    data.toDate ? `to ${day(data.toDate)}` : "",
  ].filter(Boolean).join(" · ");

  if (data.products.length === 0) {
    return el("p", { class: "screen-empty-note", text: `No sales${scope ? ` ${scope}` : ""}.` });
  }

  const top = data.products[0]?.unitsSold || 1;
  const rows = data.products.map((p) =>
    el("tr", {}, [
      el("td", { class: "num", text: String(p.rank) }),
      el("td", {}, [link(p.sku, () => ctx.open("get_product", { sku: p.sku }))]),
      el("td", {}, [p.name, p.discontinued ? " " : "", p.discontinued ? discontinuedTag() : ""]),
      el("td", { class: "num", text: String(p.unitsSold) }),
      el("td", { class: "bar-cell" }, [
        el("span", { class: "bar", attrs: { style: `width:${Math.round((p.unitsSold / top) * 100)}%` } }),
      ]),
      el("td", { class: "num", text: String(p.orderCount) }),
      el("td", { class: "num", text: money(p.revenueCents) }),
    ]),
  );

  return el("div", {}, [
    el("p", { class: "screen-count", text: `Top ${data.products.length} by units sold${scope ? ` · ${scope}` : ""} · cancelled orders excluded` }),
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, ["#", "SKU", "Product", "Units", "", "Orders", "Revenue"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}
