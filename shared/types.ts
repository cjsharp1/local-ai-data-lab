/**
 * types.ts — the shapes that travel between the app server and the browser.
 *
 * This file is the contract for the whole app. The server builds these
 * objects, serialises them as JSON over Server-Sent Events, and the
 * browser parses them back out. Nothing here has any behaviour: it is
 * types only, and it compiles to nothing at all.
 *
 * Keeping the definitions in one file means the two halves cannot quietly
 * disagree. When the log panel renders a level tag, the set of levels it
 * must handle is the one defined here; when the rep screen picks a view,
 * the event it reads is the one defined here.
 *
 * Three streams of information leave the server, and they are kept
 * apart on purpose:
 *
 *   LogEvent     what happened, for the activity log
 *   ScreenEvent  what a tool returned, for the rep screen
 *   the reply    what the model SAID, for the chat
 *
 * The rep screen is built only from ScreenEvents — tool results, never
 * model text. That separation is the point of the app: when the chat and
 * the screen disagree, the screen is right, and you can see that the
 * model got it wrong.
 */

// ---------------------------------------------------------------------------
// Log events
// ---------------------------------------------------------------------------

/**
 * What kind of thing a log row describes.
 *
 * The levels are about *what happened*, not severity in the usual logging
 * sense. Someone watching the panel wants to tell a model call from a tool
 * call from a database query at a glance.
 *
 *   info   The app did something on its own: a turn starting, which
 *          guardrail layers are on, the data server connecting.
 *
 *   model  A request to the local model, or its response. Each response
 *          row shows tokens per second and prompt tokens against the
 *          context window — the local equivalent of a cost column.
 *
 *   tool   An MCP tool being called, and its result.
 *
 *   data   A SQL query the data server ran, as reported by the tool: the
 *          statement, its parameters, rows returned and milliseconds. The
 *          layer below the tool, made visible.
 *
 *   warn   Nothing failed, but you should know: a guardrail layer acted, a
 *          tool call arrived as text, the context window is nearly full.
 *
 *   error  Something failed. Always shown prominently, because a silent
 *          failure in a teaching app teaches the wrong lesson.
 *
 * The line between warn and error is whether the thing that was asked for
 * still happened. A guardrail blocking an answer is a warn — the app did
 * exactly what it is meant to. Hitting the iteration cap is an error — the
 * question went unanswered.
 */
export type LogLevel = "info" | "model" | "tool" | "data" | "warn" | "error";

/**
 * Which way a logged event travelled, if it travelled at all.
 *
 * Separate from `level` because the two answer different questions.
 * Level says what KIND of thing happened; direction says WHO SENT IT TO
 * WHOM.
 *
 *   out   this app → the model. A request.
 *   in    the model → this app. A response.
 *   call  this app → a tool. A call into the data server.
 *   back  a tool → this app. Its result.
 *   none  neither; an internal note.
 *
 * The test: did data cross a boundary AT THE MOMENT this row was logged?
 * If not, the direction is "none", however much the row is ABOUT
 * something that crossed one. "The model asked for 2 tool calls" has no
 * direction — the response already arrived on the row above; this row is
 * our code reading it. Marking it "in" would make the panel claim a round
 * trip that never happened.
 */
export type LogDirection = "out" | "in" | "call" | "back" | "none";

/**
 * Whose decision a row records.
 *
 *   user   the person typing, or clicking an order number on the rep
 *          screen — which calls a tool with no model involved at all
 *   app    this server's own code, including the guardrail layers
 *   model  the local model, via something in its response
 *   tool   a tool in the data server
 *
 * Not the same question as direction. "The model asked for get_order" has
 * no direction but its actor is "model": the model made the decision even
 * though our code is what noticed it.
 */
export type LogActor = "user" | "app" | "model" | "tool";

/** One line in the activity log. */
export interface LogEvent {
  /** Which kind of event this is. Decides the colour and the tag text. */
  level: LogLevel;

  /** Which way it travelled. Absent means "none". */
  direction?: LogDirection;

  /** Whose decision it was. */
  actor?: LogActor;

  /**
   * Which model request this row belongs to, within the turn.
   *
   * Every row produced while handling iteration N carries N, including the
   * ones that are not themselves requests, so the panel can group a turn's
   * rows under the exchange that caused them.
   */
  iteration?: number;

  /**
   * Why this happened, as a fragment that completes "because…":
   * "the model's response asked for it", "the answer gate is on".
   */
  because?: string;

  /**
   * A short, human-readable summary — the whole of what the row shows by
   * default. A complete thought: "Calling llama3.2:3b", not "model_start".
   */
  label: string;

  /**
   * The full data behind the event: a request body, a tool result, a SQL
   * statement. Rendered collapsed. `unknown`, not `any`, so the rendering
   * code has to handle it defensively.
   */
  detail?: unknown;

  /**
   * When it happened, as milliseconds since the epoch. A number because
   * JSON has no date type; a Date would arrive as a string.
   */
  at: number;
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/**
 * Which guardrail layers are on for a turn.
 *
 * Travels WITH each chat request rather than living in server state, so
 * the transcript records exactly which layers applied to each turn, and
 * two browser tabs cannot change each other's settings.
 *
 * All three default to on. Switching one off is how you see what it was
 * stopping.
 */
export interface GuardrailSettings {
  /** Layer 1 (soft): the scoped system prompt. Off = a minimal prompt. */
  scopedPrompt: boolean;

  /** Layer 2 (medium): replies must be answer | clarify | refuse JSON. */
  structuredReplies: boolean;

  /** Layer 3 (medium): an answer is shown only if a tool succeeded. */
  answerGate: boolean;
}

/**
 * What kind of reply the transcript shows, decided after every layer has
 * had its say.
 *
 *   answer      the model's answer, shown as written
 *   clarify     the model asked a clarifying question
 *   refused     the model chose to refuse; the app shows its OWN canned
 *               refusal, never the model's text
 *   blocked     the answer gate replaced an answer that had no tool call
 *               behind it
 *   unfinished  the loop stopped (iteration cap, repeated call, a reply
 *               that would not parse) before producing a usable reply
 */
export type ReplyKind = "answer" | "clarify" | "refused" | "blocked" | "unfinished";

// ---------------------------------------------------------------------------
// The data layer, as reported to the app
// ---------------------------------------------------------------------------

/**
 * One SQL statement a tool ran, as the data server reports it.
 *
 * Carried in the tool result's `_meta` (under "checkpoint/queries"), not
 * in MCP logging notifications — those are deprecated in the current
 * protocol revision, and `_meta` arrives identically over stdio and HTTP.
 */
export interface QueryReport {
  /** The statement, with placeholders — never values spliced in. */
  sql: string;

  /**
   * The values bound to the placeholders: a list, in order, for `?`
   * placeholders; an object keyed by name for `:name` placeholders.
   */
  params: Array<string | number | null> | Record<string, string | number | null>;

  /** How many rows came back. */
  rows: number;

  /** How long the query took, in milliseconds. */
  ms: number;
}

// ---------------------------------------------------------------------------
// The rep screen
// ---------------------------------------------------------------------------

/**
 * One tool result, as the rep screen receives it.
 *
 * The screen picks a view by `tool` and renders `data` — the structured
 * result — directly. `summary` is the short text the MODEL was given;
 * the screen shows it only as a caption, so you can compare what the
 * model saw with what the tool actually returned.
 */
export interface ScreenEvent {
  /** The tool that produced this view, e.g. "list_orders". */
  tool: string;

  /** The arguments it was called with — shown in the screen's header. */
  args: Record<string, unknown>;

  /** The structured result. Shape depends on the tool; null on error. */
  data: unknown;

  /** The short text summary the model read. */
  summary: string;

  /** True when the tool returned an error result. */
  isError: boolean;

  /**
   * Who called the tool: the model during a turn, or the user clicking
   * through the rep screen directly.
   */
  calledBy: "model" | "user";

  /** When the result arrived, as milliseconds since the epoch. */
  at: number;
}

// ---------------------------------------------------------------------------
// The stream the browser receives
// ---------------------------------------------------------------------------

/**
 * Every message the server can send over the chat stream.
 *
 * A discriminated union: the `type` field says which variant it is, and
 * TypeScript narrows the rest once you check it. The browser's handler
 * switches on `type`, and the compiler complains if a variant added here
 * is not handled there.
 */
export type StreamEvent =
  /** A log row for the activity panel. */
  | { type: "log"; event: LogEvent }
  /**
   * A tool is about to run. Sent before the call, so the transcript can
   * show "looking up…" while it happens rather than a silent pause.
   */
  | {
      type: "tool_start";
      id: string;
      name: string;
      args: Record<string, unknown>;
      iteration: number;
    }
  /** A tool has finished, successfully or not. */
  | {
      type: "tool_end";
      id: string;
      name: string;
      isError: boolean;
      elapsedMs: number;
    }
  /** A tool result for the rep screen. */
  | { type: "screen"; screen: ScreenEvent }
  /**
   * The turn is complete.
   *
   * Carries what the transcript needs to badge the reply: its kind, which
   * layers were on, how many model requests it took, and the speed of the
   * local model — the figure that stands in for cost here.
   */
  | {
      type: "done";
      text: string;
      kind: ReplyKind;
      guardrails: GuardrailSettings;
      model: string;
      requests: number;
      elapsedMs: number;
      tokensPerSecond: number | null;
    }
  /** Something failed; the message is safe to show the user. */
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** The state of one piece the app depends on. */
export interface HealthCheck {
  ok: boolean;
  /** One sentence a learner can act on: what is wrong and how to fix it. */
  detail: string;
}

/**
 * What GET /api/health returns.
 *
 * Three checks reported separately, so a learner can see WHICH piece is
 * missing. "Ollama is not running" and "Ollama is running but the model is
 * not pulled" need different fixes, and a single red light hides that.
 */
export interface HealthReport {
  modelServer: HealthCheck;
  model: HealthCheck;
  dataServer: HealthCheck;
}
