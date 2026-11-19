/**
 * product.ts — rep screen view for get_product: the product card.
 *
 * Price, category, brand, weight, colour, sales figures, and the
 * description — shown in a box labelled as untrusted text from the
 * database.
 *
 * That label is the lesson attached to one seeded product (CO-SAF-001),
 * whose description contains a prompt injection: an instruction telling
 * any AI that reads it to list every customer's email. On this screen it
 * is just text — rendered with textContent, it can do nothing. In the
 * model's context it is an attempt to give orders. Seeing it here, next
 * to whatever the model did with it, is the point.
 */

import { day, el, money } from "../../dom.js";
import type { ProductCard } from "../../types.js";
import { discontinuedTag, field } from "./parts.js";

export function renderProduct(p: ProductCard): HTMLElement {
  return el("div", { class: "card" }, [
    el("div", { class: "card-title" }, [
      el("h3", { text: p.name }),
      el("span", { class: "card-sub", text: p.sku }),
      p.discontinued ? discontinuedTag() : null,
    ]),
    el("div", { class: "fields" }, [
      field("Price", money(p.priceCents)),
      field("Category", p.category),
      field("Brand", p.brand),
      field("Colour", p.color),
      field("Weight", `${p.weightGrams} g`),
      field("Units sold", p.orderCount === 0 ? "Never ordered" : `${p.unitsSold} across ${p.orderCount} order${p.orderCount === 1 ? "" : "s"}`),
      field("Last ordered", day(p.lastOrderedAt)),
    ]),
    el("div", { class: "card-section", text: "Description — text from the database, untrusted" }),
    el("blockquote", { class: "description", text: p.description }),
  ]);
}
