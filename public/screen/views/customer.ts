/**
 * customer.ts — rep screen view for get_customer: the customer card.
 *
 * Contact details, the figures worked out from their orders, the billing
 * address and every shipping address. Dana Whitlock, seeded with three
 * shipping addresses, is the case this layout exists for: "where did my
 * order go?" has three possible answers, and the card shows all three.
 *
 * "View orders" calls list_orders directly — the same tool the model
 * would call, with no model involved.
 */

import { day, el, money } from "../../dom.js";
import type { CustomerCard, ScreenContext } from "../../types.js";
import { addressBlock, field, link } from "./parts.js";

export function renderCustomer(c: CustomerCard, ctx: ScreenContext): HTMLElement {
  return el("div", { class: "card" }, [
    el("div", { class: "card-title" }, [
      el("h3", { text: c.name }),
      el("span", { class: "card-sub", text: `customer #${c.id}` }),
    ]),
    el("div", { class: "fields" }, [
      field("Email", c.email),
      field("Phone", c.phone),
      field("Customer since", day(c.joinedAt)),
      field("Orders", c.orderCount > 0
        ? link(String(c.orderCount), () => ctx.open("list_orders", { customer_id: c.id }))
        : "None"),
      field("Lifetime spend", money(c.lifetimeSpendCents)),
      field("Last order", day(c.lastOrderAt)),
    ]),
    el("div", { class: "card-section", text: "Billing address" }),
    el("div", { class: "addresses" }, [addressBlock(c.billingAddress)]),
    el("div", { class: "card-section", text: `Shipping addresses (${c.shippingAddresses.length})` }),
    el("div", { class: "addresses" }, c.shippingAddresses.map(addressBlock)),
    c.orderCount > 0
      ? el("div", { class: "card-actions" }, [
          link("View orders →", () => ctx.open("list_orders", { customer_id: c.id })),
        ])
      : el("p", { class: "screen-empty-note", text: "This customer has never placed an order." }),
  ]);
}
