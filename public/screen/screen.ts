/**
 * screen.ts — the rep screen: what the tools returned, rendered directly.
 *
 * Looks like an internal support tool — dense tables, a customer card, an
 * order's lines — and is driven ONLY by tool results (ScreenEvents),
 * never by anything the model wrote. That is the design rule the whole
 * app turns on: the rep screen is ground truth, and the chat is the
 * model's account of it. When the two disagree, the screen is right, and
 * the disagreement is worth noticing.
 *
 * Three parts:
 *
 *   header   which tool produced this view, with which arguments, and who
 *            called it (the model, or you clicking) — "list_orders ·
 *            email=dana.whitlock@example.com"
 *   strip    every screen shown this turn, clickable, so a two-call turn
 *            (find_customers → list_orders) can be stepped back through
 *   body     the view for that tool, chosen by name; plus, folded away,
 *            the exact text summary the MODEL was given
 *
 * The strip resets when a new question starts. Screens opened by clicking
 * are added to it too, marked as yours.
 */

import { byId, el } from "../dom.js";
import type {
  CustomerCard, CustomerSearchResult, OrderDetail, OrderListResult, ProductCard, ProductSearchResult,
  ScreenContext, ScreenEvent,
} from "../types.js";
import { renderCustomerList } from "./views/customer-list.js";
import { renderCustomer } from "./views/customer.js";
import { renderEmpty, renderToolError } from "./views/empty.js";
import { renderOrderTable } from "./views/order-table.js";
import { renderOrder } from "./views/order.js";
import { renderProductTable } from "./views/product-table.js";
import { renderProduct } from "./views/product.js";

/** Short names for the history strip. */
const SHORT: Record<string, string> = {
  find_customers: "Customers",
  get_customer: "Customer",
  list_orders: "Orders",
  get_order: "Order",
  find_products: "Products",
  get_product: "Product",
};

let history: ScreenEvent[] = [];
let current = -1;
let ctx: ScreenContext = { open: () => {} };

/** Wires the screen to whatever opens tools on click (app.ts). */
export function initScreen(context: ScreenContext): void {
  ctx = context;
  showEmpty();
}

/** Picks the view for a tool. The cast is safe: each tool's data is checked by its output schema. */
function renderBody(screen: ScreenEvent): HTMLElement {
  if (screen.isError || screen.data === null) return renderToolError(screen.summary);
  switch (screen.tool) {
    case "find_customers": return renderCustomerList(screen.data as CustomerSearchResult, ctx);
    case "get_customer": return renderCustomer(screen.data as CustomerCard, ctx);
    case "list_orders": return renderOrderTable(screen.data as OrderListResult, ctx);
    case "get_order": return renderOrder(screen.data as OrderDetail, ctx);
    case "find_products": return renderProductTable(screen.data as ProductSearchResult, ctx);
    case "get_product": return renderProduct(screen.data as ProductCard);
    default: return el("p", { text: `No view for ${screen.tool}.` });
  }
}

/** "email=dana.whitlock@example.com · limit=20" */
function describeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length > 0 ? parts.join(" · ") : "no arguments";
}

function renderStrip(): void {
  const strip = byId("screen-strip");
  strip.replaceChildren(...history.map((s, i) => {
    const button = el("button", {
      class: `strip-item${i === current ? " current" : ""}${s.isError ? " error" : ""}${s.calledBy === "user" ? " by-user" : ""}`,
      text: SHORT[s.tool] ?? s.tool,
      title: `${s.tool} · ${describeArgs(s.args)}${s.calledBy === "user" ? " · opened by you" : ""}`,
      attrs: { type: "button" },
    });
    button.addEventListener("click", () => select(i));
    return button;
  }));
  strip.hidden = history.length === 0;
}

function select(index: number): void {
  const screen = history[index];
  if (!screen) return;
  current = index;

  byId("screen-header").replaceChildren(
    el("span", { class: "screen-tool", text: screen.tool }),
    el("span", { class: "screen-args", text: describeArgs(screen.args) }),
    el("span", {
      class: `screen-caller ${screen.calledBy}`,
      text: screen.calledBy === "model" ? "called by the model" : "opened by you · no model",
    }),
  );

  const modelSaw = el("details", { class: "model-saw" }, [
    el("summary", { text: "What the model was given" }),
    el("pre", { text: screen.summary }),
  ]);

  byId("screen-body").replaceChildren(renderBody(screen), modelSaw);
  renderStrip();
}

/** Adds a tool result to this turn's strip and shows it. */
export function showScreen(screen: ScreenEvent): void {
  history.push(screen);
  select(history.length - 1);
}

/** A new question: start a fresh strip, but keep the last screen visible until something replaces it. */
export function startScreenTurn(): void {
  const last = history[current];
  history = last ? [last] : [];
  current = last ? 0 : -1;
  renderStrip();
}

/** Back to the empty state. */
export function showEmpty(): void {
  history = [];
  current = -1;
  byId("screen-header").replaceChildren(el("span", { class: "screen-tool muted", text: "No lookup yet" }));
  byId("screen-body").replaceChildren(renderEmpty());
  renderStrip();
}
