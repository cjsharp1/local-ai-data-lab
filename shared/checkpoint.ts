/**
 * checkpoint.ts — the shapes of the seven tools' structured results.
 *
 * The data server returns two things from every tool call: a short text
 * summary for the MODEL, and a structured result for everything else.
 * This file describes the structured half — a customer card, a table of
 * orders, an order's line items — which is what the rep screen renders.
 *
 * Types only; it compiles to nothing. It lives in shared/ because three
 * places must agree on these shapes and none of them may import from the
 * others:
 *
 *   data-server/   builds them (its Zod output schemas are typed against
 *                  these interfaces, so they cannot drift apart)
 *   server/        passes them through untouched
 *   public/        renders them on the rep screen
 *
 * Money is integer cents throughout, exactly as stored. Formatting to
 * dollars happens only at the moment of display.
 */

/** A customer in a list of search matches. */
export interface CustomerSummary {
  id: number;
  name: string;
  email: string;
  city: string;
  state: string;
  orderCount: number;
}

/** A postal address, billing or shipping. */
export interface PostalAddress {
  id: number;
  label: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  isDefault: boolean;
}

/** The minimum needed to say whose order something is. */
export interface CustomerRef {
  id: number;
  name: string;
  email: string;
}

/** find_customers */
export interface CustomerSearchResult {
  query: string;
  matches: CustomerSummary[];
  /** How many customers matched in total, before the limit. */
  total: number;
}

/** get_customer */
export interface CustomerCard {
  id: number;
  name: string;
  email: string;
  phone: string;
  joinedAt: string;
  billingAddress: PostalAddress;
  shippingAddresses: PostalAddress[];
  orderCount: number;
  /** Sum of order totals, excluding cancelled and returned orders. */
  lifetimeSpendCents: number;
  lastOrderAt: string | null;
}

/** One row in a table of orders. */
export interface OrderRow {
  orderNumber: string;
  placedAt: string;
  status: OrderStatus;
  customerName: string;
  itemCount: number;
  totalCents: number;
}

export type OrderStatus =
  | "pending" | "processing" | "shipped" | "delivered" | "cancelled" | "returned";

/** list_orders */
export interface OrderListResult {
  /** Set when the orders were filtered to one customer. */
  customer: CustomerRef | null;
  orders: OrderRow[];
  /** How many orders matched in total, before the limit. */
  total: number;
}

/** One line on an order. */
export interface OrderLine {
  sku: string;
  name: string;
  quantity: number;
  /** What was PAID per unit — a snapshot, not today's price. */
  unitPriceCents: number;
  lineTotalCents: number;
  /** Today's price, so the screen can show when the two differ. */
  currentPriceCents: number;
  discontinued: boolean;
}

/** get_order */
export interface OrderDetail {
  orderNumber: string;
  placedAt: string;
  status: OrderStatus;
  customer: CustomerRef;
  shippingAddress: PostalAddress;
  lines: OrderLine[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

/** One row in a table of products. */
export interface ProductRow {
  sku: string;
  name: string;
  category: string;
  brand: string;
  priceCents: number;
  discontinued: boolean;
}

/** find_products */
export interface ProductSearchResult {
  products: ProductRow[];
  /** How many products matched in total, before the limit. */
  total: number;
}

/** get_product */
export interface ProductCard extends ProductRow {
  weightGrams: number;
  color: string;
  /** Free text from the database — untrusted, like every tool result. */
  description: string;
  /** Units on orders that were not cancelled. */
  unitsSold: number;
  orderCount: number;
  lastOrderedAt: string | null;
}

/** One product in a sales ranking. */
export interface TopProductRow {
  rank: number;
  sku: string;
  name: string;
  category: string;
  brand: string;
  discontinued: boolean;
  /** Units on orders that were not cancelled, in the period. */
  unitsSold: number;
  orderCount: number;
  /** What those units were sold for — the price snapshots, not today's price. */
  revenueCents: number;
}

/** top_products */
export interface TopProductsResult {
  products: TopProductRow[];
  /** The filters applied, echoed back so the screen can say what it ranked. */
  fromDate: string | null;
  toDate: string | null;
  category: string | null;
}

/**
 * The key under which the data server reports its SQL, in each tool
 * result's `_meta`. Namespaced, as the MCP spec asks of custom keys, so
 * it cannot collide with anything the protocol itself puts there.
 */
export const QUERIES_META_KEY = "checkpoint/queries";
