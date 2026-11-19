/**
 * log.ts — the activity log panel: one row per event, newest at the bottom.
 *
 * Each row is label-first and scannable without clicking anything: a
 * level tag, a direction arrow, the label, the time. The full detail —
 * a request body, a response, a SQL statement with its parameters — is
 * one click away in a collapsed tree (json-tree.ts).
 *
 * Two dimensions, kept separate on purpose (see shared/types.ts):
 *
 *   level      what KIND of event — colours the tag word
 *   direction  which way data moved — draws the arrow and tints the row
 *
 * so "a request going out to the model" and "its response coming back"
 * read as a pair at a glance, and a guardrail stepping in (a warn row)
 * stands out from the traffic around it.
 *
 * Rows for one turn are grouped under a divider naming the question, so a
 * long session stays readable. Rows render with textContent only: labels
 * and details include model output and database text.
 */

import { buildJsonTree } from "./json-tree.js";
import { byId, clock, el } from "./dom.js";
import type { LogEvent } from "./types.js";

/** The arrow drawn for each direction. */
const ARROW: Record<string, string> = { out: "→", in: "←", call: "⇢", back: "⇠", none: "·" };

/** Readable direction names, for the arrow's tooltip. */
const DIRECTION_TITLE: Record<string, string> = {
  out: "app → model (a request)",
  in: "model → app (a response)",
  call: "app → data server (a tool call)",
  back: "data server → app (a tool result)",
  none: "nothing crossed a boundary",
};

function list(): HTMLElement {
  return byId("log-rows");
}

/** Keeps the newest row in view — unless the reader has scrolled up to read. */
function scrollIfFollowing(wasAtBottom: boolean): void {
  const scroller = byId("log-scroll");
  if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
}

function atBottom(): boolean {
  const scroller = byId("log-scroll");
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
}

/** A divider before each turn's rows. */
export function logTurnDivider(text: string): void {
  const follow = atBottom();
  list().append(el("li", { class: "log-divider" }, [el("span", { text })]));
  scrollIfFollowing(follow);
}

/** Appends one event as a row. */
export function appendLog(event: LogEvent): void {
  const follow = atBottom();
  const direction = event.direction ?? "none";

  const head = el("div", { class: "log-head" }, [
    el("span", { class: `log-level level-${event.level}`, text: event.level }),
    el("span", { class: "log-arrow", text: ARROW[direction] ?? "·", title: DIRECTION_TITLE[direction] ?? "" }),
    el("span", { class: "log-label", text: event.label }),
    el("span", { class: "log-meta", text: `${event.iteration !== undefined ? `#${event.iteration} · ` : ""}${clock(event.at)}` }),
  ]);

  const parts: HTMLElement[] = [head];
  if (event.because) {
    parts.push(el("div", { class: "log-because", text: `because ${event.because}` }));
  }
  if (event.detail !== undefined) {
    // Built on first open, not up front: a model request with six tool
    // schemas is a large tree, and most rows are never expanded.
    const details = el("details", { class: "log-detail" }, [el("summary", { text: "detail" })]);
    details.addEventListener("toggle", () => {
      if (details.open && details.children.length === 1) details.append(buildJsonTree(event.detail));
    });
    parts.push(details);
  }

  list().append(el("li", {
    class: `log-row dir-${direction} row-${event.level}`,
    attrs: event.actor ? { "data-actor": event.actor } : {},
  }, parts));
  scrollIfFollowing(follow);
}

/** Empties the panel. */
export function clearLog(): void {
  list().replaceChildren();
}
