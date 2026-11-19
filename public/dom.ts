/**
 * dom.ts — the one way this UI builds elements, and the formatting it shares.
 *
 * Every element the app creates goes through `el()`, which sets text with
 * `textContent` and never touches `innerHTML`. That matters here more than
 * in most apps: almost everything on screen came from a model, a tool or
 * the database, and one of the seeded products carries a deliberate prompt
 * injection in its description. Text that is only ever assigned as text
 * cannot become markup, whatever it says.
 *
 * Also the formatting the screen and chat share — money from integer
 * cents, dates from ISO strings — so "$129.95" is produced in exactly one
 * place in the browser, as it is in one place on the server.
 */

/** A child: a node, a string (becomes a text node), or nothing. */
export type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

/** Creates an element with text and children — never via innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Looks up a required element by id, failing loudly if index.html changed. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html has no #${id}`);
  return node as T;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 12995 → "$129.95". */
export function money(cents: number): string {
  return dollars.format(cents / 100);
}

/** "2026-11-03T14:05:00Z" → "Nov 3, 2026". */
export function day(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "14:05:09" — for log rows. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}
