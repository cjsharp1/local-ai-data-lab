/**
 * gate.ts — guardrail layer 3: no answer without a lookup. MEDIUM.
 *
 * An `answer` is shown only if at least one tool call SUCCEEDED during
 * this turn. Otherwise the app replaces it with its canned refusal:
 * "Blocked: answered without looking anything up."
 *
 * The idea: every fact this app can legitimately state comes from a tool.
 * An answer with no successful lookup behind it came from the model's
 * weights — general knowledge at best, an invention at worst. This is
 * the layer that catches the model answering "what is Checkpoint
 * Outfitters?" from imagination (it will happily describe a Montana
 * retailer that does not exist).
 *
 * `clarify` and `refused` always pass: asking a question and declining
 * are both fine without data.
 *
 * Switched OFF, the gate still checks and still writes a warn row — it
 * just lets the answer through. That is the smoke-alarm version, kept so
 * you can compare warning with blocking.
 *
 * ---------------------------------------------------------------------------
 * Known limits — accepted, not hidden
 * ---------------------------------------------------------------------------
 *
 * It checks THAT a tool ran, not that the answer USED it. A model that
 * calls find_products and then writes a poem gets through. The rep
 * screen, rendered from tool results rather than model text, is what
 * keeps the truth visible when that happens.
 *
 * It blocks legitimate follow-ups. "What was the total on that one?"
 * reuses data from the previous turn, calls no tool, and is blocked.
 * These false blocks are logged and counted in the eval as the price of
 * a strict rule. Do not loosen the rule to hide them — a gate that
 * accepts "a tool ran at some point in the conversation" would pass
 * almost anything after the first turn.
 *
 * An empty search counts as success. "Avery Okafor has no orders" comes
 * from a successful list_orders call that returned nothing, and is a
 * correct, grounded answer — which is why the data server returns empty
 * searches as results rather than errors.
 */

import type { ReplyKind } from "../../shared/types.js";
import { CANNED_REFUSAL } from "./settings.js";

/** What the gate decided. */
export interface GateOutcome {
  kind: ReplyKind;
  text: string;
  /**
   *   passed   nothing to check, or the check passed
   *   blocked  gate on: the answer was replaced
   *   warned   gate off: the answer would have been blocked, and was shown
   */
  action: "passed" | "blocked" | "warned";
}

export function applyGate(
  reply: { kind: ReplyKind; text: string },
  toolSucceededThisTurn: boolean,
  gateOn: boolean,
): GateOutcome {
  if (reply.kind !== "answer" || toolSucceededThisTurn) {
    return { ...reply, action: "passed" };
  }
  return gateOn
    ? { kind: "blocked", text: CANNED_REFUSAL, action: "blocked" }
    : { ...reply, action: "warned" };
}
