import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRenderer, validate } from "../src/api.js";

const renderer = createRenderer({ profile: "preview" });
const doc = (type: "spread" | "page", extra = "") => ({ yaml: `mangacli: 1
page: { size: [80mm, 60mm], bleed: 3mm, background: white${extra} }
pages:
  - type: ${type}
    panels: []
`, filename: "/v/guides.yaml" });

// 254 dpi = 10 px per mm, trim crop
const pixels = async (data: Uint8Array) => {
  const { data: px, info } = await sharp(data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, at: (xmm: number, ymm: number) => { const i = (Math.round(ymm * 10) * info.width + Math.round(xmm * 10)) * info.channels; return [px[i], px[i + 1], px[i + 2]]; } };
};
const isWhite = ([r, g, b]: number[]) => r > 245 && g > 245 && b > 245;
const isRed = ([r, g, b]: number[]) => r > 200 && g < 230 && b < 230 && r - g > 20;
const isBlue = ([r, g, b]: number[]) => b > 200 && r < 120;
const isMagenta = ([r, g, b]: number[]) => r > 180 && b > 180 && g < 90;
const isOrange = ([r, g, b]: number[]) => r > 230 && g > 100 && g < 190 && b < 90;
// dashed / dotted lines: some sample along a 10mm vertical run at x must match
const along = (p: { at: (x: number, y: number) => number[] }, x: number, test: (c: number[]) => boolean) => Array.from({ length: 100 }, (_, i) => 25 + i / 10).some((y) => test(p.at(x, y)));
// the safe line is dashed: some sample along a 10mm run must hit it
const hasSafeLine = (p: { at: (x: number, y: number) => number[] }, x: number) => Array.from({ length: 100 }, (_, i) => 25 + i / 10).some((y) => isBlue(p.at(x, y)));

describe("preview guides overlay", () => {
  it("exposes the fold band width on spreads only", async () => {
    expect((await validate(doc("spread"))).layout[0]!.geom.foldMargin).toBe(10);
    expect((await validate(doc("spread", ", foldMargin: 15mm"))).layout[0]!.geom.foldMargin).toBe(15);
    expect((await validate(doc("page"))).layout[0]!.geom.foldMargin).toBe(0);
  });

  it("draws the fold band and safe line on a joined spread", async () => {
    const opts = { format: "png", crop: "trim", dpi: 254, spread: "joined" } as const;
    const plain = await pixels((await renderer.render(doc("spread"), opts)).pages[0]!.data);
    const guided = await pixels((await renderer.render(doc("spread"), { ...opts, debug: ["guides"] })).pages[0]!.data);
    expect(plain.width).toBe(1600);
    // inside the band (fold at 80mm, ±10mm), away from the band edges and center line
    for (const x of [72, 75, 85, 88]) {
      expect(isWhite(plain.at(x, 30))).toBe(true);
      expect(isRed(guided.at(x, 30))).toBe(true);
    }
    // outside the band stays untouched
    for (const x of [20, 65, 95, 140]) expect(isWhite(guided.at(x, 30))).toBe(true);
    // safe line at 5mm from the trim
    expect(hasSafeLine(guided, 5)).toBe(true);
    expect(hasSafeLine(plain, 5)).toBe(false);
  });

  it("puts the band on the inner edge of each split page", async () => {
    const r = await renderer.render(doc("spread"), { format: "png", crop: "trim", dpi: 254, spread: "split", debug: ["guides"] });
    expect(r.pages).toHaveLength(2);
    for (const p of r.pages) {
      const px = await pixels(p.data);
      const inner = p.side === "left" ? 75 : 5;
      const outer = p.side === "left" ? 20 : 60;
      expect(isRed(px.at(inner, 30))).toBe(true);
      expect(isWhite(px.at(outer, 30))).toBe(true);
    }
  });

  it("marks the inner trim and bleed edge of each split page", async () => {
    const r = await renderer.render(doc("spread"), { format: "png", crop: "bleed", dpi: 254, spread: "split", debug: ["guides"] });
    for (const p of r.pages) {
      const px = await pixels(p.data);
      expect(px.width).toBe(860);
      const [trim, edge] = p.side === "left" ? [83, 85.9] : [3, 0.1];
      expect(isMagenta(px.at(trim, 30))).toBe(true);
      expect(along(px, edge, isOrange)).toBe(true);
      // no bleed line from the other page inside the trim
      expect(along(px, p.side === "left" ? 80.1 : 5.9, isOrange)).toBe(false);
    }
  });

  it("draws only the safe line on a single page", async () => {
    const px = await pixels((await renderer.render(doc("page"), { format: "png", crop: "trim", dpi: 254, debug: ["guides"] })).pages[0]!.data);
    expect(hasSafeLine(px, 5)).toBe(true);
    expect(hasSafeLine(px, 75)).toBe(true);
    expect(isWhite(px.at(40, 30))).toBe(true);
  });

  it("draws the trim line solid and the bleed edge dotted when the bleed is shown", async () => {
    const opts = { format: "png", crop: "bleed", dpi: 254, spread: "joined" } as const;
    const plain = await pixels((await renderer.render(doc("spread"), opts)).pages[0]!.data);
    const px = await pixels((await renderer.render(doc("spread"), { ...opts, debug: ["guides"] })).pages[0]!.data);
    expect(px.width).toBe(1660);
    // trim 3mm in from the image edge on both sides, solid
    for (const x of [3, 163]) {
      expect(isWhite(plain.at(x, 30))).toBe(true);
      expect(isMagenta(px.at(x, 30))).toBe(true);
    }
    // bleed edge drawn just inside the image border, dotted
    expect(along(px, 0.1, isOrange)).toBe(true);
    expect(along(px, 165.9, isOrange)).toBe(true);
    expect(along(px, 0.1, isMagenta)).toBe(false);
    // safe line stays 5mm inside the trim
    expect(along(px, 8, isBlue)).toBe(true);
  });

  it("marks the image edge as the trim when cropped to the trim", async () => {
    const px = await pixels((await renderer.render(doc("page"), { format: "png", crop: "trim", dpi: 254, debug: ["guides"] })).pages[0]!.data);
    expect(isMagenta(px.at(0.1, 30))).toBe(true);
    expect(along(px, 0.1, isOrange)).toBe(false);
  });

  it("serves a guides toggle and guided pages from the preview server", async () => {
    const root = join(import.meta.dirname, "..");
    const dir = mkdtempSync(join(tmpdir(), "mc-"));
    const f = join(dir, "guides.yaml");
    writeFileSync(f, doc("spread").yaml);
    const port = 41000 + Math.floor(Math.random() * 2000);
    const proc = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli/index.ts"), "preview", f, "--port", String(port), "--no-config"], { cwd: root });
    try {
      await new Promise<void>((ok, ng) => {
        const timer = setTimeout(() => ng(new Error("preview did not start")), 60_000);
        const onData = (b: Buffer) => { if (b.toString().includes(`:${port}/`)) { clearTimeout(timer); ok(); } };
        proc.stdout.on("data", onData);
        proc.stderr.on("data", onData);
        proc.on("exit", () => ng(new Error("preview exited")));
      });
      const base = `http://127.0.0.1:${port}`;
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('id="guides"');
      expect(html).toContain("mangacli-guides");
      const src = html.match(/data-src="([^"]+)"/)![1]!;
      const plain = await pixels(new Uint8Array(await (await fetch(base + src)).arrayBuffer()));
      const guided = await pixels(new Uint8Array(await (await fetch(`${base}${src}&guides=1`)).arrayBuffer()));
      const atPx = (p: typeof plain, frac: number) => p.at((frac * p.width) / 10, 10);
      expect(isWhite(atPx(plain, 0.47))).toBe(true);
      expect(isRed(atPx(guided, 0.47))).toBe(true);
      // guided pages include the 3mm bleed on each side so the trim and bleed lines are both visible
      expect(Math.abs(guided.width - plain.width * (166 / 160))).toBeLessThanOrEqual(1);
      const boxes = await (await fetch(`${base}/boxes/${src.match(/\/page\/(\d+)/)![1]}`)).json();
      expect(boxes.width).toBe(guided.width);
    } finally {
      proc.kill();
    }
  }, 90_000);
});
