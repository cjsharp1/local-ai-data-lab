/**
 * checkpoint.ts — the shapes of the eight tools' structured results.
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

/** One product in a catalogue search: the row, plus what it can be filtered and sorted by. */
export interface ProductMatch extends ProductRow {
  weightGrams: number;
  color: string;
  /** Units on orders that were not cancelled. */
  unitsSold: number;
  lastSoldAt: string | null;
}

/** find_products */
export interface ProductSearchResult {
  products: ProductMatch[];
  /** How many products matched in total, before the limit. */
  total: number;
  sortBy: string;
  lowestFirst: boolean;
  availability: "for_sale" | "discontinued" | "all";
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

/** One group in a sales report — a product, a month, a customer… */
export interface SalesReportRow {
  /** Position in the ranking (or in time, for months). */
  rank: number;
  /** The group's identity: a SKU, a category, "2026-10", a customer id… */
  key: string;
  /** What to show: a product name, a customer's name, the key again… */
  label: string;
  /** The chosen metric — cents for revenue and average order value. */
  value: number;
  /** Every metric, so the screen can show them all whichever was chosen. */
  units: number;
  revenueCents: number;
  orders: number;
}

/** sales_report */
export interface SalesReportResult {
  metric: "units" | "revenue" | "orders" | "avg_order_value";
  groupBy: "product" | "category" | "brand" | "customer" | "month" | "state";
  rows: SalesReportRow[];
  /** How many groups matched in total, before the limit. */
  totalGroups: number;
  /** The filters applied, echoed back so the screen can say what it measured. */
  filters: {
    fromDate: string | null;
    toDate: string | null;
    category: string | null;
    status: string | null;
    lowest: boolean;
  };
}

/** One customer in a segment. */
export interface SegmentCustomer {
  id: number;
  name: string;
  /** For the rep screen only — never put in the text the model reads. */
  email: string;
  /** For the rep screen only — never put in the text the model reads. */
  phone: string;
  city: string;
  state: string;
  joinedAt: string;
  orderCount: number;
  /** Excluding cancelled and returned orders, as on the customer card. */
  lifetimeSpendCents: number;
  lastOrderAt: string | null;
}

/** customer_segment */
export interface CustomerSegmentResult {
  customers: SegmentCustomer[];
  /** How many customers matched in total, before the limit. */
  total: number;
  /** The filters applied, as given — so the screen can say what was asked. */
  filters: Record<string, string | number | boolean>;
  sortBy: string;
  lowestFirst: boolean;
}

/**
 * The key under which the data server reports its SQL, in each tool
 * result's `_meta`. Namespaced, as the MCP spec asks of custom keys, so
 * it cannot collide with anything the protocol itself puts there.
 */
export const QUERIES_META_KEY = "checkpoint/queries";
