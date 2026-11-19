/**
 * order-table.ts — rep screen view for list_orders: a table of orders.
 *
 * Newest first, with status pills, item counts and totals. Every order
 * number opens that order (get_order, called directly). When the list is
 * filtered to one customer, their name heads the table and links to their
 * card; otherwise each row names its customer.
 *
 * The screen shows every row the tool returned — up to the tool's limit —
 * while the model read only the first five. "Dana has 8 orders" in the
 * chat and eight rows here should agree; when they do not, the screen is
 * right.
 */

import { day, el, money } from "../../dom.js";
import type { OrderListResult, ScreenContext } from "../../types.js";
import { link, statusPill } from "./parts.js";

export function renderOrderTable(data: OrderListResult, ctx: ScreenContext): HTMLElement {
  const who = data.customer;
  const heading = el("p", { class: "screen-count" }, [
    `${data.total} order${data.total === 1 ? "" : "s"}`,
    who ? " for " : "",
    who ? link(who.name, () => ctx.open("get_customer", { customer_id: who.id })) : "",
    data.orders.length < data.total ? ` — showing the newest ${data.orders.length}` : "",
  ]);

  if (data.orders.length === 0) {
    return el("div", {}, [heading, el("p", { class: "screen-empty-note", text: "No orders." })]);
  }

  const headers = ["Order", "Placed", "Status", "Items", "Total", ...(who ? [] : ["Customer"])];
  const rows = data.orders.map((o) =>
    el("tr", {}, [
      el("td", {}, [link(o.orderNumber, () => ctx.open("get_order", { order_number: o.orderNumber }))]),
      el("td", { text: day(o.placedAt) }),
      el("td", {}, [statusPill(o.status)]),
      el("td", { class: "num", text: String(o.itemCount) }),
      el("td", { class: "num", text: money(o.totalCents) }),
      who ? null : el("td", { text: o.customerName }),
    ]),
  );

  return el("div", {}, [
    heading,
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}
