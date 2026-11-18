/**
 * get-customer.ts — one customer's full record, by id or by email.
 *
 * Returns the profile, the billing address, every shipping address, and
 * a few figures worked out from their orders: how many, how much they
 * have spent, when they last ordered. This is the rep screen's customer
 * card.
 *
 * ---------------------------------------------------------------------------
 * "customer_id OR email" — and why it is not a union
 * ---------------------------------------------------------------------------
 *
 * The natural Zod for "one or the other" is a union of two objects. That
 * becomes `anyOf` in the JSON Schema the model sees, and small models
 * handle `anyOf` badly: they send both, or neither, or an object shaped
 * like neither branch.
 *
 * So the schema is flat — two optional fields — and the rule is checked
 * here, in code, with an error message that says exactly what to send.
 * The model sees a simpler schema, and a mistake costs one retry with
 * clear instructions rather than an opaque validation failure.
 *
 * Small models also like to send `"email": ""` alongside a customer_id.
 * An empty string is treated as absent, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * An unknown customer IS an error
 * ---------------------------------------------------------------------------
 *
 * Unlike a search that finds nothing, a lookup by an exact key that does
 * not exist means the model has the key wrong. The error says so and
 * points at find_customers, which is how a small model recovers.
 */

import { z } from "zod";
import type { CustomerCard } from "../../../shared/checkpoint.js";
import {
  ADDRESS_COLUMNS, addressSchema, day, lenientNumber, money, toAddress, type AddressRow,
} from "../common.js";
import { ToolError, defineTool } from "../types.js";

const outputSchema: z.ZodType<CustomerCard> = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  joinedAt: z.string(),
  billingAddress: addressSchema,
  shippingAddresses: z.array(addressSchema),
  orderCount: z.number().int(),
  lifetimeSpendCents: z.number().int(),
  lastOrderAt: z.string().nullable(),
});

interface CustomerRow {
  id: number; first_name: string; last_name: string; email: string; phone: string; joined_at: string;
}

interface StatsRow { order_count: number; spend: number | null; last_order: string | null }

export const getCustomer = defineTool({
  name: "get_customer",
  title: "Get customer",

  description:
    "Gets one Checkpoint Outfitters customer's full record: contact details, " +
    "billing address, all shipping addresses, number of orders, lifetime spend " +
    "and last order date. Send EITHER customer_id OR email, not both. If you " +
    "only have a name, use find_customers first to get the id. Not for listing " +
    "orders (use list_orders).",

  inputSchema: z.object({
    customer_id: lenientNumber(z.number().int().positive()).optional()
      .describe("The customer's numeric id, e.g. 52, as returned by find_customers."),
    email: z.string().trim().optional()
      .describe("The customer's exact email address, e.g. \"sam.rivera@example.com\"."),
  }),

  outputSchema,

  run(input, db) {
    const email = input.email ? input.email : undefined; // "" counts as absent
    const id = input.customer_id;

    if (id === undefined && email === undefined) {
      throw new ToolError("Send either customer_id or email. If you only have a name, use find_customers first.");
    }
    if (id !== undefined && email !== undefined) {
      throw new ToolError("Send customer_id or email, not both.");
    }

    const customer = id !== undefined
      ? db.get<CustomerRow>("SELECT id, first_name, last_name, email, phone, joined_at FROM customers WHERE id = ?", id)
      // COLLATE NOCASE: emails are case-insensitive in practice, and a
      // model that capitalises one should not get "no such customer".
      : db.get<CustomerRow>("SELECT id, first_name, last_name, email, phone, joined_at FROM customers WHERE email = ? COLLATE NOCASE", email ?? "");

    if (!customer) {
      throw new ToolError(id !== undefined
        ? `No customer with id ${id}. Use find_customers to look the customer up by name.`
        : `No customer with email ${email}. Check the spelling, or use find_customers to search by name.`);
    }

    const addresses = db.all<AddressRow & { kind: string }>(
      `SELECT ${ADDRESS_COLUMNS}, a.kind FROM addresses a
       WHERE a.customer_id = ? ORDER BY a.kind, a.is_default DESC, a.id`,
      customer.id,
    );
    const billingRow = addresses.find((a) => a.kind === "billing");
    // The seed guarantees one; if it is missing the database is broken,
    // which is a bug to report, not something the model can fix.
    if (!billingRow) throw new Error(`Customer ${customer.id} has no billing address.`);

    // Lifetime spend leaves out cancelled and returned orders: that money
    // was refunded. Order COUNT includes them — they still happened.
    const stats = db.get<StatsRow>(
      `SELECT COUNT(*) AS order_count,
              SUM(CASE WHEN status NOT IN ('cancelled', 'returned') THEN total_cents END) AS spend,
              MAX(placed_at) AS last_order
       FROM orders WHERE customer_id = ?`,
      customer.id,
    ) ?? { order_count: 0, spend: null, last_order: null };

    const data: CustomerCard = {
      id: customer.id,
      name: `${customer.first_name} ${customer.last_name}`,
      email: customer.email,
      phone: customer.phone,
      joinedAt: customer.joined_at,
      billingAddress: toAddress(billingRow),
      shippingAddresses: addresses.filter((a) => a.kind === "shipping").map(toAddress),
      orderCount: stats.order_count,
      lifetimeSpendCents: stats.spend ?? 0,
      lastOrderAt: stats.last_order,
    };

    const b = data.billingAddress;
    const shipping = data.shippingAddresses
      .map((a) => `${a.label}${a.isDefault ? " (default)" : ""}: ${a.street}, ${a.city} ${a.state} ${a.zip}`)
      .join("; ");
    const orders = data.orderCount === 0
      ? "No orders."
      : `${data.orderCount} order${data.orderCount === 1 ? "" : "s"}, lifetime spend ` +
        `${money(data.lifetimeSpendCents)}, last order ${day(data.lastOrderAt ?? "")}.`;

    return {
      data,
      summary:
        `${data.name} (customer #${data.id}), ${data.email}, ${data.phone}. ` +
        `Customer since ${data.joinedAt}. ${orders} ` +
        `Billing: ${b.street}, ${b.city} ${b.state} ${b.zip}. ` +
        `Shipping addresses (${data.shippingAddresses.length}): ${shipping}.`,
    };
  },
});
