/**
 * sales-report.ts — rep screen view for sales_report: totals by a grouping.
 *
 * A table with a bar for the chosen metric, plus units, orders and
 * revenue for every row whichever metric was chosen — so "top products
 * by revenue" also shows that the revenue leader is not the units
 * leader. The heading says exactly what was measured, grouped and
 * filtered, because a total is meaningless without its definition.
 *
 * Products link to their card (get_product) and customers to theirs
 * (get_customer), called directly — no model.
 */

import { day, el, money } from "../../dom.js";
import type { SalesReportResult, ScreenContext } from "../../types.js";
import { link } from "./parts.js";

const METRIC_LABEL: Record<SalesReportResult["metric"], string> = {
  units: "Units sold",
  revenue: "Revenue",
  gross: "Gross sales",
  orders: "Orders",
  customers: "Customers",
  avg_order_value: "Average order value",
};

export function renderSalesReport(data: SalesReportResult, ctx: ScreenContext): HTMLElement {
  const f = data.filters;
  const scope = [
    f.category ? `category "${f.category}"` : "",
    f.status ? `status ${f.status}` : data.groupBy === "status" ? "every status" : "cancelled excluded",
    f.fromDate ? `from ${day(f.fromDate)}` : "",
    f.toDate ? `to ${day(f.toDate)}` : "",
  ].filter(Boolean).join(" · ");
  const isTime = data.groupBy === "week" || data.groupBy === "month" || data.groupBy === "year";
  const order = isTime ? "oldest first" : f.lowest ? "lowest first" : "highest first";
  const heading = el("p", { class: "screen-count", text:
    `${METRIC_LABEL[data.metric]} by ${data.groupBy} · ${order} · ${scope} · ${data.rows.length} of ${data.totalGroups}` });

  if (data.rows.length === 0) {
    return el("div", {}, [heading, el("p", { class: "screen-empty-note", text: "No sales match." })]);
  }

  const isMoney = data.metric === "revenue" || data.metric === "gross" || data.metric === "avg_order_value";
  const fmt = (v: number) => (isMoney ? money(v) : String(v));
  const max = Math.max(...data.rows.map((r) => r.value), 1);

  const nameCell = (r: SalesReportResult["rows"][number]) => {
    if (data.groupBy === "product") return [link(r.key, () => ctx.open("get_product", { sku: r.key })), ` ${r.label}`];
    if (data.groupBy === "customer") return [link(r.label, () => ctx.open("get_customer", { customer_id: Number(r.key) }))];
    return [r.label];
  };

  const rows = data.rows.map((r) =>
    el("tr", {}, [
      el("td", { class: "num", text: isTime ? "" : String(r.rank) }),
      el("td", {}, nameCell(r)),
      el("td", { class: "num strong-col", text: fmt(r.value) }),
      el("td", { class: "bar-cell" }, [
        el("span", { class: "bar", attrs: { style: `width:${Math.round((r.value / max) * 100)}%` } }),
      ]),
      el("td", { class: "num", text: String(r.units) }),
      el("td", { class: "num", text: String(r.orders) }),
      el("td", { class: "num", text: money(r.revenueCents) }),
    ]),
  );

  const groupHeader = data.groupBy[0]?.toUpperCase() + data.groupBy.slice(1);
  return el("div", {}, [
    heading,
    el("table", { class: "grid" }, [
      el("thead", {}, [el("tr", {}, ["#", groupHeader, METRIC_LABEL[data.metric], "", "Units", "Orders", "Revenue"].map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}
