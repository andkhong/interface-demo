// Runs INSIDE each browser frame and installs window.__cua.
//
// Plain JavaScript on purpose: it is injected into the page as text.
// The same functions are used when the AI looks at the page (discovery) and when
// replay looks for a control, so both always agree on "role", "name" and "row label".
(() => {
  if (window.__cua) return;

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const TEXTBOX_TYPES = new Set(["", "text", "password", "email", "number", "search", "tel", "url"]);
  const BUTTON_TYPES = new Set(["submit", "button", "reset", "image"]);
  const CONTROL_SELECTOR = "a[href], button, input:not([type=hidden]), select, textarea";
  const CONTROL_ROLES = new Set(["link", "button", "textbox", "combobox", "checkbox", "radio"]);

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function hasControlsOrTables(el) {
    return !!el.querySelector(`${CONTROL_SELECTOR}, table`);
  }

  // ---------- role, name, labels ----------

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (BUTTON_TYPES.has(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (TEXTBOX_TYPES.has(type)) return "textbox";
      return null;
    }
    if ((tag === "td" || tag === "th") && !hasControlsOrTables(el) && norm(el.innerText)) return "cell";
    return null;
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((e) => e.innerText)
        .join(" ");
      if (norm(text)) return norm(text);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && BUTTON_TYPES.has(type)) {
        return norm(el.getAttribute("value") || el.getAttribute("alt") || (type === "submit" ? "Submit" : ""));
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && norm(label.innerText)) return norm(label.innerText);
      }
      const wrapping = el.closest("label");
      if (wrapping && norm(wrapping.innerText)) return norm(wrapping.innerText);
      return norm(el.getAttribute("title") || el.getAttribute("placeholder") || "");
    }
    if (tag === "img") return norm(el.getAttribute("alt"));
    return norm(el.innerText || el.getAttribute("title") || "");
  }

  // The text of the first plain-text cell to the left of this element in its table row.
  function rowLabelOf(el) {
    const cell = el.closest("td, th");
    const row = el.closest("tr");
    if (!cell || !row) return null;
    for (const c of row.cells) {
      if (c === cell) break;
      if (!hasControlsOrTables(c) && norm(c.innerText)) return norm(c.innerText);
    }
    return null;
  }

  // For grid tables (3+ columns): the column header above a cell.
  function columnHeaderOf(cell) {
    const row = cell.parentElement;
    const table = cell.closest("table");
    const index = Array.prototype.indexOf.call(row.cells, cell);
    for (const r of table.rows) {
      if (r === row) break;
      if (r.cells.length === row.cells.length && r.cells[index] && norm(r.cells[index].innerText)) {
        return norm(r.cells[index].innerText);
      }
    }
    return null;
  }

  // For grid tables: texts in the same row that could identify it, longest first
  // (e.g. ["REGULAR SAVINGS", "S00"]). Only texts containing letters: amounts change, names of rows don't.
  function rowKeysOf(cell) {
    const keys = [];
    for (const c of cell.parentElement.cells) {
      if (c === cell || hasControlsOrTables(c)) continue;
      const t = norm(c.innerText);
      if (/[A-Za-z]/.test(t) && !keys.includes(t)) keys.push(t);
    }
    return keys.sort((a, b) => b.length - a.length);
  }

  function cssPath(el) {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && e !== document.documentElement) {
      const parent = e.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, e) + 1 : 1;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${index})`);
      e = parent;
    }
    return `html > ${parts.join(" > ")}`;
  }

  function attr(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function cssCandidates(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const name = el.getAttribute("name");
    if (name) out.push(`${tag}[name="${attr(name)}"]`);
    if (tag === "a" && el.getAttribute("href")) out.push(`a[href="${attr(el.getAttribute("href"))}"]`);
    if (out.length === 0) out.push(cssPath(el));
    return out;
  }

  // ---------- finding elements from a saved locator ----------

  function candidates() {
    return Array.from(document.querySelectorAll("a, button, input, select, textarea, td, th, [role]"));
  }

  function findTableCells(rowText, column) {
    const out = [];
    for (const table of document.querySelectorAll("table")) {
      let header = null;
      let colIndex = -1;
      for (const r of table.rows) {
        if (!header) {
          const i = Array.prototype.findIndex.call(r.cells, (c) => norm(c.innerText) === column);
          if (i !== -1) {
            header = r;
            colIndex = i;
          }
          continue;
        }
        if (r.cells.length !== header.cells.length) continue;
        const hasRowText = Array.prototype.some.call(r.cells, (c) => norm(c.innerText) === rowText);
        if (hasRowText && r.cells[colIndex]) out.push(r.cells[colIndex]);
      }
    }
    return out;
  }

  function matches(locator) {
    switch (locator.by) {
      case "role":
        return candidates().filter((el) => roleOf(el) === locator.role && nameOf(el) === norm(locator.name));
      case "rowLabel":
        return candidates().filter((el) => roleOf(el) === locator.role && rowLabelOf(el) === norm(locator.label));
      case "tableCell":
        return findTableCells(norm(locator.row), norm(locator.column));
      case "css":
        try {
          return Array.from(document.querySelectorAll(locator.selector));
        } catch {
          return [];
        }
      default:
        return [];
    }
  }

  /** CSS paths of the visible elements this locator matches. */
  function resolve(locator) {
    return matches(locator).filter(isVisible).map(cssPath);
  }

  function infoAt(path) {
    const el = document.querySelector(path);
    if (!el) return null;
    return { role: roleOf(el), name: nameOf(el), href: el.tagName.toLowerCase() === "a" ? el.href : null };
  }

  // ---------- page snapshot for the AI ----------

  let refs = new Map();

  function snapshot(prefix) {
    refs = new Map();
    let counter = 0;
    const lines = [];
    let buffer = "";
    const flush = () => {
      const t = norm(buffer);
      if (t) lines.push(t);
      buffer = "";
    };
    const newRef = (el) => {
      const ref = `${prefix}${++counter}`;
      refs.set(ref, el);
      return ref;
    };

    function controlToken(el) {
      const role = roleOf(el);
      let token = `[${newRef(el)}] ${role}`;
      const name = nameOf(el);
      const label = rowLabelOf(el);
      if (name && role !== "textbox" && role !== "combobox") token += ` "${name}"`;
      if (label && label !== name) token += ` (row label "${label}")`;
      else if (name && (role === "textbox" || role === "combobox")) token += ` "${name}"`;
      if (role === "textbox") token += el.type === "password" ? " (password)" : ` value="${el.value}"`;
      if (el.tagName.toLowerCase() === "select") {
        const selected = el.selectedOptions[0] ? norm(el.selectedOptions[0].text) : "";
        const options = Array.from(el.options).map((o) => `"${norm(o.text)}"`);
        token += ` selected="${selected}" options=[${options.join(", ")}]`;
      }
      if (el.disabled) token += " (disabled)";
      return ` ${token} `;
    }

    function walk(node) {
      if (node.nodeType === 3) {
        buffer += node.textContent;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "option", "head", "title"].includes(tag)) return;
      if (tag !== "tr" && tag !== "tbody" && tag !== "table" && !isVisible(el) && !el.querySelector("*")) {
        if (!norm(el.textContent)) return;
      }
      const role = roleOf(el);
      if (CONTROL_ROLES.has(role)) {
        if (isVisible(el)) buffer += controlToken(el);
        return;
      }
      if (tag === "tr" && !el.querySelector("table")) {
        flush();
        const cells = [];
        for (const cell of el.cells) {
          if (!hasControlsOrTables(cell)) {
            const t = norm(cell.innerText);
            if (t) cells.push(`[${newRef(cell)}] ${t}`);
            continue;
          }
          const saved = buffer;
          buffer = "";
          for (const child of cell.childNodes) walk(child);
          const t = norm(buffer);
          buffer = saved;
          if (t) cells.push(t);
        }
        if (cells.length) lines.push(`| ${cells.join(" | ")} |`);
        return;
      }
      const block = ["p", "div", "br", "center", "form", "table", "tbody", "tr", "h1", "h2", "h3", "h4", "li", "ul", "hr", "body"].includes(tag);
      if (block) flush();
      for (const child of el.childNodes) walk(child);
      if (block) flush();
    }

    if (document.body) walk(document.body);
    flush();
    return { lines: lines.slice(0, 400), truncated: lines.length > 400 };
  }

  /** Everything the recorder needs to build locators for an element the AI chose. */
  function describe(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return null;
    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();
    const inGrid = role === "cell" && el.parentElement && el.parentElement.cells.length >= 3;
    return {
      role,
      tag,
      name: nameOf(el),
      rowLabel: rowLabelOf(el),
      tableCell: inGrid ? { row: rowKeysOf(el)[0] || null, column: columnHeaderOf(el) } : null,
      rowKeys: inGrid ? rowKeysOf(el) : [],
      css: cssCandidates(el),
      href: tag === "a" ? el.href : null,
      isPassword: tag === "input" && el.type === "password",
      options: tag === "select" ? Array.from(el.options).map((o) => norm(o.text)) : null,
      text: role === "cell" ? norm(el.innerText) : null,
      path: cssPath(el),
    };
  }

  // ---------- sensitive data ----------

  // Cells next to a sensitive label ("SSN | 900-55-1234") and grid columns under a sensitive header.
  function sensitiveCells(labels) {
    const wanted = new Set(labels.map((l) => norm(l).toLowerCase()));
    const out = new Set();
    for (const table of document.querySelectorAll("table")) {
      const rows = Array.from(table.rows);
      rows.forEach((row, ri) => {
        const cells = Array.from(row.cells);
        cells.forEach((cell, ci) => {
          if (!wanted.has(norm(cell.innerText).toLowerCase())) return;
          if (cells.length === 2 && ci === 0) out.add(cells[1]);
          if (cells.length >= 3) {
            for (const below of rows.slice(ri + 1)) {
              if (below.cells.length === cells.length && below.cells[ci]) out.add(below.cells[ci]);
            }
          }
        });
      });
    }
    return Array.from(out);
  }

  function sensitivePaths(labels) {
    const paths = sensitiveCells(labels).map(cssPath);
    document.querySelectorAll("input[type=password]").forEach((el) => paths.push(cssPath(el)));
    return paths;
  }

  function sensitiveValues(labels) {
    return sensitiveCells(labels)
      .map((c) => norm(c.innerText))
      .filter(Boolean);
  }

  function bodyText() {
    return document.body ? document.body.innerText : "";
  }

  // Used by human-capture.js to describe what a human clicked, in the same terms as locators.
  function describeElement(el) {
    return { role: roleOf(el), name: nameOf(el), rowLabel: rowLabelOf(el) };
  }

  window.__cua = { snapshot, describe, resolve, infoAt, sensitivePaths, sensitiveValues, bodyText, describeElement };
})();
