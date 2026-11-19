/**
 * customer-list.ts — rep screen view for find_customers: a table of matches.
 *
 * Shows EVERY match the tool returned — the model's text summary lists at
 * most five, but the screen gets the full structured result. Comparing
 * the two is one of the things this screen is for.
 *
 * Each name opens that customer's card, and each order count opens their
 * orders, by calling the tool directly (no model). When two rows share a
 * name — the seeded "Sam Rivera" pair — the table makes the ambiguity
 * obvious in a way a one-line answer cannot.
 */

import { el } from "../../dom.js";
import type { CustomerSearchResult, ScreenContext } from "../../types.js";
import { link } from "./parts.js";

export function renderCustomerList(data: CustomerSearchResult, ctx: ScreenContext): HTMLElement {
  if (data.matches.length === 0) {
    return el("p", { class: "screen-empty-note", text: `No customers match "${data.query}".` });
  }

  const names = data.matches.map((m) => m.name);
  const duplicated = new Set(names.filter((n, i) => names.indexOf(n) !== i));

  const rows = data.matches.map((c) =>
    el("tr", { class: duplicated.has(c.name) ? "dup" : "" }, [
      el("td", { class: "num", text: String(c.id) }),
      el("td", {}, [link(c.name, () => ctx.open("get_customer", { customer_id: c.id }))]),
      el("td", { class: "mono", text: c.email }),
      el("td", { text: `${c.city}, ${c.state}` }),
      el("td", { class: "num" }, [
        c.orderCount > 0
          ? link(String(c.orderCount), () => ctx.open("list_orders", { customer_id: c.id }))
          : "0",
      ]),
    ]),
  );

  return el("div", {}, [
    el("p", { class: "screen-count", text:
      `${data.total} match${data.total === 1 ? "" : "es"} for "${data.query}"` +
      (duplicated.size > 0 ? " — highlighted rows share a name" : "") }),
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, ["#", "Name", "Email", "City", "Orders"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}
