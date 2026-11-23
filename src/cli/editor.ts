// `mangacli edit`: a local web editor that renders the YAML being edited and saves it back (spec 12.3.12).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { basename, dirname, relative } from "node:path";
import { type RenderOptions, type RenderedPage, load, render } from "../api.js";
import { type Diagnostic, MangaError, MangaValidationError } from "../core/diagnostics.js";
import { type RElement, resolveDocument } from "../model/resolve.js";
import { collectDeps } from "./deps.js";
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

  const renderText = async (yaml: string) => {
    const t0 = performance.now();
    const opts = { ...(await o.options()), throwOnError: false };
    opts.onSystemFont = (path) => watcher.add(path);
    let pages: RenderedPage[] = [];
    let diagnostics: Diagnostic[] = [];
    const sources = new Map<string, Source>();
    try {
      const project = load({ yaml, filename: entry, baseDir: dirname(entry) }, opts);
      if (!project.bag.hasErrors) {
        try {
          const resolved = resolveDocument(project.doc, project.bag.fork(), { lang: opts.lang });
          const visit = (e: RElement) => {
            const loc = project.loaded.locate(e.path);
            if (loc && loc.file === entry && !sources.has(e.id)) sources.set(e.id, { line: loc.line, column: loc.column });
            e.children?.forEach(visit);
          };
          for (const pg of resolved.pages) {
            for (const pn of pg.panels) pn.elements.forEach(visit);
            pg.layers.forEach(visit);
          }
        } catch {
          // element positions are a convenience; the render below reports the real problem
        }
      }
      const r = await render(project, opts);
      pages = r.pages;
      diagnostics = r.diagnostics;
    } catch (e) {
      if (e instanceof MangaValidationError) diagnostics = e.diagnostics;
      else diagnostics = [{ code: e instanceof MangaError ? e.code : "RENDER_FAILED", severity: "error", message: (e as Error).message }];
    }
    const id = ++rid;
    renders.set(id, pages);
    renders.delete(id - 2);
    const ms = Math.round(performance.now() - t0);
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    const warnings = diagnostics.filter((d) => d.severity === "warning").length;
    o.onRender?.({ pages: pages.length, errors, warnings, ms });
    return {
      rid: id,
      ms,
      pages: pages.map((p, i) => ({
        id: p.id,
        side: p.side,
        separation: p.separation,
        width: p.width,
        height: p.height,
        src: `/api/page/${id}/${i}.${p.format}?token=${token}`,
        elements: p.elements.map((e) => ({ ...e, ...sources.get(e.id) })),
      })),
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

  /** render requests run one at a time; a request overtaken by a newer one is skipped */
  const enqueue = (yaml: string) => {
    const n = ++wanted;
    const job = queue.then((): Promise<Awaited<ReturnType<typeof renderText>> | { superseded: true }> => (n === wanted ? renderText(yaml) : Promise.resolve({ superseded: true })));
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
      return json(res, 200, await enqueue(await body(req)));
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
