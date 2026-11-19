/**
 * reply-format.ts — guardrail layer 2: structured replies. MEDIUM.
 *
 * The model's final reply must be JSON of exactly this shape:
 *
 *     { "kind": "answer" | "clarify" | "unable" | "refuse", "text": "..." }
 *
 * Ollama enforces the SHAPE (its `format` option constrains generation to
 * a JSON Schema), so the reply always parses into one of four kinds. The
 * model still chooses WHICH kind — a medium guarantee, not a hard one.
 *
 * What the shape buys:
 *
 *   refuse   → the app shows its OWN canned refusal, never the model's
 *              text. A refusal cannot smuggle out the poem it was asked
 *              to refuse.
 *   answer   → passed to layer 3, the answer gate.
 *   clarify  → shown as written (a known gap: clarify text is not checked).
 *   unable   → shown as written: the question is in scope, but the tools
 *              cannot answer it, and the model says what is missing. Not
 *              checked either — the same known gap as clarify.
 *
 * ---------------------------------------------------------------------------
 * Why "unable" exists
 * ---------------------------------------------------------------------------
 *
 * With only three kinds, "What are the 10 most popular products?" — asked
 * before any tool could rank products by sales — came back as `refuse`,
 * and the app showed "I can only help with Checkpoint Outfitters
 * customers, orders and products": an off-topic refusal for an on-topic
 * question. The model's own draft had said, correctly, that it could not
 * see sales figures. Three kinds gave it no honest way to say so.
 *
 * A capability gap and an off-topic request are different failures with
 * different fixes (a new tool, versus nothing at all), so the reply shape
 * now tells them apart.
 *
 * ---------------------------------------------------------------------------
 * Why this costs an extra request
 * ---------------------------------------------------------------------------
 *
 * The obvious design sets `format` on the same request that offers the
 * tools. Measured on this project's machine, that is worse than useless:
 * with `format` set, the model NEVER called a tool. Asked "What's on order
 * CP-10266?", it answered — validly formatted — "a single item: a pair of
 * running shoes". The real order has seven lines. Constraining the output
 * to JSON took away its ability to look anything up, and it filled the
 * gap by inventing.
 *
 * So the loop runs with tools and no format until the model stops calling
 * tools, then makes ONE MORE request: tools removed, `format` set, the
 * conversation so far included, plus an instruction saying what the three
 * kinds mean. The model's free-text draft from the tool-calling request
 * is discarded; the formatted request writes the reply that is shown.
 * That is one extra round trip per turn, logged as its own model row.
 *
 * ---------------------------------------------------------------------------
 * When the reply will not parse
 * ---------------------------------------------------------------------------
 *
 * The format constraint makes this rare, but not impossible (a reply cut
 * off by the context limit, say). A reply that fails to parse is an
 * error row and the canned refusal — never a quiet fallback to treating
 * the raw text as an answer, which would bypass this layer exactly when
 * something has gone wrong.
 */

import { z } from "zod";
import type { OllamaMessage } from "../model/ollama.js";

/** The JSON Schema sent as Ollama's `format`. */
export const REPLY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["answer", "clarify", "unable", "refuse"] },
    text: { type: "string" },
  },
  required: ["kind", "text"],
};

/** The same shape, for checking what came back. */
const replySchema = z.object({
  kind: z.enum(["answer", "clarify", "unable", "refuse"]),
  text: z.string(),
});

export type StructuredReply = z.infer<typeof replySchema>;

/**
 * What the extra request adds: an instruction defining the four kinds.
 *
 * Note that this instruction carries its own idea of scope ("refuse if
 * the request is not about Checkpoint Outfitters..."), so layer 2 keeps
 * some topic control even when layer 1's scoped prompt is off. That is
 * real, not an accident of the test — the kinds only mean something
 * relative to a job.
 */
export const FORMAT_INSTRUCTION = [
  "Now write your reply to the user's last message as JSON with two fields.",
  "kind: \"answer\" if you are answering from what the tools returned;",
  "\"clarify\" if you need the user to say which record they mean or to give missing details;",
  "\"unable\" if the request IS about Checkpoint Outfitters but the tools could not provide what is needed — in text, say what you could not look up (do not use the refusal sentence);",
  "\"refuse\" ONLY if the request is not about Checkpoint Outfitters' customers, orders or products at all.",
  "text: your reply to the user.",
].join(" ");

/**
 * The messages for the extra request: the conversation so far, then the
 * instruction as a final system message.
 *
 * Appended at the END, not merged into the first system prompt, so the
 * prompt prefix stays identical to the earlier requests and Ollama's
 * prompt cache can reuse it — the extra request then costs little more
 * than the reply itself.
 */
export function formatRequestMessages(conversation: OllamaMessage[]): OllamaMessage[] {
  return [...conversation, { role: "system", content: FORMAT_INSTRUCTION }];
}

/** Parses the formatted reply. Never throws. */
export function parseReply(content: string): { ok: true; reply: StructuredReply } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return { ok: false, error: `not JSON: ${error.message}` };
    throw error;
  }
  const parsed = replySchema.safeParse(json);
  return parsed.success
    ? { ok: true, reply: parsed.data }
    : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "reply"}: ${i.message}`).join("; ") };
}
