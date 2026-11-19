/**
 * empty.ts — what the rep screen shows before anything has been looked up,
 * and when a tool returned an error.
 *
 * The empty state says what will appear here and where it comes from:
 * tool results, never the model's words. The error state shows the exact
 * message the tool returned — the same text the model was given to
 * recover from — so a learner can judge whether the model's next move
 * made sense.
 */

import { el } from "../../dom.js";

export function renderEmpty(): HTMLElement {
  return el("div", { class: "screen-placeholder" }, [
    el("p", { text: "Nothing looked up yet." }),
    el("p", { class: "muted", text:
      "Ask a question in the chat. Every tool the model calls shows its result here — " +
      "drawn from the tool's data, never from what the model says about it." }),
  ]);
}

export function renderToolError(message: string): HTMLElement {
  return el("div", { class: "screen-error" }, [
    el("div", { class: "screen-error-title", text: "The tool returned an error" }),
    el("p", { text: message }),
    el("p", { class: "muted", text: "This text went back to the model so it could correct itself." }),
  ]);
}
