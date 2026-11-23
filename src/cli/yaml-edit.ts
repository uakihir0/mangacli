// Small, local edits of YAML source text for the browser editor (spec 12.3.12).
// Each edit rewrites only the characters of the value it changes, so comments, blank lines, quoting
// and the layout of everything else stay as the author wrote them.

import { type Node, type Pair, type YAMLMap, type YAMLSeq, isMap, isScalar, isSeq, parse, parseDocument, visit } from "yaml";

type Obj = Record<string, unknown>;
type Key = string | number;

/** a JS value written as one line of flow YAML */
export function flow(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(flow).join(", ")}]`;
  if (v && typeof v === "object") {
    const e = Object.entries(v as Obj);
    return e.length ? `{ ${e.map(([k, x]) => `${plain(k, true)}: ${flow(x)}`).join(", ")} }` : "{}";
  }
  if (typeof v === "string") return plain(v, true);
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  return String(v ?? "null");
}

/** a string as a plain scalar when that reads back as the same string, else double-quoted */
export function plain(s: string, inFlow: boolean): string {
  if (s && !/^\s|\s$/.test(s) && !s.includes("\n") && !/: |\s#|:$/.test(s) && !/^(?:[?:-](?:\s|$)|[,[\]{}#&*!|>'"%@`])/.test(s) && !(inFlow && /[,[\]{}]/.test(s))) {
    try {
      if (parse(s) === s) return s;
    } catch {
      // quoted below
    }
  }
  return JSON.stringify(s);
}

const lineStartOf = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
const lineEndOf = (text: string, pos: number) => {
  const i = text.indexOf("\n", pos);
  return i < 0 ? text.length : i;
};
const columnOf = (text: string, pos: number) => pos - lineStartOf(text, pos);

/** 1-based line and column -> offset */
export function offsetOf(text: string, line: number, column: number): number {
  let off = 0;
  for (let i = 1; i < line; i++) {
    const n = text.indexOf("\n", off);
    if (n < 0) return text.length;
    off = n + 1;
  }
  return off + column - 1;
}

export class YamlEditError extends Error {}

/** YAML text with edits addressed by a node's start offset and a key path below it */
export class YamlText {
  constructor(public text: string) {}

  private doc() {
    const d = parseDocument(this.text, { version: "1.2", merge: true, uniqueKeys: false });
    if (d.errors.length) throw new YamlEditError(d.errors[0].message.split("\n")[0]);
    return d;
  }

  /** the collection (or else scalar) that starts at `offset` */
  nodeAt(offset: number): Node | undefined {
    let found: Node | undefined;
    visit(this.doc(), (_key, n) => {
      const node = n as Node;
      if (!node || isPairLike(node) || node.range?.[0] !== offset) return;
      if (!found || (!isMap(found) && !isSeq(found) && (isMap(node) || isSeq(node)))) found = node;
    });
    return found;
  }

  find(offset: number, keys: Key[] = []): Node | undefined {
    let cur: Node | undefined = this.nodeAt(offset);
    for (const k of keys) {
      if (!cur) return undefined;
      cur = child(cur, k);
    }
    return cur;
  }

  /** value of the node as JS */
  value(offset: number, keys: Key[] = []): unknown {
    const n = this.find(offset, keys);
    return n ? (n as { toJSON(): unknown }).toJSON() : undefined;
  }

  /** the pairs of a mapping: key, the value as JS, and its source text */
  pairs(offset: number, keys: Key[] = []): { key: string; value: unknown; source: string }[] {
    const n = this.find(offset, keys);
    if (!n) return [];
    if (isScalar(n)) return [];
    if (!isMap(n)) return [];
    return n.items.map((p) => ({
      key: String(isScalar(p.key) ? p.key.value : p.key),
      value: p.value ? (p.value as { toJSON(): unknown }).toJSON() : null,
      source: p.value && (p.value as Node).range ? this.text.slice((p.value as Node).range![0], trimEnd(this.text, (p.value as Node).range![1])) : "",
    }));
  }

  /** sets `keys` below the node at `offset`; missing maps on the way are created, scalars on the way are wrapped as `{ [wrap[key]]: scalar }` */
  set(offset: number, keys: Key[], value: unknown, o: { raw?: string; wrap?: Record<string, string> | ((k: Key) => string | undefined); rootWrap?: string } = {}): void {
    let cur = this.nodeAt(offset);
    if (!cur) throw new YamlEditError("node not found");
    if (isScalar(cur) || isSeq(cur)) {
      if (!o.rootWrap) throw new YamlEditError("not a mapping");
      this.wrapScalar(cur, o.rootWrap);
      cur = this.nodeAt(offset)!;
    }
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      const next = child(cur!, k);
      if (!next || (isScalar(next) && next.value === null)) {
        // create the rest as one nested value
        let v: unknown = value;
        for (let j = keys.length - 1; j > i; j--) v = typeof keys[j] === "number" ? [v] : { [keys[j]]: v };
        return this.setValue(cur!, k, v);
      }
      if ((isScalar(next) || isSeq(next)) && typeof keys[i + 1] === "string") {
        const wrapKey = typeof o.wrap === "function" ? o.wrap(k) : o.wrap?.[String(k)];
        if (!wrapKey) throw new YamlEditError(`${k} is not a mapping`);
        this.wrapScalar(next, wrapKey);
        cur = this.find(offset, keys.slice(0, i + 1))!;
        continue;
      }
      cur = next;
    }
    this.setValue(cur!, keys[keys.length - 1], value, o.raw);
  }

  delete(offset: number, keys: Key[]): void {
    const parent = this.find(offset, keys.slice(0, -1));
    const k = keys[keys.length - 1];
    if (!parent) return;
    if (isMap(parent)) {
      const i = parent.items.findIndex((p) => keyOf(p) === k);
      if (i >= 0) this.removeItem(parent, i);
    } else if (isSeq(parent) && typeof k === "number" && k < parent.items.length) this.removeItem(parent, k);
  }

  /** inserts `value` into the sequence at `keys` before `index` (at the end when it is past the end); creates the sequence if missing */
  insert(offset: number, keys: Key[], index: number, value: unknown): void {
    const seq = this.find(offset, keys);
    if (!seq || (isScalar(seq) && seq.value === null)) return this.set(offset, keys, [value]);
    if (!isSeq(seq)) throw new YamlEditError("not a sequence");
    const items = seq.items as Node[];
    const flowSeq = this.text[seq.range![0]] === "[";
    if (flowSeq) {
      if (!items.length) return this.splice(seq.range![0], seq.range![1], `[${flow(value)}]`);
      if (index < items.length) return this.splice(items[index].range![0], items[index].range![0], `${flow(value)}, `);
      const last = items[items.length - 1];
      const e = trimEnd(this.text, last.range![1]);
      return this.splice(e, e, `, ${flow(value)}`);
    }
    const ref = items[Math.min(index, items.length - 1)];
    const dash = this.text.lastIndexOf("-", ref.range![0]);
    const indent = " ".repeat(columnOf(this.text, dash));
    const item = `- ${this.block(value, columnOf(this.text, dash) + 2)}`;
    if (index < items.length) {
      this.splice(dash, dash, `${item}\n${indent}`);
    } else {
      const e = lineEndOf(this.text, trimEnd(this.text, ref.range![1]) - 1);
      this.splice(e, e, `\n${indent}${item}`);
    }
  }

  /** replaces the node at `keys` with `value` written fresh (block style when the node was a block collection) */
  replace(offset: number, keys: Key[], value: unknown): void {
    if (!keys.length) {
      const n = this.nodeAt(offset);
      if (!n?.range) throw new YamlEditError("node not found");
      return this.replaceNode(n, value);
    }
    const parent = this.find(offset, keys.slice(0, -1));
    if (!parent) throw new YamlEditError("node not found");
    this.setValue(parent, keys[keys.length - 1], value);
  }

  // ---- internals ----------------------------------------------------------------

  private splice(from: number, to: number, insert: string) {
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
  }

  private inFlow(n: Node): boolean {
    return this.text[n.range![0]] === "{" || this.text[n.range![0]] === "[" || this.isInsideFlow(n.range![0]);
  }

  /** whether `pos` is inside a flow collection (counting brackets on the way from the line start is enough for our edits) */
  private isInsideFlow(pos: number): boolean {
    let depth = 0;
    const doc = this.doc();
    visit(doc, (_k, n) => {
      const node = n as Node;
      if (!node || isPairLike(node) || !node.range || !(isMap(node) || isSeq(node))) return;
      const open = this.text[node.range[0]];
      if ((open === "{" || open === "[") && node.range[0] < pos && pos < node.range[1]) depth++;
    });
    return depth > 0;
  }

  private wrapScalar(n: Node, key: string) {
    const src = this.text.slice(n.range![0], trimEnd(this.text, n.range![1]));
    if (src.includes("\n")) {
      // a block scalar: rewrite it as a quoted string
      return this.splice(n.range![0], trimEnd(this.text, n.range![1]), `{ ${key}: ${flow((n as { toJSON(): unknown }).toJSON())} }`);
    }
    this.splice(n.range![0], trimEnd(this.text, n.range![1]), `{ ${key}: ${src} }`);
  }

  private replaceNode(n: Node, value: unknown) {
    const start = n.range![0];
    const end = trimEnd(this.text, n.range![1]);
    const blockCollection = (isMap(n) || isSeq(n)) && !this.inFlow(n);
    if (blockCollection && value && typeof value === "object") {
      const col = columnOf(this.text, start);
      return this.splice(start, end, this.block(value, col).replace(/^\s+/, ""));
    }
    this.splice(start, end, this.inFlow(n) ? flow(value) : this.inline(value, columnOf(this.text, start)));
  }

  /** a value on the line after `key: ` in block context */
  private inline(value: unknown, keyColumn: number, raw?: string): string {
    if (raw !== undefined && !raw.includes("\n")) return raw.trim();
    if (typeof value === "string" && value.includes("\n") && !/^\s/.test(value)) {
      const pad = " ".repeat(keyColumn + 2);
      return "|\n" + value.replace(/\n+$/, "").split("\n").map((l) => (l ? pad + l : "")).join("\n");
    }
    if (typeof value === "string") return plain(value, false);
    return flow(value);
  }

  /** a value as block YAML whose first line continues the current line and later lines are indented by `column` */
  private block(value: unknown, column: number): string {
    if (!value || typeof value !== "object" || Array.isArray(value) && value.every((x) => typeof x !== "object" || x === null)) return this.inline(value, column - 2);
    const pad = " ".repeat(column);
    // short mappings in a list stay on one line each, as authors usually write rows and children
    if (Array.isArray(value)) return value.map((x, i) => `${i ? pad : ""}- ${x && typeof x === "object" && flow(x).length <= 64 ? flow(x) : this.block(x, column + 2)}`).join("\n");
    const entries = Object.entries(value as Obj);
    if (!entries.length) return "{}";
    return entries
      .map(([k, x], i) => {
        const head = `${i ? pad : ""}${plain(k, false)}:`;
        if (x && typeof x === "object" && !(Array.isArray(x) && x.every((y) => typeof y !== "object" || y === null)) && Object.keys(x).length) {
          const nested = Array.isArray(x) ? `\n${pad}  ${this.block(x, column + 2)}` : `\n${pad}  ${this.block(x, column + 2)}`;
          return head + nested;
        }
        return `${head} ${this.inline(x, column)}`;
      })
      .join("\n");
  }

  private setValue(parent: Node, k: Key, value: unknown, raw?: string) {
    if (isSeq(parent)) {
      const item = (parent.items as Node[])[k as number];
      if (!item) throw new YamlEditError(`no item ${k}`);
      if ((isMap(item) || isSeq(item)) && !this.inFlow(item) && value && typeof value === "object") return this.replaceNode(item, value);
      return this.splice(item.range![0], trimEnd(this.text, item.range![1]), this.inFlow(item) ? flow(value) : this.block(value, columnOf(this.text, item.range![0])));
    }
    if (!isMap(parent)) throw new YamlEditError("not a mapping");
    const map = parent as YAMLMap;
    const pair = map.items.find((p) => keyOf(p) === k);
    const flowMap = this.text[map.range![0]] === "{";
    const inFlow = flowMap || this.isInsideFlow(map.range![0]);
    if (pair) {
      const v = pair.value as Node | null;
      const keyNode = pair.key as Node;
      const keyCol = columnOf(this.text, keyNode.range![0]);
      if (v?.range && !(isScalar(v) && v.value === null && v.range[0] === v.range[1])) {
        if ((isMap(v) || isSeq(v)) && !this.inFlow(v) && needsBlock(value)) {
          // a block mapping keeps its block form
          const colon = this.text.indexOf(":", keyNode.range![1]);
          const end = trimEnd(this.text, v.range[1]);
          return this.splice(colon + 1, end, `\n${" ".repeat(keyCol + 2)}${this.block(value, keyCol + 2)}`);
        }
        const end = trimEnd(this.text, v.range[1]);
        const start = v.range[0];
        // a block value on its own line(s) is rewritten from the colon
        if (!inFlow && this.text.slice(keyNode.range![1], start).includes("\n")) {
          const colon = this.text.indexOf(":", keyNode.range![1]);
          return this.splice(colon + 1, end, ` ${this.inline(value, keyCol, raw)}`);
        }
        return this.splice(start, end, inFlow ? (raw !== undefined && !raw.includes("\n") ? raw.trim() : flow(value)) : this.inline(value, keyCol, raw));
      }
      const colon = this.text.indexOf(":", keyNode.range![1]);
      return this.splice(colon + 1, colon + 1, ` ${inFlow ? flow(value) : this.inline(value, keyCol, raw)}`);
    }
    const text = (col: number) => (inFlow ? `${plain(String(k), true)}: ${raw !== undefined && !raw.includes("\n") ? raw.trim() : flow(value)}` : this.entry(String(k), value, col, raw));
    if (flowMap) {
      const close = trimEnd(this.text, map.range![1]) - 1;
      let e = close;
      while (e > map.range![0] + 1 && /\s/.test(this.text[e - 1])) e--;
      return this.splice(e, e, map.items.length ? `, ${text(0)}` : ` ${text(0)} `);
    }
    if (!map.items.length) throw new YamlEditError("empty block mapping");
    const first = map.items[0].key as Node;
    const col = columnOf(this.text, first.range![0]);
    const last = map.items[map.items.length - 1];
    const lastEnd = last.value && (last.value as Node).range ? trimEnd(this.text, (last.value as Node).range![1]) : (last.key as Node).range![1];
    const at = lineEndOf(this.text, Math.max(lastEnd - 1, 0));
    this.splice(at, at, `\n${" ".repeat(col)}${text(col)}`);
  }

  private entry(k: string, value: unknown, col: number, raw?: string): string {
    if (raw === undefined && needsBlock(value) && JSON.stringify(value).length > 60) {
      return `${plain(k, false)}:\n${" ".repeat(col + 2)}${this.block(value, col + 2)}`;
    }
    return `${plain(k, false)}: ${this.inline(value, col, raw)}`;
  }

  private removeItem(parent: YAMLMap | YAMLSeq, i: number) {
    const items = parent.items as (Pair | Node)[];
    const startOf = (it: Pair | Node) => (isPairLike(it as Node) ? ((it as Pair).key as Node).range![0] : (it as Node).range![0]);
    const endOf = (it: Pair | Node) => {
      const n = isPairLike(it as Node) ? (((it as Pair).value as Node | null) ?? ((it as Pair).key as Node)) : (it as Node);
      return trimEnd(this.text, n.range ? n.range[1] : ((it as Pair).key as Node).range![1]);
    };
    const flowCol = this.text[parent.range![0]] === "{" || this.text[parent.range![0]] === "[";
    const seq = isSeq(parent);
    if (items.length === 1) {
      if (flowCol) return this.splice(parent.range![0], trimEnd(this.text, parent.range![1]), seq ? "[]" : "{}");
      return this.replaceNode(parent as Node, seq ? [] : {});
    }
    if (flowCol) {
      if (i < items.length - 1) return this.splice(startOf(items[i]), startOf(items[i + 1]), "");
      return this.splice(endOf(items[i - 1]), endOf(items[i]), "");
    }
    // block: a sequence item starts at its dash
    const head = (it: Pair | Node) => (seq ? this.text.lastIndexOf("-", startOf(it)) : startOf(it));
    if (i < items.length - 1) return this.splice(head(items[i]), head(items[i + 1]), "");
    const prevEnd = lineEndOf(this.text, endOf(items[i - 1]) - 1);
    this.splice(prevEnd, lineEndOf(this.text, endOf(items[i]) - 1), "");
  }
}

/** maps, and lists holding maps, read better as block YAML */
function needsBlock(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => !!x && typeof x === "object" && !Array.isArray(x));
  return Object.keys(v).length > 0;
}

function isPairLike(n: Node): boolean {
  return !!n && typeof n === "object" && "key" in n && "value" in n && !("items" in n);
}

function keyOf(p: Pair): unknown {
  return isScalar(p.key) ? p.key.value : p.key;
}

function child(n: Node, k: Key): Node | undefined {
  if (isMap(n)) return (n.items.find((p) => keyOf(p) === k)?.value as Node | null) ?? undefined;
  if (isSeq(n) && typeof k === "number") return (n.items as Node[])[k];
  return undefined;
}

/** the end of a node's text, without trailing whitespace and line breaks */
function trimEnd(text: string, end: number): number {
  let e = end;
  while (e > 0 && /\s/.test(text[e - 1])) e--;
  // a trailing comment is not part of the value
  return e;
}
