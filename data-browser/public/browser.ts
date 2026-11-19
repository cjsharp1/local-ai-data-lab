/**
 * browser.ts — the data browser page: every table, every row.
 *
 * Pick a table on the left; its rows fill the grid. Click a column heading
 * to sort; type to search every column at once; click a foreign-key value
 * (an order's customer_id, say) to jump to that row in its own table.
 * The table's commented definition from schema.sql sits above the grid,
 * and the exact SQL behind the current view is shown under it — this is
 * a page for looking at data AND at how it is queried.
 *
 * Self-contained on purpose: it does not import the app's modules,
 * because it is served by a different server from a different folder,
 * and keeping the two apart is the point (see server.ts). The small `el`
 * helper below is the same idea as public/dom.ts — text only, never
 * innerHTML, which matters for a page that shows a deliberately injected
 * product description verbatim.
 */

interface Column { name: string; type: string; pk: boolean }
interface ForeignKey { from: string; table: string; to: string }
interface TableInfo { name: string; rows: number; columns: Column[]; foreignKeys: ForeignKey[]; schema: string }
interface Page {
  table: string; total: number; offset: number; limit: number; sort: string; dir: "asc" | "desc";
  rows: Array<Record<string, unknown>>; sql: string; params: Record<string, unknown>;
}

/** Where the browser is: which table, and how it is filtered, sorted and paged. */
const view = {
  table: "",
  sort: "",
  dir: "asc" as "asc" | "desc",
  q: "",
  col: "",
  eq: "",
  offset: 0,
};

let tables: TableInfo[] = [];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: { class?: string; text?: string; title?: string } = {}, children: Array<Node | string | null> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

/** A cell's text. Cents columns also show dollars, since that is how people read money. */
function cellText(column: string, value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (column.endsWith("_cents") && typeof value === "number") {
    return `${value}  ($${(value / 100).toFixed(2)})`;
  }
  return String(value);
}

// --- Sidebar ----------------------------------------------------------------------

function renderSidebar(): void {
  byId("tables").replaceChildren(...tables.map((t) => {
    const button = el("button", { class: t.name === view.table ? "current" : "" }, [
      el("span", { text: t.name }),
      el("span", { class: "count", text: String(t.rows) }),
    ]);
    button.addEventListener("click", () => openTable(t.name));
    return el("li", {}, [button]);
  }));
}

function openTable(name: string, filter?: { col: string; eq: string }): void {
  Object.assign(view, { table: name, sort: "", dir: "asc", q: "", col: filter?.col ?? "", eq: filter?.eq ?? "", offset: 0 });
  byId<HTMLInputElement>("search").value = "";
  renderSidebar();
  const info = tables.find((t) => t.name === name);
  byId("schema").textContent = info?.schema ?? "";
  void load();
}

// --- Grid -------------------------------------------------------------------------

async function load(): Promise<void> {
  const params = new URLSearchParams();
  if (view.sort) params.set("sort", view.sort);
  params.set("dir", view.dir);
  if (view.q) params.set("q", view.q);
  if (view.col) { params.set("col", view.col); params.set("eq", view.eq); }
  params.set("offset", String(view.offset));

  const page = (await (await fetch(`/api/tables/${view.table}?${params}`)).json()) as Page;
  view.sort = page.sort;
  view.dir = page.dir;
  renderGrid(page);
}

function renderGrid(page: Page): void {
  const info = tables.find((t) => t.name === page.table);
  if (!info) return;
  const fkByColumn = new Map(info.foreignKeys.map((f) => [f.from, f]));

  const head = el("tr", {}, info.columns.map((c) => {
    const arrow = c.name === page.sort ? (page.dir === "asc" ? " ▲" : " ▼") : "";
    const fk = fkByColumn.get(c.name);
    const th = el("th", { title: `${c.type || "?"}${c.pk ? " · primary key" : ""}${fk ? ` · → ${fk.table}.${fk.to}` : ""}` }, [
      el("button", { text: c.name + arrow }),
    ]);
    th.addEventListener("click", () => {
      view.dir = view.sort === c.name && view.dir === "asc" ? "desc" : "asc";
      view.sort = c.name;
      view.offset = 0;
      void load();
    });
    return th;
  }));

  const body = page.rows.map((row) => el("tr", {}, info.columns.map((c) => {
    const value = row[c.name];
    const fk = fkByColumn.get(c.name);
    const td = el("td", { class: typeof value === "number" ? "num" : value === null ? "null" : "" });
    if (fk && value !== null && value !== undefined) {
      const link = el("button", { class: "fk", text: String(value), title: `Open ${fk.table} where ${fk.to} = ${value}` });
      link.addEventListener("click", () => openTable(fk.table, { col: fk.to, eq: String(value) }));
      td.append(link);
    } else {
      td.textContent = cellText(c.name, value);
    }
    return td;
  })));

  byId("grid").replaceChildren(el("thead", {}, [head]), el("tbody", {}, body));

  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = page.offset + page.rows.length;
  const filter = view.col ? ` · ${view.col} = ${view.eq}` : "";
  byId("status").textContent = `${page.table}: rows ${from}–${to} of ${page.total}${filter}${view.q ? ` · matching "${view.q}"` : ""}`;
  byId<HTMLButtonElement>("prev").disabled = page.offset === 0;
  byId<HTMLButtonElement>("next").disabled = to >= page.total;
  byId("clear-filter").hidden = !view.col;
  byId("sql").textContent = `${page.sql}\n-- params: ${JSON.stringify(page.params)}`;
}

// --- Start --------------------------------------------------------------------------

async function init(): Promise<void> {
  tables = ((await (await fetch("/api/tables")).json()) as { tables: TableInfo[] }).tables;

  let timer: number | undefined;
  byId<HTMLInputElement>("search").addEventListener("input", (e) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      view.q = (e.target as HTMLInputElement).value.trim();
      view.offset = 0;
      void load();
    }, 250);
  });
  byId("prev").addEventListener("click", () => { view.offset = Math.max(0, view.offset - 100); void load(); });
  byId("next").addEventListener("click", () => { view.offset += 100; void load(); });
  byId("clear-filter").addEventListener("click", () => { view.col = ""; view.eq = ""; view.offset = 0; void load(); });

  openTable(tables[0]?.name ?? "customers");
}

void init();
