import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type EditorServer, startEditor } from "../src/cli/editor.js";

const YAML = "mangacli: 1\npage: { size: [40mm, 50mm], bleed: 0 }\npages:\n  - panels:\n      - layers:\n          - id: hello\n            balloon: やあ\n";

let editor: EditorServer | undefined;
afterEach(async () => {
  await editor?.close();
  editor = undefined;
});

const start = async (text = YAML) => {
  const dir = mkdtempSync(join(tmpdir(), "mc-edit-"));
  const file = join(dir, "manga.yaml");
  writeFileSync(file, text);
  editor = await startEditor({ entry: file, port: 0, host: "127.0.0.1", options: async () => ({ profile: "preview", dpi: 72 }) });
  const e = editor;
  const api = (path: string, init: RequestInit = {}) => fetch(new URL(path, e.url), { ...init, headers: { ...(init.headers as Record<string, string>), "x-mangacli-token": e.token } });
  return { file, api, editor: e };
};

describe("mangacli edit", () => {
  it("serves the page and requires the token for the API", async () => {
    const { editor: e } = await start();
    const page = await (await fetch(e.url)).text();
    expect(page).toContain(JSON.stringify(e.token));
    expect((await fetch(new URL("/api/state", e.url))).status).toBe(403);
    expect((await fetch(new URL("/api/state", e.url), { headers: { "x-mangacli-token": "wrong" } })).status).toBe(403);
  });

  it("renders the posted text with element lines and serves the images", async () => {
    const { api } = await start();
    const state = await (await api("/api/state")).json();
    expect(state.yaml).toBe(YAML);
    const r = await (await api("/api/render", { method: "POST", body: state.yaml })).json();
    expect(r.pages).toHaveLength(1);
    const el = r.pages[0].elements.find((x: { id: string }) => x.id === "hello");
    expect(el).toMatchObject({ line: 6 });
    const img = await api(r.pages[0].src);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toMatch(/^image\//);
  });

  it("reports diagnostics with lines for broken text without writing the file", async () => {
    const { api, file } = await start();
    const r = await (await api("/api/render", { method: "POST", body: YAML.replace("balloon: やあ", "balloon: やあ\n            nope: 1") })).json();
    expect(r.pages).toHaveLength(0);
    const d = r.diagnostics.find((x: { code: string }) => x.code === "SCHEMA_UNKNOWN_KEY");
    expect(d).toMatchObject({ severity: "error", line: 8 });
    expect(readFileSync(file, "utf8")).toBe(YAML);
  });

  it("saves, keeping CRLF line endings, and refuses to overwrite outside changes", async () => {
    const crlf = YAML.replace(/\n/g, "\r\n");
    const { api, file } = await start(crlf);
    const { hash } = await (await api("/api/state")).json();
    const edited = YAML.replace("やあ", "こんにちは");
    const put = (base: string, force = false) => api("/api/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml: edited, base, force }) });
    const ok = await put(hash);
    expect(ok.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(edited.replace(/\n/g, "\r\n"));
    const next = (await ok.json()).hash;
    expect((await put(hash)).status).toBe(409);
    expect((await put(next)).status).toBe(200);
    expect((await put("stale", true)).status).toBe(200);
  });

  it("turns a drag on the page into a YAML edit and re-renders only that page", async () => {
    const text = "mangacli: 1\npage: { size: [100mm, 140mm], bleed: 0 }\npages:\n  - id: p1\n    layout:\n      rows: [[1], [1, 1]]   # keep me\n    panels:\n      - layers:\n          - id: b1\n            balloon: やあ\n            place: top-right\n      - layers: []\n      - layers: []\n  - id: p2\n";
    const { api } = await start(text);
    const op = async (yaml: string, o: unknown) => {
      const r = await api("/api/op", { method: "POST", body: JSON.stringify({ yaml, op: o }) });
      return { status: r.status, body: await r.json() };
    };
    const r = await (await api("/api/render", { method: "POST", body: text })).json();
    const b1 = r.items.b1;
    expect(b1).toMatchObject({ type: "balloon", page: "p1", editable: true, line: 9 });
    expect(r.layouts.p1.mode).toBe("rows");
    expect(r.layouts.p1.dividers.map((d: { axis: string }) => d.axis)).toEqual(["y", "x"]);

    // move: `at` replaces `place` and keeps its anchor
    const moved = await op(text, { op: "move", id: "b1", dx: -10, dy: 5 });
    expect(moved.status).toBe(200);
    expect(moved.body.pages).toEqual(["p1"]);
    const props = parse(moved.body.yaml).pages[0].panels[0].layers[0];
    expect(props.place).toBeUndefined();
    expect(props.anchor).toBe("top-right");
    expect(props.at[0]).toMatch(/%$/);
    expect(moved.body.yaml).toContain("# keep me");

    // the geometry belongs to the rendered text: an op on other text is refused
    expect((await op(moved.body.yaml, { op: "move", id: "b1", dx: 1, dy: 0 })).status).toBe(409);
    const partial = await (await api("/api/render?pages=p1", { method: "POST", body: moved.body.yaml })).json();
    expect(partial.partial).toBe(true);
    expect(partial.pages.map((p: { id: string }) => p.id)).toEqual(["p1", "p2"]);

    // a divider drag changes the row heights; splitting adds a panel
    const div = await op(moved.body.yaml, { op: "divider", page: "p1", index: 0, delta: 10 });
    const rows = parse(div.body.yaml).pages[0].layout.rows;
    expect(rows[0].height).toBeGreaterThan(1);
    expect(rows[0].height + rows[1].height).toBeCloseTo(2, 1);
    await api("/api/render?pages=p1", { method: "POST", body: div.body.yaml });
    const sp = await op(div.body.yaml, { op: "splitPanel", panel: "p1-k2", dir: "v" });
    const page = parse(sp.body.yaml).pages[0];
    expect(page.panels).toHaveLength(4);
    expect(page.layout.rows[1].cols).toHaveLength(3);

    // an edit the layout cannot take is reported, not written
    await api("/api/render", { method: "POST", body: sp.body.yaml });
    const bad = await op(sp.body.yaml, { op: "addPanel", page: "p1" });
    expect(bad.status).toBe(422);
  });

  it("lists and sets the keys of an element", async () => {
    const { api } = await start();
    const r = await api("/api/render", { method: "POST", body: YAML });
    await r.json();
    const ins = await (await api("/api/inspect", { method: "POST", body: JSON.stringify({ yaml: YAML, target: { kind: "element", id: "hello" } }) })).json();
    expect(ins.pairs).toEqual([
      { key: "id", string: "hello" },
      { key: "balloon", string: "やあ" },
    ]);
    const set = await (await api("/api/op", { method: "POST", body: JSON.stringify({ yaml: YAML, op: { op: "set", target: { kind: "element", id: "hello" }, key: ["size"], yaml: "[20mm, auto]" } }) })).json();
    expect(set.yaml).toContain("            size: [20mm, auto]\n");
  });

  it("rejects requests for other host names", async () => {
    const { editor: e } = await start();
    const http = await import("node:http");
    const status = await new Promise<number>((ok) => http.get(e.url, { headers: { host: "evil.example:80" } }, (res) => ok(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });
});
