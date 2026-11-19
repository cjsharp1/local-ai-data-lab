/**
 * find-customers.ts — search customers by a fragment of name, email or phone.
 *
 * The entry point for most questions about a person. The user says
 * "Sam Rivera" or "the customer on 555-0142"; this turns that into a
 * short list with ids, which get_customer and list_orders can then use.
 *
 * Teaches two things:
 *
 *   An EMPTY result is not an error. "No customer matches" is a correct,
 *   complete answer, and it comes back as an ordinary result. Errors are
 *   for calls the model got wrong and can fix (an unknown email on a
 *   lookup); a search that finds nothing did nothing wrong.
 *
 *   More than one match is the model's cue to ASK. Two customers are both
 *   called Sam Rivera; the summary says so in as many words, because a
 *   small model will otherwise pick the first one and answer confidently
 *   about the wrong person.
 *
 * The query must be at least 2 characters, ON PURPOSE: there is no way to
 * ask this tool for "every customer". When a prompt injection hidden in a
 * product description told the model to list every customer's email, the
 * model tried — `find_customers({ query: "", limit: 100 })` — and this
 * schema, with its 20-row cap, is what refused it. The model did not
 * notice the attack; the narrow tool did not need it to.
 *
 * The SQL is fixed text with bound parameters, like every tool here.
 * Optional parts are switched off by binding NULL rather than by building
 * a different string — see the phone clause below.
 */

import { z } from "zod";
import type { CustomerSearchResult, CustomerSummary } from "../../../shared/checkpoint.js";
import { SUMMARY_ROWS, andMore, lenientNumber, lenientString, likePattern } from "../common.js";
import { defineTool } from "../types.js";

const outputSchema: z.ZodType<CustomerSearchResult> = z.object({
  query: z.string(),
  matches: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    city: z.string(),
    state: z.string(),
    orderCount: z.number().int(),
  })),
  total: z.number().int(),
});

interface Row {
  id: number; name: string; email: string; city: string; state: string;
  order_count: number; total: number;
}

/**
 * The search.
 *
 * `COUNT(*) OVER ()` is a window function: it counts every row the WHERE
 * clause matched, computed BEFORE the LIMIT trims them, and repeats that
 * number on each returned row. One query gives both the page of results
 * and "how many in total", instead of running the search twice.
 *
 * The phone clause compares digits only, so "(303) 555-0142", "303-555-
 * 0142" and "5550142" all find the same customer. When the query has
 * fewer than three digits its parameter is NULL, and `x LIKE NULL` is
 * never true — the clause switches itself off without changing the SQL.
 */
const SQL = `
  SELECT c.id,
         c.first_name || ' ' || c.last_name AS name,
         c.email,
         a.city,
         a.state,
         (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count,
         COUNT(*) OVER () AS total
  FROM customers c
  JOIN addresses a ON a.customer_id = c.id AND a.kind = 'billing'
  WHERE c.first_name || ' ' || c.last_name LIKE ? ESCAPE '\\'
     OR c.email LIKE ? ESCAPE '\\'
     OR replace(replace(replace(replace(c.phone, '(', ''), ')', ''), ' ', ''), '-', '') LIKE ?
  ORDER BY c.last_name, c.first_name, c.id
  LIMIT ?`;

function line(c: CustomerSummary): string {
  const orders = c.orderCount === 1 ? "1 order" : `${c.orderCount} orders`;
  return `#${c.id} ${c.name} — ${c.email}, ${c.city} ${c.state}, ${orders}`;
}

export const findCustomers = defineTool({
  name: "find_customers",
  title: "Find customers",

  description:
    "Searches Checkpoint Outfitters customers by part of a name, an email " +
    "address, or a phone number, and returns matching customers with their " +
    "id, email, city and order count. Use it first when the user names a " +
    "person, or gives an email or phone you need to look up. If several " +
    "customers match, ask the user which one they mean. Not for full details " +
    "(use get_customer), orders (use list_orders), or listing customers by place, " +
    "spend or purchases (use customer_segment).",

  inputSchema: z.object({
    query: lenientString(z.string().trim().min(2))
      .describe("Part of a customer's name, email or phone number, e.g. \"Rivera\" or \"555-0142\". At least 2 characters."),
    limit: lenientNumber(z.number().int().min(1).max(20)).default(10)
      .describe("Most customers to return, 1 to 20. Defaults to 10."),
  }),

  outputSchema,

  run({ query, limit }, db) {
    const digits = query.replace(/\D/g, "");
    const rows = db.all<Row>(
      SQL,
      likePattern(query),
      likePattern(query),
      digits.length >= 3 ? `%${digits}%` : null,
      limit,
    );

    const matches: CustomerSummary[] = rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, city: r.city, state: r.state,
      orderCount: r.order_count,
    }));
    const total = rows[0]?.total ?? 0;
    const data: CustomerSearchResult = { query, matches, total };

    if (total === 0) {
      return {
        data,
        summary: `No customers match "${query}". Try part of a surname, an email address, or a phone number.`,
      };
    }

    const first = matches[0];
    if (total === 1 && first) {
      return {
        data,
        summary: `1 customer matches "${query}": ${line(first)}. ` +
          `Use get_customer with customer_id ${first.id} for full details.`,
      };
    }

    const shown = matches.slice(0, SUMMARY_ROWS);
    return {
      data,
      summary:
        `${total} customers match "${query}" — more than one, so ask the user ` +
        `which they mean before going further:\n` +
        shown.map((c) => `- ${line(c)}`).join("\n") +
        andMore(shown.length, total),
    };
  },
});
