/**
 * chat.ts — the transcript: your questions, the model's replies, and how
 * each reply came to be.
 *
 * A reply is shown with a badge saying what KIND it ended up as, after
 * every guardrail layer had its say:
 *
 *   answer      the model's answer
 *   clarify     the model asked a question back
 *   unable      on topic, but the tools cannot answer it — the model says
 *               what it could not look up (a capability gap, not a refusal)
 *   refused     the model declined — the text is the APP's canned
 *               refusal, never the model's own words (layer 2)
 *   blocked     the answer gate replaced an answer that had no tool call
 *               behind it (layer 3)
 *   unfinished  the loop stopped before a usable reply
 *
 * plus which layers were on for that turn (P, F, G), and the cost of the
 * turn in the only currency a local model charges: requests, seconds,
 * tokens per second.
 *
 * While a turn runs, the pending reply shows what is happening ("looking
 * up list_orders…"), so a 20-second pause on a small model reads as work,
 * not as a hang.
 *
 * With "Show reasoning" on, each model request's reasoning is added above
 * the reply as a collapsed section — "Reasoning · request 1 · 1,240
 * characters · 14.2 s" — and kept after the reply arrives, so you can
 * read why it chose a tool next to what the tool returned. Reasoning is
 * more generated text, not a hidden "true" thought process; the length
 * and time are shown because they explain why it is slower.
 *
 * Replies render through markdown.ts — DOM nodes only, never innerHTML —
 * because small models write markdown constantly. Refusals and blocks
 * render as plain text: they are the app's words.
 */

import { renderMarkdown } from "./markdown.js";
import { byId, el } from "./dom.js";
import type { DoneEvent, GuardrailSettings } from "./types.js";

const KIND_LABEL: Record<string, string> = {
  answer: "answer",
  clarify: "clarifying question",
  unable: "can't look that up",
  refused: "refused",
  blocked: "blocked by the answer gate",
  unfinished: "unfinished",
};

function transcript(): HTMLElement {
  return byId("transcript");
}

function scrollToEnd(): void {
  const t = transcript();
  t.scrollTop = t.scrollHeight;
}

/** P / F / G chips: which layers were on. */
function layerChips(g: GuardrailSettings): HTMLElement {
  const chip = (letter: string, on: boolean, name: string) =>
    el("span", { class: `layer-chip${on ? " on" : ""}`, text: letter, title: `${name}: ${on ? "on" : "off"}` });
  return el("span", { class: "layer-chips" }, [
    chip("P", g.scopedPrompt, "Layer 1 — scoped prompt"),
    chip("F", g.structuredReplies, "Layer 2 — structured replies"),
    chip("G", g.answerGate, "Layer 3 — answer gate"),
  ]);
}

/** Adds the user's message. */
export function addUserMessage(text: string): void {
  document.querySelector("#transcript .transcript-empty")?.remove();
  transcript().append(el("div", { class: "msg user" }, [el("div", { class: "msg-body", text })]));
  scrollToEnd();
}

/** A reply in progress, and the ways it can end. */
export interface PendingReply {
  status(text: string): void;
  reasoning(text: string, request: number, seconds: number): void;
  finish(done: DoneEvent): void;
  fail(message: string): void;
}

/** Adds a pending assistant reply and returns its controls. */
export function startReply(): PendingReply {
  const statusLine = el("div", { class: "msg-status", text: "Thinking…" });
  const body = el("div", { class: "msg-body" }, [statusLine]);
  // Reasoning sections sit above the body and survive the body being
  // replaced by the final reply.
  const thoughts = el("div", { class: "msg-reasoning" });
  const msg = el("div", { class: "msg assistant pending" }, [thoughts, body]);
  transcript().append(msg);
  scrollToEnd();

  return {
    status(text) {
      statusLine.textContent = text;
    },

    reasoning(text, request, seconds) {
      thoughts.append(el("details", { class: "reasoning" }, [
        el("summary", { text: `Reasoning · request ${request} · ${text.length.toLocaleString("en-US")} characters · ${seconds} s` }),
        el("div", { class: "reasoning-text", text }),
      ]));
      scrollToEnd();
    },

    finish(done) {
      msg.classList.remove("pending");
      msg.classList.add(`kind-${done.kind}`);
      const appWords = done.kind === "refused" || done.kind === "blocked" || done.kind === "unfinished";
      body.replaceChildren(appWords ? el("p", { text: done.text }) : renderMarkdown(done.text));

      const stats = `${done.requests} request${done.requests === 1 ? "" : "s"} · ` +
        `${(done.elapsedMs / 1000).toFixed(1)} s` +
        (done.tokensPerSecond !== null ? ` · ${done.tokensPerSecond} tok/s` : "");
      msg.append(el("div", { class: "msg-badges" }, [
        el("span", { class: `kind-badge kind-${done.kind}`, text: KIND_LABEL[done.kind] ?? done.kind }),
        layerChips(done.guardrails),
        done.reasoning ? el("span", { class: "layer-chip on", text: "R", title: "Reasoning was on" }) : null,
        el("span", { class: "msg-stats", text: stats, title: `model ${done.model}` }),
      ]));
      scrollToEnd();
    },

    fail(message) {
      msg.classList.remove("pending");
      msg.classList.add("kind-error");
      body.replaceChildren(el("p", { class: "msg-error", text: message }));
      scrollToEnd();
    },
  };
}

/** Empties the transcript back to its welcome note. */
export function clearTranscript(): void {
  transcript().replaceChildren(el("div", { class: "transcript-empty" }, [
    el("p", { text: "Ask about Checkpoint Outfitters' customers, orders or products." }),
    el("p", { class: "muted", text: "The model runs on this machine and can only see the data through six read-only tools. Try a chip below." }),
  ]));
}
