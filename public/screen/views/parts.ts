/**
 * parts.ts — small building blocks shared by the rep screen's views.
 *
 * A clickable link that calls a tool, a status pill, a label/value pair,
 * an address block. Kept together so the views stay about WHAT they show,
 * and so every clickable thing on the screen behaves the same way: it is
 * a real <button> (keyboard-reachable, announced correctly), styled to
 * look like a link.
 */

import { el } from "../../dom.js";
import type { PostalAddress } from "../../../shared/checkpoint.js";

/** A button that looks like a link, for click-through to another tool. */
export function link(text: string, onClick: () => void, title = "Open — calls the tool directly, no model"): HTMLButtonElement {
  const button = el("button", { class: "link", text, title, attrs: { type: "button" } });
  button.addEventListener("click", onClick);
  return button;
}

/** An order status as a coloured pill. */
export function statusPill(status: string): HTMLElement {
  return el("span", { class: `pill status-${status}`, text: status });
}

/** A small "discontinued" tag. */
export function discontinuedTag(): HTMLElement {
  return el("span", { class: "pill tag-discontinued", text: "discontinued" });
}

/** A label above a value, for card layouts. */
export function field(label: string, value: string | Node): HTMLElement {
  return el("div", { class: "field" }, [
    el("div", { class: "field-label", text: label }),
    el("div", { class: "field-value" }, [value]),
  ]);
}

/** A postal address as two lines. */
export function addressBlock(a: PostalAddress): HTMLElement {
  return el("div", { class: "address" }, [
    el("div", { class: "address-label", text: a.label + (a.isDefault ? " · default" : "") }),
    el("div", { text: a.street }),
    el("div", { text: `${a.city}, ${a.state} ${a.zip}` }),
  ]);
}
