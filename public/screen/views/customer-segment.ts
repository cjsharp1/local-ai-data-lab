/**
 * customer-segment.ts — rep screen view for customer_segment.
 *
 * A table of the customers who matched, with the filters that selected
 * them in the heading. Unlike the model, the rep screen DOES show email
 * and phone: the tool returns them in its structured result for people,
 * and leaves them out of the text summary the model reads. The note under
 * the heading says so — the difference between what a person sees and
 * what the model is given is the lesson of this tool.
 *
 * Each name opens the customer's card (get_customer, called directly).
 */

import { day, el, money } from "../../dom.js";
import type { CustomerSegmentResult, ScreenContext } from "../../types.js";
import { link } from "./parts.js";

export function renderCustomerSegment(data: CustomerSegmentResult, ctx: ScreenContext): HTMLElement {
  const filters = Object.entries(data.filters)
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${k.endsWith("spend") ? `$${v}` : v}`).join(" · ");
  const heading = el("p", { class: "screen-count", text:
    `${data.total} customer${data.total === 1 ? "" : "s"} · ${filters} · sorted by ${data.sortBy.replace("_", " ")}` +
    `${data.lowestFirst ? " (lowest first)" : ""}${data.customers.length < data.total ? ` · showing ${data.customers.length}` : ""}` });
  const note = el("p", { class: "screen-note", text:
    "Emails and phone numbers are shown to you here. The model was given names, places and spend only." });

  if (data.customers.length === 0) {
    return el("div", {}, [heading, el("p", { class: "screen-empty-note", text: "No customers match." })]);
  }

  const rows = data.customers.map((c) =>
    el("tr", {}, [
      el("td", { class: "num", text: String(c.id) }),
      el("td", {}, [link(c.name, () => ctx.open("get_customer", { customer_id: c.id }))]),
      el("td", { class: "mono", text: c.email }),
      el("td", { class: "mono", text: c.phone }),
      el("td", { text: `${c.city}, ${c.state}` }),
      el("td", { class: "num", text: String(c.orderCount) }),
      el("td", { class: "num", text: money(c.lifetimeSpendCents) }),
      el("td", { text: c.lastOrderAt ? day(c.lastOrderAt) : "never" }),
    ]),
  );

  return el("div", {}, [
    heading,
    note,
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, ["#", "Name", "Email", "Phone", "Lives in", "Orders", "Spent", "Last order"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}
