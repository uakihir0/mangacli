// `mangacli edit`: a local web editor that renders the YAML being edited and saves it back (spec 12.3.12).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { basename, dirname, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Project, type RenderOptions, type RenderResult, type RenderedPage, load, render } from "../api.js";
import { type Diagnostic, MangaError, MangaValidationError } from "../core/diagnostics.js";
import { type RElement, resolveDocument } from "../model/resolve.js";
import type { PageLayoutInfo } from "../render/compose.js";
import { collectDeps } from "./deps.js";
import { type EditState, type Op, type PageState, type Target, applyOp } from "./editor-ops.js";
import { YamlEditError, YamlText, flow, offsetOf } from "./yaml-edit.js";
import { editorPage } from "./editor-page.js";

export interface EditorOptions {
  /** absolute path of the document being edited */
  entry: string;
  port: number;
  host: string;
  ja?: boolean;
  /** render options, read again for every render so that config edits apply */
  options: () => Promise<RenderOptions>;
  /** called after each render */
  onRender?: (r: { pages: number; errors: number; warnings: number; ms: number }) => void;
  /** called when the document is written */
  onSave?: () => void;
}

export interface EditorServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** where an element is written in the edited file (1-based) */
interface Source {
  line: number;
  column: number;
}

const MAX_BODY = 16 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export async function startEditor(o: EditorOptions): Promise<EditorServer> {
  const http = await import("node:http");
  const { watch } = await import("chokidar");
  const entry = o.entry;
  const token = randomBytes(18).toString("base64url");
  const read = () => (existsSync(entry) ? readFileSync(entry, "utf8") : "");
  let disk = read();
  let diskHash = hashOf(disk);

  // the two latest renders, so images of the one the browser is still loading stay available
  let rid = 0;
  const renders = new Map<number, RenderedPage[]>();
  let queue: Promise<unknown> = Promise.resolve();
  let wanted = 0;

  const clients = new Set<ServerResponse>();
  const send = (event: string, data: unknown) => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const watcher = watch(collectDeps(entry), { ignoreInitial: true });
  const watchDeps = () => {
    for (const f of collectDeps(entry)) watcher.add(f);
  };
  let timer: NodeJS.Timeout | undefined;
  let changedEntry = false;
  watcher.on("all", (_event, path) => {
    if (path === entry) changedEntry = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const own = changedEntry;
      changedEntry = false;
      if (own) {
        const text = read();
        const h = hashOf(text);
        if (h !== diskHash) {
          disk = text;
          diskHash = h;
          send("file", { yaml: text, hash: h });
        }
      } else send("deps", {});
      watchDeps();
    }, 150);
  });

  /** the last render: per-page images and geometry, and how drags map to the text it was made from */
  interface PageCache {
    images: RenderedPage[];
    info?: PageLayoutInfo;
    diagnostics: Diagnostic[];
  }
  let last: { text: string; order: string[]; pages: Map<string, PageCache>; docDiagnostics: Diagnostic[]; state: EditState; sources: Map<string, Source> } | undefined;

  const renderText = async (yaml: string, only?: string[]) => {
    const t0 = performance.now();
    const base = { ...(await o.options()), throwOnError: false, editInfo: true };
    base.onSystemFont = (path) => watcher.add(path);
    let partial = !!only?.length && !!last && only.every((id) => last!.pages.has(id));
    const opts: RenderOptions = { ...base };
    let rendered: RenderResult | undefined;
    let diagnostics: Diagnostic[] = [];
    const sources = new Map<string, Source>();
    const state: EditState = { text: yaml, elements: new Map(), pages: new Map() };
    let order: string[] | undefined;
    try {
      const project = load({ yaml, filename: entry, baseDir: dirname(entry) }, opts);
      if (!project.bag.hasErrors) {
        try {
          const resolved = resolveDocument(project.doc, project.bag.fork(), { lang: opts.lang });
          order = resolved.pages.map((p) => p.id);
          describe(resolved, project.loaded.locate, yaml, state, sources);
          // a page whose id changed is not where the last render had it: draw everything
          if (partial && !only!.every((id) => order!.includes(id))) partial = false;
        } catch {
          // element positions are a convenience; the render below reports the real problem
        }
      }
      if (partial) opts.pages = (p: { id: string }) => only!.includes(p.id);
      rendered = await render(project, opts);
      diagnostics = rendered.diagnostics;
    } catch (e) {
      if (e instanceof MangaValidationError) diagnostics = e.diagnostics;
      else diagnostics = [{ code: e instanceof MangaError ? e.code : "RENDER_FAILED", severity: "error", message: (e as Error).message }];
    }
    const id = ++rid;
    const ms = Math.round(performance.now() - t0);
    let pageMap: Map<string, PageCache> | undefined;
    if (rendered && (rendered.pages.length || !diagnostics.some((d) => d.severity === "error"))) {
      pageMap = partial ? new Map(last!.pages) : new Map();
      const fresh = new Map<string, PageCache>();
      for (const p of rendered.pages) {
        const c = fresh.get(p.id) ?? { images: [], diagnostics: [] };
        c.images.push(p);
        fresh.set(p.id, c);
      }
      for (const info of rendered.layout) {
        const c = fresh.get(info.geom.id) ?? { images: [], diagnostics: [] };
        c.info = info;
        fresh.set(info.geom.id, c);
      }
      for (const d of diagnostics) if (d.pageId && fresh.has(d.pageId)) fresh.get(d.pageId)!.diagnostics.push(d);
      for (const [pid, c] of fresh) pageMap.set(pid, c);
      const docDiagnostics = diagnostics.filter((d) => !d.pageId || !fresh.has(d.pageId));
      order ??= last?.order ?? [...pageMap.keys()];
      for (const pid of [...pageMap.keys()]) if (!order.includes(pid)) pageMap.delete(pid);
      // geometry of every page shown, for the drags of the next edit
      for (const [pid, c] of pageMap) {
        const ps = state.pages.get(pid);
        if (ps && c.info) {
          ps.layout = c.info.layoutEdit;
          ps.trim = c.info.geom.trim;
          ps.bleedBox = c.info.geom.bleedBox;
          ps.baseFrame = c.info.geom.baseFrame;
          for (const pn of ps.panels) {
            const g = c.info.panels.find((x) => x.id === pn.id);
            if (g) Object.assign(pn, { box: g.box, polygon: g.polygon });
          }
        }
        for (const e of c.info?.elements ?? []) {
          const st = state.elements.get(e.id);
          if (st && e.edit) st.edit = e.edit;
        }
      }
      last = { text: yaml, order, pages: pageMap, docDiagnostics, state, sources };
      if (partial) diagnostics = [...docDiagnostics, ...order.flatMap((pid) => pageMap!.get(pid)?.diagnostics ?? [])];
    }
    const images = pageMap ? (last!.order).flatMap((pid) => pageMap!.get(pid)?.images ?? []) : [];
    renders.set(id, images);
    renders.delete(id - 3);
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    const warnings = diagnostics.filter((d) => d.severity === "warning").length;
    o.onRender?.({ pages: images.length, errors, warnings, ms });
    const layouts: Record<string, unknown> = {};
    const items: Record<string, unknown> = {};
    if (pageMap) {
      for (const [pid, ps] of state.pages) {
        if (!pageMap.has(pid)) continue;
        layouts[pid] = {
          editable: ps.src !== undefined,
          mode: ps.layout?.mode ?? "single",
          rtl: ps.layout?.rtl ?? true,
          area: ps.layout?.area,
          dividers: ps.layout?.dividers.map((d) => ({ axis: d.axis, a: d.a, b: d.b, slant: d.slant, kind: d.kind })) ?? [],
          lines: ps.layout?.lines.map((l) => ({ a: l.a, b: l.b })) ?? [],
          line: sources.get(`page:${pid}`)?.line,
          panels: ps.panels.map((pn) => ({ id: pn.id, polygon: pn.polygon, shape: ps.layout?.polys[pn.id], overlay: pn.overlay, editable: pn.src !== undefined, line: sources.get(`panel:${pn.id}`)?.line, column: sources.get(`panel:${pn.id}`)?.column })),
        };
      }
      for (const [eid, st] of state.elements) {
        if (!pageMap.has(st.page)) continue;
        const ed = st.edit;
        items[eid] = {
          type: st.type,
          page: st.page,
          panel: st.panel,
          editable: st.src !== undefined,
          ...sources.get(eid),
          edit: ed && { at: ed.at, uv: ed.uv, box: ed.box, rotate: ed.rotate, pivot: ed.pivot, keepAspect: st.type === "image" || st.type === "text" || st.type === "sfx", tails: ed.tails?.map((t, index) => ({ ...t, index })).filter((t) => Number.isFinite(t.tip.x)), center: ed.center },
        };
      }
    }
    return {
      rid: id,
      ms,
      partial,
      pages: images.map((p, i) => ({
        id: p.id,
        side: p.side,
        separation: p.separation,
        width: p.width,
        height: p.height,
        transform: p.transform,
        src: `/api/page/${id}/${i}.${p.format}?token=${token}`,
        elements: p.elements.map((e) => ({ ...e, ...sources.get(e.id) })),
      })),
      layouts,
      items,
      diagnostics: diagnostics.map((d) => {
        const own = !d.location || d.location.file === entry;
        return {
          severity: d.severity,
          code: d.code,
          message: d.message,
          hint: d.hint,
          pageId: d.pageId,
          elementId: d.elementId,
          line: d.location?.line ?? (d.elementId ? sources.get(d.elementId)?.line : undefined),
          column: d.location?.column,
          file: own ? undefined : relative(dirname(entry), d.location!.file),
        };
      }),
    };
  };

  /** source offsets of pages, panels and elements written in the edited file */
  const describe = (resolved: ReturnType<typeof resolveDocument>, locate: Project["loaded"]["locate"], yaml: string, state: EditState, sources: Map<string, Source>) => {
    // pages after an include no longer line up with the entry file's list
    let firstInclude = Infinity;
    try {
      const raw = parseYaml(yaml) as { pages?: unknown[] } | null;
      raw?.pages?.forEach((p, i) => {
        if (p && typeof p === "object" && "include" in p && i < firstInclude) firstInclude = i;
      });
    } catch {
      // the loader reports it
    }
    // only list items are nodes of their own; a path ending in a key (the yonkoma title panel, its title) points at the key
    const here = (path: (string | number)[]) => {
      if (typeof path[path.length - 1] !== "number") return undefined;
      const loc = locate(path, true);
      return loc && loc.file === entry ? loc : undefined;
    };
    resolved.pages.forEach((pg, pi) => {
      const safe = pi < firstInclude;
      const ploc = safe ? here(pg.path) : undefined;
      if (ploc) sources.set(`page:${pg.id}`, { line: ploc.line, column: ploc.column });
      const ps: PageState = { id: pg.id, src: ploc && offsetOf(yaml, ploc.line, ploc.column), panels: [], trim: { x: 0, y: 0, w: 0, h: 0 } };
      state.pages.set(pg.id, ps);
      const visit = (e: RElement, owner: { path: (string | number)[]; src?: number }, panel?: string) => {
        const loc = safe ? here(e.path) : undefined;
        if (loc && !sources.has(e.id)) sources.set(e.id, { line: loc.line, column: loc.column });
        const rel = e.path.slice(owner.path.length);
        const sameTree = owner.path.every((k, i) => e.path[i] === k);
        state.elements.set(e.id, {
          id: e.id,
          type: e.type,
          page: pg.id,
          panel,
          src: loc && offsetOf(yaml, loc.line, loc.column),
          owner: owner.src !== undefined && loc && sameTree ? { src: owner.src, keys: rel } : undefined,
        });
        e.children?.forEach((c) => visit(c, owner, panel));
      };
      for (const pn of pg.panels) {
        const loc = safe ? here(pn.path) : undefined;
        if (loc) sources.set(`panel:${pn.id}`, { line: loc.line, column: loc.column });
        const src = loc && offsetOf(yaml, loc.line, loc.column);
        ps.panels.push({ id: pn.id, src, index: Number(pn.path[pn.path.length - 1]), overlay: pn.props.overlay === true, box: { x: 0, y: 0, w: 0, h: 0 }, polygon: [] });
        pn.elements.forEach((e) => visit(e, { path: pn.path, src }, pn.id));
      }
      pg.layers.forEach((e) => visit(e, { path: pg.path, src: ps.src }));
    });
  };

  /** applies an editing operation to the text the browser last rendered */
  const operate = (yaml: string, op: Op) => {
    if (!last || last.text !== yaml) return { status: 409, body: { error: "stale" } };
    try {
      const text = applyOp(last.state, op);
      const page = "page" in op && op.page ? op.page : "id" in op && op.id ? last.state.elements.get(op.id)?.page : "panel" in op && op.panel ? [...last.state.pages.values()].find((p) => p.panels.some((x) => x.id === op.panel))?.id : "target" in op ? (op.target.kind === "page" ? op.target.id : op.target.kind === "element" ? last.state.elements.get(op.target.id)?.page : [...last.state.pages.values()].find((p) => p.panels.some((x) => x.id === op.target.id))?.id) : undefined;
      return { status: 200, body: { yaml: text, pages: page ? [page] : undefined } };
    } catch (e) {
      if (e instanceof YamlEditError) return { status: 422, body: { error: e.message } };
      throw e;
    }
  };

  const inspect = (yaml: string, target: Target) => {
    if (!last || last.text !== yaml) return { status: 409, body: { error: "stale" } };
    const st = last.state;
    const src = target.kind === "element" ? st.elements.get(target.id)?.src : target.kind === "page" ? st.pages.get(target.id)?.src : [...st.pages.values()].flatMap((p) => p.panels).find((p) => p.id === target.id)?.src;
    if (src === undefined) return { status: 200, body: { editable: false, pairs: [] } };
    const y = new YamlText(yaml);
    const node = y.value(src);
    const pairs = node && typeof node === "object" && !Array.isArray(node) ? y.pairs(src) : [{ key: "text", value: node, source: String(node) }];
    return { status: 200, body: { editable: true, pairs: pairs.map((p) => ({ key: p.key, string: typeof p.value === "string" ? p.value.replace(/\n$/, "") : undefined, yaml: typeof p.value === "string" ? undefined : p.source.includes("\n") ? flow(p.value) : p.source })) } };
  };

  /** render requests run one at a time; a request overtaken by a newer one is skipped */
  const enqueue = (yaml: string, only?: string[]) => {
    const n = ++wanted;
    const job = queue.then((): Promise<Awaited<ReturnType<typeof renderText>> | { superseded: true }> => (n === wanted ? renderText(yaml, only) : Promise.resolve({ superseded: true })));
    queue = job.catch(() => undefined);
    return job;
  };

  const save = async (yaml: string) => {
    // keep the file's line endings; the browser edits with LF only
    const text = /\r\n/.test(disk) ? yaml.replace(/\r?\n/g, "\r\n") : yaml;
    await writeFile(entry, text);
    disk = text;
    diskHash = hashOf(text);
    o.onSave?.();
    watchDeps();
    return diskHash;
  };

  const body = (req: IncomingMessage) =>
    new Promise<string>((ok, fail) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          fail(Object.assign(new Error("request body too large"), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
      req.on("error", fail);
    });

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };

  const loopbackOnly = LOOPBACK.has(o.host);
  let port = o.port;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    // reject other host names so that a web page cannot reach the editor through DNS rebinding
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (loopbackOnly && !LOOPBACK.has(hostName)) return void res.writeHead(403).end();
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(editorPage({ title: basename(entry), token, ja: !!o.ja }));
      return;
    }
    // everything else needs the token from the page: a header for fetch, a query parameter for EventSource and images
    const given = req.headers["x-mangacli-token"] ?? url.searchParams.get("token");
    if (given !== token) return void res.writeHead(403).end();
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": ok\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, { file: relative(process.cwd(), entry) || basename(entry), yaml: disk, hash: diskHash });
    }
    if (url.pathname === "/api/render" && req.method === "POST") {
      const only = url.searchParams.get("pages");
      return json(res, 200, await enqueue(await body(req), only ? only.split(",") : undefined));
    }
    if (url.pathname === "/api/op" && req.method === "POST") {
      const b = JSON.parse(await body(req)) as { yaml: string; op: Op };
      // wait for renders in flight, so that the geometry matches the text
      await queue;
      const r = operate(b.yaml, b.op);
      return json(res, r.status, r.body);
    }
    if (url.pathname === "/api/inspect" && req.method === "POST") {
      const b = JSON.parse(await body(req)) as { yaml: string; target: Target };
      await queue;
      const r = inspect(b.yaml, b.target);
      return json(res, r.status, r.body);
    }
    if (url.pathname === "/api/file" && req.method === "PUT") {
      const b = JSON.parse(await body(req)) as { yaml?: unknown; base?: unknown; force?: unknown };
      if (typeof b.yaml !== "string") return json(res, 400, { error: "yaml must be a string" });
      // the file changed on disk since the browser loaded it
      if (!b.force && b.base !== diskHash) return json(res, 409, { hash: diskHash });
      return json(res, 200, { hash: await save(b.yaml) });
    }
    const m = url.pathname.match(/^\/api\/page\/(\d+)\/(\d+)\.\w+$/);
    const page = m ? renders.get(Number(m[1]))?.[Number(m[2])] : undefined;
    if (page && req.method === "GET") {
      res.writeHead(200, { "content-type": page.mimeType, "cache-control": "private, max-age=600" });
      res.end(page.data);
      return;
    }
    res.writeHead(404).end();
  };

  const server: Server = http.createServer((req, res) => {
    handle(req, res).catch((e: Error & { status?: number }) => {
      if (res.headersSent) return void res.end();
      json(res, e.status ?? (e instanceof SyntaxError ? 400 : 500), { error: e.message });
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, o.host, ok);
  });
  const address = server.address();
  if (typeof address === "object" && address) port = address.port;
  const shownHost = o.host.includes(":") && !o.host.startsWith("[") ? `[${o.host}]` : o.host;
  return {
    url: `http://${shownHost}:${port}/`,
    token,
    close: async () => {
      clearTimeout(timer);
      for (const c of clients) c.end();
      await watcher.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
