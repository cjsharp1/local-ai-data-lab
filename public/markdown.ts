/**
 * markdown.ts — renders the small subset of Markdown that a model actually
 * uses in a chat reply.
 *
 * ---------------------------------------------------------------------------
 * Why not a Markdown library
 * ---------------------------------------------------------------------------
 *
 * Because a general Markdown renderer turns text into arbitrary HTML, and
 * the text here comes from a model whose output is influenced by whatever
 * the user typed and by whatever any tool returned. Markdown permits raw
 * HTML by default, so `<img src=x onerror=...>` in a reply becomes a real
 * element unless the output is also run through a sanitiser. That is two
 * dependencies and a configuration mistake away from an XSS hole.
 *
 * This renderer never produces HTML from the input. It walks the text,
 * recognises a fixed set of constructs, and builds DOM nodes with
 * createElement and textContent. Anything it does not recognise stays as
 * literal text. There is no path from input to markup, so there is
 * nothing to sanitise.
 *
 * The trade is real: no images, no links, no raw HTML. For a chat
 * transcript in a teaching app that is the right side of the trade.
 *
 * ---------------------------------------------------------------------------
 * What is supported
 * ---------------------------------------------------------------------------
 *
 *   # to ###        headings
 *   ```lang         fenced code blocks
 *   - or * or 1.    lists, including nesting by indentation
 *   > quote         blockquotes
 *   ---             horizontal rule
 *   | a | b |       tables, with alignment from the delimiter row
 *   **bold**        bold
 *   *italic*        italic
 *   `code`          inline code
 */

/** Builds a DocumentFragment from Markdown source. */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.split("\n");

  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    // --- Fenced code block ---------------------------------------------
    // Checked first: inside a fence, everything is literal, including
    // lines that would otherwise look like headings or lists.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      index += 1;

      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1; // step past the closing fence

      fragment.appendChild(buildCodeBlock(body.join("\n"), language));
      continue;
    }

    // --- Blank line ------------------------------------------------------
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // --- Horizontal rule -------------------------------------------------
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
      fragment.appendChild(document.createElement("hr"));
      index += 1;
      continue;
    }

    // --- Heading ---------------------------------------------------------
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // Capped at h6, and offset so a reply's "#" does not compete with
      // the page's own h1.
      const level = Math.min(6, heading[1]!.length + 2);
      const element = document.createElement(`h${level}`);
      element.className = "md-heading";
      appendInline(element, heading[2]!);
      fragment.appendChild(element);
      index += 1;
      continue;
    }

    // --- Blockquote ------------------------------------------------------
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        body.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      quote.appendChild(renderMarkdown(body.join("\n")));
      fragment.appendChild(quote);
      continue;
    }

    // --- Table -----------------------------------------------------------
    //
    // Checked before paragraphs, because a table's rows are consecutive
    // non-blank lines and the paragraph handler would otherwise swallow
    // them and join them into one run-on line.
    if (isTableStart(lines, index)) {
      const consumed = buildTable(lines, index);
      fragment.appendChild(consumed.element);
      index = consumed.nextIndex;
      continue;
    }

    // --- List ------------------------------------------------------------
    if (isListItem(line)) {
      const consumed = buildList(lines, index);
      fragment.appendChild(consumed.element);
      index = consumed.nextIndex;
      continue;
    }

    // --- Paragraph -------------------------------------------------------
    // Runs until a blank line or the start of another construct.
    const body: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !isListItem(lines[index]!) &&
      !/^(#{1,6})\s/.test(lines[index]!) &&
      !/^```/.test(lines[index]!) &&
      !/^>\s?/.test(lines[index]!) &&
      !/^(---+|\*\*\*+|___+)\s*$/.test(lines[index]!) &&
      // A table can begin on the line after a paragraph with no blank
      // line between them, which is how the collapsed-row bug happened:
      // the paragraph ran on and ate every row.
      !isTableStart(lines, index)
    ) {
      body.push(lines[index]!);
      index += 1;
    }

    const paragraph = document.createElement("p");
    paragraph.className = "md-p";
    appendInline(paragraph, body.join("\n"));
    fragment.appendChild(paragraph);
  }

  return fragment;
}

// --- Tables -----------------------------------------------------------------

/**
 * Is a table starting at this line?
 *
 * A table is recognised by its SECOND line rather than its first: the
 * delimiter row of dashes and optional colons. The first row on its own
 * is ambiguous — plain prose can contain pipe characters, and treating
 * every line with a `|` in it as a table would mangle ordinary text.
 *
 *     | Model | Cost |      <- could be anything
 *     |-------|------|      <- now it is definitely a table
 */
function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];

  if (!header || !delimiter) return false;
  if (!header.includes("|")) return false;

  // The delimiter row: pipes, dashes, colons and spaces only, with at
  // least one run of dashes.
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(delimiter) &&
    delimiter.includes("-");
}

/**
 * Splits a table row into cells.
 *
 * The leading and trailing pipes are optional in Markdown, so they are
 * trimmed before splitting rather than producing empty first and last
 * cells.
 */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Reads the alignment from the delimiter row.
 *
 *     :---   left      ---:   right      :---:  centre      ---  default
 */
function readAlignments(delimiter: string): Array<"left" | "right" | "center" | null> {
  return splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * Builds a table, returning it and the index of the first line after it.
 *
 * Wrapped in a scrolling container: a table with six columns will not
 * fit a chat bubble, and the alternative to scrolling it is the whole
 * page scrolling sideways.
 */
function buildTable(
  lines: string[],
  start: number,
): { element: HTMLElement; nextIndex: number } {
  const headers = splitRow(lines[start]!);
  const alignments = readAlignments(lines[start + 1]!);

  const wrapper = document.createElement("div");
  wrapper.className = "md-table-wrap";

  const table = document.createElement("table");
  table.className = "md-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  headers.forEach((cell, column) => {
    const th = document.createElement("th");
    const align = alignments[column];
    if (align) th.style.textAlign = align;
    // Inline formatting inside cells: **bold** and `code` are common in
    // a table of field names and values.
    appendInline(th, cell);
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let index = start + 2; // past the header and the delimiter

  while (index < lines.length) {
    const line = lines[index]!;
    // A blank line or a line with no pipe ends the table.
    if (line.trim() === "" || !line.includes("|")) break;

    const cells = splitRow(line);
    const row = document.createElement("tr");

    // Pad or trim to the header's column count. A ragged row is
    // malformed Markdown, but rendering four cells where the header has
    // three produces a visibly broken table, so normalise instead.
    for (let column = 0; column < headers.length; column += 1) {
      const td = document.createElement("td");
      const align = alignments[column];
      if (align) td.style.textAlign = align;
      appendInline(td, cells[column] ?? "");
      row.appendChild(td);
    }

    tbody.appendChild(row);
    index += 1;
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);

  return { element: wrapper, nextIndex: index };
}

/** Is this line the start of a list item? */
function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

/** How deeply a line is indented, in two-space units. */
function indentOf(line: string): number {
  const spaces = line.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0;
  return Math.floor(spaces / 2);
}

/**
 * Builds a list, recursing for nested items.
 *
 * Returns the element and the index of the first line it did not consume,
 * so the caller knows where to carry on.
 */
function buildList(
  lines: string[],
  start: number,
): { element: HTMLElement; nextIndex: number } {
  const first = lines[start]!;
  const baseIndent = indentOf(first);
  const ordered = /^\s*\d+[.)]\s+/.test(first);

  const list = document.createElement(ordered ? "ol" : "ul");
  list.className = "md-list";

  let index = start;
  let item: HTMLLIElement | null = null;

  while (index < lines.length) {
    const line = lines[index]!;

    // A blank line ends the list unless the next line continues it.
    if (line.trim() === "") {
      const next = lines[index + 1];
      if (next === undefined || !isListItem(next) || indentOf(next) < baseIndent) {
        break;
      }
      index += 1;
      continue;
    }

    if (!isListItem(line)) break;

    const indent = indentOf(line);

    // Dedent: this item belongs to an enclosing list.
    if (indent < baseIndent) break;

    // Indent: recurse, and hang the nested list off the current item.
    if (indent > baseIndent) {
      const nested = buildList(lines, index);
      (item ?? list).appendChild(nested.element);
      index = nested.nextIndex;
      continue;
    }

    item = document.createElement("li");
    appendInline(item, line.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
    list.appendChild(item);
    index += 1;
  }

  return { element: list, nextIndex: index };
}

/** Builds a code block with a language label. */
function buildCodeBlock(code: string, language: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "md-code-block";

  if (language) {
    const label = document.createElement("span");
    label.className = "md-code-lang";
    label.textContent = language;
    wrapper.appendChild(label);
  }

  const pre = document.createElement("pre");
  const codeElement = document.createElement("code");
  // textContent, so nothing in the code is ever interpreted as markup.
  codeElement.textContent = code;
  pre.appendChild(codeElement);
  wrapper.appendChild(pre);

  return wrapper;
}

/**
 * Appends inline-formatted text to an element.
 *
 * Handles `code`, **bold** and *italic*. Code is matched first and its
 * contents are not scanned further, so a `*` inside backticks stays
 * literal.
 *
 * Underscore emphasis only counts at a word boundary, which is what
 * CommonMark specifies, and what a naive pattern gets wrong. A sentence
 * naming two tools --
 *
 *   I called find_customers first, then list_orders.
 *
 * -- has two underscores in it, and a naive pattern pairs the one in
 * find_customers with the one in list_orders and italicises everything
 * between them. Identifiers with underscores are everywhere in this
 * app's replies (tool names, order_number, customer_id), so this is not
 * an edge case: it fires on ordinary sentences about what was looked up.
 *
 * Asterisk emphasis needs no such guard, because `*` does not appear
 * inside identifiers the way `_` does.
 *
 * Everything here goes through textContent. The regex decides which
 * ELEMENT to create; it never decides what HTML to write.
 */
function appendInline(parent: HTMLElement, text: string): void {
  // One pass, alternating between the next match and the text before it.
  // The (?<![A-Za-z0-9]) / (?![A-Za-z0-9]) guards on the underscore
  // forms are what keep intra-word underscores literal: an opening `_`
  // may not follow an alphanumeric, and a closing `_` may not precede
  // one. So list_orders stays list_orders, while _emphasis_ between spaces
  // still works.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|((?<![A-Za-z0-9])__[^_\n]+__(?![A-Za-z0-9]))|((?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9]))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(
        document.createTextNode(text.slice(lastIndex, match.index)),
      );
    }

    const token = match[0];

    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.className = "md-code";
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}
