/**
 * order.ts — rep screen view for get_order: one order in full.
 *
 * Header (number, status, date, customer), where it shipped, every line,
 * and the totals. Each SKU opens its product; the customer's name opens
 * their card.
 *
 * Two details worth seeing:
 *
 *   A line whose price paid differs from today's price shows both — the
 *   order_items snapshot is what was charged, and some older orders here
 *   deliberately paid less than the current price.
 *
 *   A discontinued product still appears on the old orders that bought
 *   it, tagged. Taking a product off sale does not rewrite history.
 *
 * The seeded seven-line order (CP-10266) is longer than the model's
 * five-line summary: the screen shows all seven.
 */

import { day, el, money } from "../../dom.js";
import type { OrderDetail, ScreenContext } from "../../types.js";
import { addressBlock, discontinuedTag, field, link, statusPill } from "./parts.js";

export function renderOrder(o: OrderDetail, ctx: ScreenContext): HTMLElement {
  const lines = o.lines.map((l) =>
    el("tr", {}, [
      el("td", {}, [link(l.sku, () => ctx.open("get_product", { sku: l.sku }))]),
      el("td", {}, [l.name, l.discontinued ? " " : "", l.discontinued ? discontinuedTag() : ""]),
      el("td", { class: "num", text: String(l.quantity) }),
      el("td", { class: "num" }, [
        money(l.unitPriceCents),
        l.currentPriceCents !== l.unitPriceCents
          ? el("div", { class: "price-now", text: `now ${money(l.currentPriceCents)}` })
          : "",
      ]),
      el("td", { class: "num", text: money(l.lineTotalCents) }),
    ]),
  );

  const total = (label: string, cents: number, strong = false) =>
    el("tr", { class: strong ? "total-row strong" : "total-row" }, [
      el("td", { attrs: { colspan: "4" }, text: label }),
      el("td", { class: "num", text: money(cents) }),
    ]);

  return el("div", { class: "card" }, [
    el("div", { class: "card-title" }, [
      el("h3", { text: o.orderNumber }),
      statusPill(o.status),
    ]),
    el("div", { class: "fields" }, [
      field("Placed", day(o.placedAt)),
      field("Customer", link(o.customer.name, () => ctx.open("get_customer", { customer_id: o.customer.id }))),
      field("Email", o.customer.email),
    ]),
    el("div", { class: "card-section", text: "Shipped to" }),
    el("div", { class: "addresses" }, [addressBlock(o.shippingAddress)]),
    el("div", { class: "card-section", text: `${o.lines.length} line${o.lines.length === 1 ? "" : "s"}` }),
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, ["SKU", "Product", "Qty", "Paid each", "Line"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, [
        ...lines,
        total("Subtotal", o.subtotalCents),
        total("Shipping", o.shippingCents),
        total("Tax", o.taxCents),
        total("Total", o.totalCents, true),
      ]),
    ]),
  ]);
}
