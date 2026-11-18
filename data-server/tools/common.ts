/**
 * common.ts — pieces several tools share: schemas, row mapping, formatting.
 *
 * Sits beside types.ts at the bottom of the tool graph: definitions
 * import from here, and this file imports nothing from definitions/ or
 * the registry, so no cycle can form.
 *
 * Three kinds of thing live here:
 *
 *   Zod schemas for shapes that appear in more than one result (an
 *   address, a customer reference), each typed against the interface in
 *   shared/checkpoint.ts so the schema and the type cannot disagree.
 *
 *   Row mapping from SQL's snake_case columns to the camelCase shapes the
 *   rest of the app uses — done in one place so no tool gets it subtly
 *   different.
 *
 *   Formatting for the short text the MODEL reads. Money becomes "$129.95"
 *   here and only here; everywhere else it stays integer cents.
 */

import { z } from "zod";
import type { CustomerRef, OrderStatus, PostalAddress } from "../../shared/checkpoint.js";

/**
 * How many rows a text summary lists before saying "and N more".
 *
 * The structured result carries the whole table for the screen. The
 * model gets the first few lines and a count, which is enough to answer
 * or to ask a follow-up, and keeps a small context window from filling
 * with rows nobody will read.
 */
export const SUMMARY_ROWS = 5;

// --- Schemas -----------------------------------------------------------------

export const ORDER_STATUSES = [
  "pending", "processing", "shipped", "delivered", "cancelled", "returned",
] as const satisfies readonly OrderStatus[];

export const orderStatusSchema = z.enum(ORDER_STATUSES);

export const addressSchema: z.ZodType<PostalAddress> = z.object({
  id: z.number().int(),
  label: z.string(),
  street: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  isDefault: z.boolean(),
});

export const customerRefSchema: z.ZodType<CustomerRef> = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
});

/**
 * A calendar date argument, "YYYY-MM-DD".
 *
 * A regex rather than z.iso.date() so the error a model sees is plain:
 * small models often send "last month" or "11/01/2026", and the message
 * should say exactly what format to use instead.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD form, e.g. 2026-10-01.");

// --- Lenient arguments -----------------------------------------------------------

/*
 * Clients do not always send the JSON type the schema asks for. A small
 * model writes `"customer_id": "52"` as often as `52`; MCP Inspector's
 * CLI turns `order_number=10266` into the NUMBER 10266. Rejecting those
 * is technically correct and practically useless — it costs a retry, and
 * a small model may not manage the retry.
 *
 * These wrappers accept the obvious wrong-but-unambiguous form and
 * convert it BEFORE validation. The advertised JSON Schema does not
 * change — it still says "integer" or "string" — because `z.preprocess`
 * reports its inner schema. So clients are still told the right type;
 * they are just not punished for a near miss.
 *
 * Only unambiguous conversions: "52" → 52, 10266 → "10266", "true" →
 * true. Anything else is passed through untouched to fail validation
 * with the normal message.
 */

/** Accepts "52" for 52. */
export function lenientNumber<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v),
    schema,
  );
}

/** Accepts 10266 for "10266". */
export function lenientString<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (typeof v === "number" ? String(v) : v), schema);
}

/** Accepts "true" / "false" for true / false. */
export function lenientBoolean<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), schema);
}

// --- Row mapping ---------------------------------------------------------------

/** The address columns, as every tool SELECTs them. */
export const ADDRESS_COLUMNS = "a.id, a.label, a.street, a.city, a.state, a.zip, a.is_default";

/** An address row as SQLite returns it. */
export interface AddressRow {
  id: number; label: string; street: string; city: string;
  state: string; zip: string; is_default: number;
}

export function toAddress(row: AddressRow): PostalAddress {
  return {
    id: row.id,
    label: row.label,
    street: row.street,
    city: row.city,
    state: row.state,
    zip: row.zip,
    // SQLite has no boolean: 0 and 1 come back as numbers.
    isDefault: row.is_default === 1,
  };
}

// --- Normalising what models send ---------------------------------------------

/**
 * Accepts an order number the way people (and models) actually write it.
 *
 * The stored form is "CP-10234". Models send "10234", "cp-10234",
 * "CP10234" and "#10234". Rejecting those would be pedantry that costs a
 * retry; accepting them costs one line. Anything that is not a number
 * after the tidying is passed through unchanged, to fail the lookup
 * honestly with a message saying what the format is.
 */
export function normaliseOrderNumber(raw: string): string {
  const digits = raw.trim().replace(/^#/, "").replace(/^cp-?/i, "");
  return /^\d+$/.test(digits) ? `CP-${digits}` : raw.trim();
}

/** SKUs are stored upper-case; models often lower-case them. */
export function normaliseSku(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Escapes a user string for use inside a LIKE pattern.
 *
 * Without this, a search for "100%" matches everything that starts with
 * "100", and "_" matches any single character. The value is still BOUND
 * as a parameter — this is not about injection, it is about the search
 * meaning what was typed. Pair it with `ESCAPE '\'` in the SQL.
 */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// --- Formatting for the model --------------------------------------------------

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 12995 → "$129.95". The only place cents become dollars. */
export function money(cents: number): string {
  return dollars.format(cents / 100);
}

/** "2026-11-03T14:05:00Z" → "2026-11-03". Times are noise to the model. */
export function day(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** "…and 7 more" when a list was trimmed for the summary, else "". */
export function andMore(shown: number, total: number): string {
  return total > shown ? ` …and ${total - shown} more (shown on the rep screen).` : "";
}
