import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("rejects requests for other host names", async () => {
    const { editor: e } = await start();
    const http = await import("node:http");
    const status = await new Promise<number>((ok) => http.get(e.url, { headers: { host: "evil.example:80" } }, (res) => ok(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });
});
