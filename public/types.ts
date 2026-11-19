/**
 * types.ts — the browser's view of the wire contract, plus its own UI types.
 *
 * Re-exports the shapes the server sends (from shared/types.ts and
 * shared/checkpoint.ts) so the browser modules import from one place, and
 * adds the few types that exist only in the UI.
 *
 * Every import from shared/ here is `import type` / `export type`. That is
 * load-bearing: type-only imports are erased at compile time, so the
 * browser never tries to fetch a shared/*.js module at runtime — and the
 * client tsconfig's `"types": []` keeps server code out of reach entirely.
 * Everything the UI knows arrives as JSON over the wire.
 */

import type { StreamEvent } from "../shared/types.js";

export type {
  ChatRequestBody, GuardrailSettings, HealthReport, HistoryTurn, LogEvent,
  ModelInfo, ModelsResponseBody, ReplyKind, ScreenEvent, StreamEvent, ToolCallResponseBody,
} from "../shared/types.js";

/** The stream's final event for a turn. */
export type DoneEvent = Extract<StreamEvent, { type: "done" }>;

export type {
  CustomerCard, CustomerSearchResult, OrderDetail, OrderListResult, ProductCard,
  ProductSearchResult, TopProductsResult,
} from "../shared/checkpoint.js";

/**
 * What a rep-screen view can ask for: open another screen by calling a
 * tool directly. Clicking an order number calls `open("get_order", …)`,
 * which goes through POST /api/tools/:name — no model involved.
 */
export interface ScreenContext {
  open(tool: string, args: Record<string, unknown>): void;
}
