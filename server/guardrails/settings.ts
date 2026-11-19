/**
 * settings.ts — which guardrail layers are on, and the words they share.
 *
 * Three layers keep the model on topic, each switchable, all on by
 * default. Each is in its own file in this folder:
 *
 *   1. system-prompt.ts  SOFT    a scoped system prompt — an instruction
 *                                the model may ignore
 *   2. reply-format.ts   MEDIUM  the final reply must be JSON saying
 *                                answer, clarify or refuse — the SHAPE is
 *                                enforced, the model still picks the kind
 *   3. gate.ts           MEDIUM  an answer is shown only if a tool call
 *                                succeeded this turn — enforced in code,
 *                                but it checks THAT a tool ran, not that
 *                                the answer used it
 *
 * None of them is a security boundary. What the model can REACH is fixed
 * by the six read-only tools and the read-only database; these layers
 * only shape what it SAYS. The UI lets you switch each one off to see
 * what it was stopping — that comparison is the lesson.
 *
 * This file imports nothing at runtime, so every layer can depend on it
 * without risk of a cycle.
 */

import type { GuardrailSettings } from "../../shared/types.js";

/** All three on: the default for every turn. */
export const DEFAULT_GUARDRAILS: GuardrailSettings = {
  scopedPrompt: true,
  structuredReplies: true,
  answerGate: true,
};

/** All three off: the "before" half of the before/after demo. */
export const NO_GUARDRAILS: GuardrailSettings = {
  scopedPrompt: false,
  structuredReplies: false,
  answerGate: false,
};

/**
 * The app's own refusal — shown instead of the model's words whenever a
 * reply is refused or blocked.
 *
 * The app's text, never the model's, so a refusal cannot carry a payload:
 * a model that "refuses" by writing the poem anyway and adding "but I
 * can't help with that" gets this line shown instead.
 */
export const CANNED_REFUSAL =
  "Sorry — I can only help with Checkpoint Outfitters customers, orders and products.";

/**
 * Reads guardrail settings from a request body, defaulting each layer to
 * ON when it is missing or not a boolean.
 *
 * Defaulting to on, not off, is the safe direction: a client that forgets
 * to send settings gets the protected behaviour.
 */
export function parseGuardrails(input: unknown): GuardrailSettings {
  const source = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const read = (key: keyof GuardrailSettings): boolean =>
    typeof source[key] === "boolean" ? (source[key] as boolean) : DEFAULT_GUARDRAILS[key];
  return {
    scopedPrompt: read("scopedPrompt"),
    structuredReplies: read("structuredReplies"),
    answerGate: read("answerGate"),
  };
}

/** "prompt on · format on · gate off" — for log labels and badges. */
export function describeGuardrails(settings: GuardrailSettings): string {
  const on = (value: boolean) => (value ? "on" : "off");
  return `prompt ${on(settings.scopedPrompt)} · format ${on(settings.structuredReplies)} · gate ${on(settings.answerGate)}`;
}
