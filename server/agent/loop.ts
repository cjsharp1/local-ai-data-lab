/**
 * loop.ts — one turn of the conversation: ask the model, run the tools it
 * asks for, repeat, then shape and check the reply.
 *
 * This is the agent. In outline:
 *
 *   1. Log which guardrail layers are on for this turn.
 *   2. Build the messages: system prompt (layer 1), history, the question.
 *   3. Send them to the local model WITH the eight tools.
 *   4. If it asks for tool calls: run each one through the data server,
 *      emit a screen event with the structured result, append the text
 *      result to the conversation, and go back to 3.
 *   5. When it stops asking: produce the reply — via one extra formatted
 *      request if layer 2 is on — then pass it through the gate (layer 3).
 *
 * At most MAX_ITERATIONS model requests with tools. The layer-2 request
 * does not count towards that cap: it is a fixed cost of the layer, not
 * the model deciding to keep going.
 *
 * ---------------------------------------------------------------------------
 * What the loop does not know
 * ---------------------------------------------------------------------------
 *
 * It does not know where tools come from. It gets a `ToolSource` — list
 * and call — and the MCP client is one. It does not know where its output
 * goes. It gets a `Logger` and an `emit` function, never an HTTP response,
 * which is what lets ask.ts and eval.ts run exactly this code from the
 * terminal with no server at all.
 *
 * ---------------------------------------------------------------------------
 * Small models fail in particular ways — make each one visible
 * ---------------------------------------------------------------------------
 *
 *   Unknown tool name        → a tool message listing the real ones; warn.
 *   Bad arguments            → the data server's own validation message goes
 *                              back as the tool result so the model can
 *                              retry; warn. No second validation here.
 *   Tool call written as     → detected by a HEURISTIC (it is a guess, and
 *   text, not made             labelled as one); warn; NOT executed —
 *                              quietly running it would hide the failure.
 *   Same call twice in a row → stop before running it again; error.
 *   Iteration cap            → error; the reply says it could not finish.
 *   History dropped by       → prompt_eval_count far below the size of the
 *   Ollama                     messages sent; error.
 *
 * None of these is retried quietly. A teaching app that hides a model's
 * failures teaches that the model does not fail.
 */

import type { GuardrailSettings, ReplyKind, StreamEvent } from "../../shared/types.js";
import type { Logger } from "../logger.js";
import { truncate } from "../logger.js";
import {
  RemoteModelError, buildRequest, chat, isRemoteModel, ms, ollamaConfig, tokensPerSecond,
  type ChatRequest, type ChatResponse, type OllamaMessage, type OllamaToolCall,
} from "../model/ollama.js";
import type { ToolCallOutcome } from "../mcp/client.js";
import { applyGate } from "../guardrails/gate.js";
import { REPLY_SCHEMA, formatRequestMessages, parseReply } from "../guardrails/reply-format.js";
import { CANNED_REFUSAL, describeGuardrails } from "../guardrails/settings.js";
import { buildSystemPrompt } from "../guardrails/system-prompt.js";
import { toOllamaTool, type McpToolDefinition } from "./tool-format.js";

/** Model requests with tools, per turn. Small models rarely need more than 2–3. */
export const MAX_ITERATIONS = 6;

/** Above this share of the context window, warn. */
const CONTEXT_WARN_RATIO = 0.85;

/**
 * Below this share of the estimated message tokens, messages were dropped.
 * Generous, because the estimate is rough; a real drop removes whole
 * messages and lands far below it (measured: 60 tokens shown for ~2,400).
 */
const DROP_RATIO = 0.6;

/** About four characters per token — rough, and only used with DROP_RATIO's margin. */
function estimateMessageTokens(messages: OllamaMessage[]): number {
  const chars = messages.reduce(
    (sum, m) => sum + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
    0,
  );
  return Math.round(chars / 4);
}

/** What the app says when the loop gives up. The app's words, not the model's. */
const UNFINISHED_TEXT = "I couldn't finish looking that up. The activity log shows where it stopped.";

/** What "unable" says when the model's own explanation is unusable. */
const UNABLE_TEXT = "That's a fair question about the shop, but none of my lookups can answer it.";

/** A previous turn, as text. Tool calls from earlier turns are not replayed. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Everything one turn needs. */
export interface TurnRequest {
  message: string;
  history: ChatTurn[];
  model: string;
  guardrails: GuardrailSettings;
  /**
   * Let the model reason before each response. The caller has already
   * checked the model supports it (server/index.ts); off by default.
   */
  reasoning?: boolean;
}

/** Where tools come from. The MCP client satisfies this. */
export interface ToolSource {
  tools(): Promise<McpToolDefinition[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
}

export interface TurnDeps {
  logger: Logger;
  emit: (event: StreamEvent) => void;
  tools: ToolSource;
}

/** Optional knobs, used by the eval for reproducible runs. */
export interface TurnOptions {
  temperature?: number;
  seed?: number;
  signal?: AbortSignal;
}

export type DoneEvent = Extract<StreamEvent, { type: "done" }>;

/** What a turn produced — the done event, plus facts the eval counts. */
export interface TurnResult {
  done?: DoneEvent;
  error?: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; isError: boolean }>;
  /** Which guardrail layers acted, e.g. ["layer2:refuse", "layer3:blocked"]. */
  layerActions: string[];
  requests: number;
  droppedMessages: boolean;
  textToolCall: boolean;
}

// --- Helpers ---------------------------------------------------------------------

/** JSON with sorted keys, so {a,b} and {b,a} compare equal. */
function stableKey(name: string, args: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  return `${name}(${JSON.stringify(sorted)})`;
}

/**
 * A HEURISTIC: does this reply text look like a tool call the model wrote
 * out instead of making?
 *
 * Small models sometimes print `{"name": "get_order", "arguments": {...}}`
 * — or wrap it in a ```json fence or <tool_call> tags — as their reply,
 * rather than producing a real tool call. Looks for an object with a
 * string `name` and an `arguments` / `parameters` object, or a `function`
 * wrapper. Not any JSON: a layer-2 reply is JSON too, and is never passed
 * through this check.
 */
export function looksLikeTextToolCall(content: string): boolean {
  const unwrapped = content
    .replace(/<\/?tool_call>/g, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  if (!unwrapped.startsWith("{") && !unwrapped.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    return false;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return candidates.some((c) => {
    if (typeof c !== "object" || c === null) return false;
    const o = c as Record<string, unknown>;
    const fn = (typeof o.function === "object" && o.function !== null ? o.function : o) as Record<string, unknown>;
    return typeof fn.name === "string" &&
      (typeof fn.arguments === "object" || typeof fn.parameters === "object" || typeof fn.arguments === "string");
  });
}

/** "asked for get_order, list_orders" or "replied (212 chars)". */
function describeResponse(response: ChatResponse): string {
  const calls = response.message.tool_calls ?? [];
  return calls.length > 0
    ? `asked for ${calls.map((c) => c.function.name).join(", ")}`
    : `replied (${response.message.content.length} chars)`;
}

// --- The turn --------------------------------------------------------------------

export async function runTurn(request: TurnRequest, deps: TurnDeps, options: TurnOptions = {}): Promise<TurnResult> {
  const { logger, emit, tools } = deps;
  const { numCtx } = ollamaConfig();
  const started = Date.now();
  const result: TurnResult = {
    toolCalls: [], layerActions: [], requests: 0, droppedMessages: false, textToolCall: false,
  };

  let lastResponse: ChatResponse | undefined;

  /** Sends one request, logging both halves and checking the context budget. */
  async function callModel(req: ChatRequest, because: string): Promise<ChatResponse> {
    result.requests += 1;
    // No arrows in the label: direction is its own field, and the log
    // panel (or ask.ts) draws the arrow from it.
    logger.model(`${req.model}: request ${result.requests}${req.format ? " (structured reply, no tools)" : ""}`, req, {
      direction: "out", actor: "app", because,
    });

    const response = await chat(req, options.signal);
    lastResponse = response;

    // Reasoning, when it was asked for: its own log row and stream event,
    // so it can be read beside the decision it led to. Ollama reports one
    // eval_count for reasoning and reply together, so the time shown is
    // the whole response's generation time.
    const thinking = response.message.thinking?.trim();
    if (thinking) {
      const seconds = Math.round(ms(response.eval_duration) / 100) / 10;
      logger.model(`${req.model} reasoned for ${thinking.length.toLocaleString("en-US")} characters before responding`,
        { thinking }, { actor: "model", because: "Show reasoning is on" });
      emit({ type: "reasoning", request: result.requests, text: thinking, seconds });
    }

    const tps = tokensPerSecond(response);
    const prompt = response.prompt_eval_count ?? 0;
    const load = ms(response.load_duration);
    logger.model(
      `${req.model} ${describeResponse(response)} · ${tps ?? "?"} tok/s · ${prompt}/${numCtx} tokens` +
        (load > 1000 ? ` · model load ${(load / 1000).toFixed(1)} s` : ""),
      response,
      { direction: "in", actor: "model" },
    );

    // When a conversation outgrows num_ctx, Ollama silently drops whole
    // older messages. The only trace is prompt_eval_count: the model was
    // shown fewer tokens than the messages we sent contain.
    //
    // So compare it with an estimate of the MESSAGE TEXT alone (about 4
    // characters per token — rough, hence the generous margin). Not with
    // the previous request's count: an earlier version flagged any prompt
    // that shrank, and the eval caught it crying wolf 58 times for
    // llama3.2:3b, whose largest prompt was 1,778 of 8,192 tokens. Its
    // chat template writes the tool definitions only into the LAST
    // message, and only when that is a user message — so once a tool
    // result is last, ~1,000 tokens of definitions vanish from the prompt
    // legitimately. Templates move tool definitions around; they always
    // render the messages, and a real drop removes whole messages.
    const estimate = estimateMessageTokens(req.messages);
    if (estimate > 500 && prompt < estimate * DROP_RATIO) {
      result.droppedMessages = true;
      logger.error(
        `Ollama dropped earlier messages to fit the ${numCtx}-token context window (the model saw ${prompt} tokens; the messages alone are about ${estimate})`,
        { promptTokens: prompt, estimatedMessageTokens: estimate, numCtx },
        { because: "the conversation outgrew num_ctx — the model can no longer see part of it, possibly a tool result" },
      );
    } else if (prompt >= numCtx * CONTEXT_WARN_RATIO) {
      logger.warn(`Context window nearly full: ${prompt} of ${numCtx} tokens`, { promptTokens: prompt, numCtx }, {
        because: "past this, Ollama silently drops older messages",
      });
    }
    return response;
  }

  /** Ends the turn with an error the user can read. */
  function fail(message: string, detail?: unknown): TurnResult {
    logger.iteration = undefined;
    logger.error(message, detail);
    emit({ type: "error", message });
    result.error = message;
    return result;
  }

  /** Ends the turn with a reply. */
  function finish(kind: ReplyKind, text: string): TurnResult {
    logger.iteration = undefined;
    const done: DoneEvent = {
      type: "done",
      text,
      kind,
      guardrails: request.guardrails,
      model: request.model,
      requests: result.requests,
      elapsedMs: Date.now() - started,
      tokensPerSecond: lastResponse ? tokensPerSecond(lastResponse) : null,
      reasoning: request.reasoning === true,
    };
    logger.info(`Turn complete: ${kind} · ${result.requests} model request${result.requests === 1 ? "" : "s"} · ${(done.elapsedMs / 1000).toFixed(1)} s`);
    emit(done);
    result.done = done;
    return result;
  }

  // 1. Which layers are on — first, so every transcript explains itself.
  logger.iteration = undefined;
  logger.info(`New turn · ${describeGuardrails(request.guardrails)} · model ${request.model}` +
    (request.reasoning ? " · reasoning on" : ""), {
    guardrails: request.guardrails, model: request.model, numCtx, reasoning: request.reasoning === true,
  }, { actor: "user", because: "the user sent a message" });

  if (isRemoteModel(request.model)) {
    return fail(new RemoteModelError(request.model).message);
  }

  try {
    // 2. The tools, as the model will see them, and the opening messages.
    const toolDefs = await tools.tools();
    const ollamaTools = toolDefs.map(toOllamaTool);
    const toolNames = new Set(toolDefs.map((t) => t.name));

    const messages: OllamaMessage[] = [
      { role: "system", content: buildSystemPrompt(request.guardrails) },
      ...request.history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: request.message },
    ];

    let toolSucceeded = false;
    let previousCallKey: string | undefined;
    let draft = "";

    // 3–4. The tool loop.
    for (let iteration = 1; ; iteration++) {
      if (iteration > MAX_ITERATIONS) {
        logger.error(`Stopped after ${MAX_ITERATIONS} model requests without a final reply`, undefined, {
          because: "the iteration cap stops a model that keeps calling tools",
        });
        return finish("unfinished", UNFINISHED_TEXT);
      }
      logger.iteration = iteration;

      const response = await callModel(
        buildRequest({ model: request.model, messages, tools: ollamaTools, think: request.reasoning, ...options }),
        iteration === 1 ? "the user asked a question" : "the tool results are ready",
      );

      const calls: OllamaToolCall[] = response.message.tool_calls ?? [];
      if (calls.length === 0) {
        draft = response.message.content;
        break;
      }

      // Keep the assistant's tool-call message in the conversation: the
      // model needs to see what it asked for next to the results.
      messages.push({ role: "assistant", content: response.message.content, tool_calls: calls });
      logger.info(`The model asked for ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, calls, {
        actor: "model", because: "its response contained tool_calls",
      });

      for (const call of calls) {
        const name = call.function.name;
        const args = (call.function.arguments ?? {}) as Record<string, unknown>;

        // Same call as last time: the model is stuck. Stop before repeating it.
        const key = stableKey(name, args);
        if (key === previousCallKey) {
          logger.error(`The model asked for the same call twice in a row: ${truncate(key, 90)} — stopping`, call, {
            actor: "model", because: "repeating an identical lookup will not change its result",
          });
          return finish("unfinished", UNFINISHED_TEXT);
        }
        previousCallKey = key;

        if (!toolNames.has(name)) {
          const available = [...toolNames].join(", ");
          logger.warn(`The model asked for a tool that does not exist: ${name}`, call, {
            actor: "model", because: "small models sometimes invent tool names",
          });
          messages.push({ role: "tool", tool_name: name, content: `No such tool: ${name}. Available tools: ${available}.` });
          continue;
        }

        const id = call.id ?? `${iteration}-${name}`;
        emit({ type: "tool_start", id, name, args, iteration });
        logger.tool(`call ${name}(${truncate(JSON.stringify(args), 100)})`, args, {
          direction: "call", actor: "app", because: "the model's response asked for it",
        });

        const outcome = await tools.call(name, args);
        result.toolCalls.push({ name, args, isError: outcome.isError });

        for (const q of outcome.queries) {
          logger.data(`SQL ${truncate(q.sql, 80)} → ${q.rows} row${q.rows === 1 ? "" : "s"}, ${q.ms} ms`, q);
        }
        logger.tool(`${name} → ${outcome.isError ? "error: " : ""}${truncate(outcome.text, 100)}`,
          { text: outcome.text, isError: outcome.isError, data: outcome.data },
          { direction: "back", actor: "tool" });

        if (outcome.isError) {
          logger.warn(`${name} returned an error — sent back to the model so it can correct itself`, { args, error: outcome.text }, {
            because: "an error result is information the model can act on",
          });
        } else {
          toolSucceeded = true;
        }

        emit({ type: "tool_end", id, name, isError: outcome.isError, elapsedMs: outcome.elapsedMs });
        emit({
          type: "screen",
          screen: {
            tool: name, args, data: outcome.data, summary: outcome.text,
            isError: outcome.isError, calledBy: "model", at: Date.now(),
          },
        });

        // The model gets the TEXT summary — never the structured result.
        messages.push({ role: "tool", tool_name: name, content: outcome.text });
      }
    }

    // A reply that is really a tool call written out as text.
    if (looksLikeTextToolCall(draft)) {
      result.textToolCall = true;
      logger.warn("The model wrote a tool call as text instead of making one — not executed (heuristic)", { content: draft }, {
        actor: "model", because: "running it quietly would hide that the model failed to call the tool",
      });
    }

    // 5a. Layer 2 — structured reply, in one extra request without tools.
    let reply: { kind: ReplyKind; text: string };
    if (request.guardrails.structuredReplies) {
      logger.iteration = undefined;
      logger.info("Layer 2: asking again for the reply as JSON (answer | clarify | unable | refuse), tools removed", { draft }, {
        because: "format and tools cannot share a request — with both, the model never calls a tool",
      });
      const formatted = await callModel(
        buildRequest({ model: request.model, messages: formatRequestMessages(messages), format: REPLY_SCHEMA, think: request.reasoning, ...options }),
        "layer 2 needs the final reply as structured JSON",
      );
      const parsed = parseReply(formatted.message.content);
      if (!parsed.ok) {
        result.layerActions.push("layer2:unparseable");
        logger.error(`Layer 2: the reply did not parse (${parsed.error}) — showing the app's refusal`, { content: formatted.message.content });
        return finish("unfinished", CANNED_REFUSAL);
      }
      if (parsed.reply.kind === "refuse") {
        result.layerActions.push("layer2:refuse");
        logger.warn("Layer 2: the model refused — showing the app's own refusal, not its text", { modelText: parsed.reply.text }, {
          because: "a refusal written by the model could carry the content it is refusing",
        });
        reply = { kind: "refused", text: CANNED_REFUSAL };
      } else if (parsed.reply.kind === "unable" && parsed.reply.text.includes(CANNED_REFUSAL.slice(0, 40))) {
        // Seen in use: the model chose "unable" — correctly — but copied the
        // off-topic refusal line from the system prompt as its explanation,
        // so an in-scope gap read as "I only help with Checkpoint
        // Outfitters". Say what the kind means instead of what it copied.
        result.layerActions.push("layer2:unable");
        logger.warn("Layer 2: the model said 'unable' but wrote the off-topic refusal — showing a plain 'cannot look that up' instead", { modelText: parsed.reply.text });
        reply = { kind: "unable", text: UNABLE_TEXT };
      } else if (parsed.reply.kind === "unable") {
        result.layerActions.push("layer2:unable");
        logger.info("Layer 2: the model says the tools cannot answer this — an in-scope gap, not a refusal", { modelText: parsed.reply.text }, {
          actor: "model", because: "no tool returns what the question needs",
        });
        reply = { kind: "unable", text: parsed.reply.text };
      } else {
        reply = { kind: parsed.reply.kind, text: parsed.reply.text };
      }
    } else {
      reply = { kind: "answer", text: draft };
    }

    // 5b. Layer 3 — the answer gate.
    const gated = applyGate(reply, toolSucceeded, request.guardrails.answerGate);
    if (gated.action === "blocked") {
      result.layerActions.push("layer3:blocked");
      logger.warn("Layer 3 blocked the reply: answered without looking anything up", { blocked: reply.text }, {
        because: "no tool call succeeded this turn, so the answer can only have come from the model's memory",
      });
    } else if (gated.action === "warned") {
      result.layerActions.push("layer3:warned");
      logger.warn("Layer 3 (off — warning only): answered without looking anything up, shown anyway", { answer: reply.text });
    }

    return finish(gated.kind, gated.text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message, error instanceof Error ? { name: error.name, message: error.message } : error);
  }
}
