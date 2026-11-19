/**
 * get-order.ts — one order in full: who, where it went, every line, totals.
 *
 * The rep screen's order detail. Takes an order number in whatever form a
 * person or a model writes it ("CP-10234", "10234", "cp10234") and
 * normalises it before the lookup — see normaliseOrderNumber in common.ts.
 *
 * ---------------------------------------------------------------------------
 * What was paid versus what it costs now
 * ---------------------------------------------------------------------------
 *
 * Each line's price comes from order_items.unit_price_cents — the price
 * snapshotted at the moment of sale — NOT from products.price_cents,
 * which is today's price. Some older orders in this data paid less than
 * the current price, deliberately, so the difference is visible.
 *
 * Both figures are returned. The screen can show "paid $119.95 (now
 * $129.95)", and the model's summary mentions it when they differ, so a
 * question like "why is this order's total lower than the prices on the
 * site?" has an answer in the data.
 *
 * A discontinued product still appears on old orders, flagged: removing
 * a product from sale does not rewrite the history of who bought it.
 */

import { z } from "zod";
import type { OrderDetail, OrderLine } from "../../../shared/checkpoint.js";
import {
  ADDRESS_COLUMNS, SUMMARY_ROWS, addressSchema, andMore, customerRefSchema, day, lenientString,
  money, normaliseOrderNumber, orderStatusSchema, toAddress, type AddressRow,
} from "../common.js";
import { ToolError, defineTool } from "../types.js";

const outputSchema: z.ZodType<OrderDetail> = z.object({
  orderNumber: z.string(),
  placedAt: z.string(),
  status: orderStatusSchema,
  customer: customerRefSchema,
  shippingAddress: addressSchema,
  lines: z.array(z.object({
    sku: z.string(),
    name: z.string(),
    quantity: z.number().int(),
    unitPriceCents: z.number().int(),
    lineTotalCents: z.number().int(),
    currentPriceCents: z.number().int(),
    discontinued: z.boolean(),
  })),
  subtotalCents: z.number().int(),
  shippingCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
});

interface OrderHeader {
  id: number; order_number: string; placed_at: string; status: OrderDetail["status"];
  customer_id: number; customer_name: string; email: string; shipping_address_id: number;
  subtotal_cents: number; shipping_cents: number; tax_cents: number; total_cents: number;
}

interface LineRow {
  sku: string; name: string; quantity: number; unit_price_cents: number;
  price_cents: number; discontinued: number;
}

export const getOrder = defineTool({
  name: "get_order",
  title: "Get order",

  description:
    "Gets one Checkpoint Outfitters order in full: customer, status, shipping " +
    "address, every line item with product name, quantity and price paid, and " +
    "the totals. Needs the order number, e.g. CP-10234. If you do not have an " +
    "order number, use list_orders first to find it.",

  inputSchema: z.object({
    // lenientString: "10266" and 10266 both arrive here as the string
    // "10266" — MCP Inspector's CLI and small models both send the number.
    order_number: lenientString(z.string().trim().min(1))
      .describe("The order number, e.g. \"CP-10234\"."),
  }),

  outputSchema,

  run({ order_number }, db) {
    const number = normaliseOrderNumber(order_number);

    const order = db.get<OrderHeader>(
      `SELECT o.id, o.order_number, o.placed_at, o.status, o.customer_id,
              c.first_name || ' ' || c.last_name AS customer_name, c.email,
              o.shipping_address_id,
              o.subtotal_cents, o.shipping_cents, o.tax_cents, o.total_cents
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.order_number = ?`,
      number,
    );
    if (!order) {
      throw new ToolError(
        `No order ${number}. Order numbers look like CP-10234. ` +
        "Use list_orders to find a customer's orders.");
    }

    const address = db.get<AddressRow>(
      `SELECT ${ADDRESS_COLUMNS} FROM addresses a WHERE a.id = ?`,
      order.shipping_address_id,
    );
    // The composite foreign key guarantees this exists; missing means a
    // broken database — a bug, not something the model can fix.
    if (!address) throw new Error(`Order ${number} points at a missing address.`);

    const lineRows = db.all<LineRow>(
      `SELECT p.sku, p.name, i.quantity, i.unit_price_cents, p.price_cents, p.discontinued
       FROM order_items i JOIN products p ON p.id = i.product_id
       WHERE i.order_id = ? ORDER BY i.id`,
      order.id,
    );

    const lines: OrderLine[] = lineRows.map((l) => ({
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unitPriceCents: l.unit_price_cents,
      lineTotalCents: l.quantity * l.unit_price_cents,
      currentPriceCents: l.price_cents,
      discontinued: l.discontinued === 1,
    }));

    const data: OrderDetail = {
      orderNumber: order.order_number,
      placedAt: order.placed_at,
      status: order.status,
      customer: { id: order.customer_id, name: order.customer_name, email: order.email },
      shippingAddress: toAddress(address),
      lines,
      subtotalCents: order.subtotal_cents,
      shippingCents: order.shipping_cents,
      taxCents: order.tax_cents,
      totalCents: order.total_cents,
    };

    const a = data.shippingAddress;
    const shown = lines.slice(0, SUMMARY_ROWS);
    const lineText = shown.map((l) =>
      `- ${l.quantity} × ${l.name} (${l.sku}) at ${money(l.unitPriceCents)}` +
      (l.currentPriceCents !== l.unitPriceCents ? ` (price now ${money(l.currentPriceCents)})` : "") +
      (l.discontinued ? " [discontinued]" : ""),
    ).join("\n");

    return {
      data,
      summary:
        `Order ${data.orderNumber}, placed ${day(data.placedAt)} by ${data.customer.name} ` +
        `(customer #${data.customer.id}). Status: ${data.status}. ` +
        `Ships to ${a.label}: ${a.street}, ${a.city} ${a.state} ${a.zip}.\n` +
        `${lines.length} line${lines.length === 1 ? "" : "s"}:\n${lineText}` +
        andMore(shown.length, lines.length, lines.length) +
        `\nSubtotal ${money(data.subtotalCents)}, shipping ${money(data.shippingCents)}, ` +
        `tax ${money(data.taxCents)}, total ${money(data.totalCents)}.`,
    };
  },
});
