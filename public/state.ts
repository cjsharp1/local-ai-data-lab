/**
 * state.ts — what the browser remembers between turns, in one object.
 *
 * Deliberately small and deliberately here, in memory, for the life of the
 * tab. Nothing is saved to localStorage: reload the page and the
 * conversation is gone, which for a lab is the right default — every
 * session starts clean, and nothing about a customer lingers in the
 * browser.
 *
 *   history     earlier turns as plain text, sent with every chat request.
 *               Text only: the server does not replay old tool calls, which
 *               is why a follow-up like "what was the total on that one?"
 *               has no data behind it and the answer gate may block it.
 *   guardrails  which layers are on — sent with EVERY request, never stored
 *               on the server, so each turn records its own settings.
 *   model       the picked local model.
 *   busy        a turn is running; the input is disabled meanwhile.
 */

import type { GuardrailSettings, HistoryTurn } from "./types.js";

export const state = {
  history: [] as HistoryTurn[],
  guardrails: { scopedPrompt: true, structuredReplies: true, answerGate: true } as GuardrailSettings,
  model: "",
  numCtx: 0,
  busy: false,
};
