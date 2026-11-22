import { describe, expect, it } from "vitest";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { createRenderer } from "../src/api.js";
import { BUILTIN_DEFAULTS } from "../src/model/defaults.js";
import { fullSizeKana, sfxInkHeadDepth, sfxScale, sfxShifts, sfxStretch, sfxWeightRadius, type SfxScaleRamp } from "../src/text/sfx.js";
import { emboldenGlyph } from "../src/text/brush.js";
import { flattenPath, pathToSvg, polyPath, transformPath } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";
import type { Node, PathNode } from "../src/render/ir.js";

const renderer = createRenderer({ profile: "preview" });
const input = (extra = "", text = "バンッ") => ({ yaml: `mangacli: 1
page: { size: B5 }
pages:
  - panels: []
    layers:
      - { sfx: "${text}", id: sfx, at: [50%, 50%], fontSize: 10mm, ${extra} }
`, filename: "/v/sfx.yaml" });

describe("SFX lettering", () => {
  it("limits covered fill area in either direction and handles empty ink", () => {
    const rect = polyPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }], true);
    expect(sfxInkHeadDepth(rect, true)).toBeCloseTo(1.4);
    expect(sfxInkHeadDepth(rect, false)).toBeCloseTo(2.8);
    expect(sfxInkHeadDepth([], true)).toBe(0);
    expect(sfxInkHeadDepth(polyPath([{ x: 0, y: 0 }, { x: 0, y: 10 }], true), true)).toBe(0);
  });
  it.each([
    ["grow", [0.85, 1.075, 1.3]],
    ["shrink", [1.3, 1.05, 0.8]],
    ["burst", [0.9, 1.35, 0.9]],
    ["flat", [1, 1, 1]],
    [{ from: 0.5, to: 1.5 }, [0.5, 1, 1.5]],
  ] as [SfxScaleRamp, number[]][])("interpolates scale ramp %j", (preset, expected) => {
    expected.forEach((n, i) => {
      expect(sfxScale(i, 3, "ド", undefined, 0.6, "impact", preset)).toBeCloseTo(n);
      expect(sfxScale(i, 3, "ッ", undefined, 0.6, "impact", preset)).toBeCloseTo(n * 0.6);
      expect(sfxScale(i, 3, "ド", 0, 0.6, "impact", preset)).toBe(1);
    });
  });
  it.each(["grow", "shrink", "burst", "flat", "{ from: 0.6, to: 1.4 }", "[0.8, 1.2]", "{ min: 0.8, max: 1.2 }"])("renders scale syntax %s deterministically", async scale => {
    const source = input(`perChar: { scale: ${scale} }`);
    const first = await renderer.render(source, { format: "svg" });
    expect(first.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect((await renderer.render(source, { format: "svg" })).pages[0].data).toEqual(first.pages[0].data);
  });
  it.each(["bogus", "{ from: 0, to: 1 }", "{ from: 1 }", "{ from: 1, to: -1 }"])("rejects invalid ramp %s", async scale => {
    expect((await renderer.validate(input(`perChar: { scale: ${scale} }`))).ok).toBe(false);
  });
  const glyphBoxes = async (extra: string, text = "ドドド") => {
    const list = await renderer.displayList(input(extra, text), 1);
    const result: ReturnType<typeof boundsOf>[] = [];
    const walk = (n: Node) => {
      if (n.kind === "group") n.children.forEach(walk);
      if (n.kind === "path" && n.tag?.elementId === "sfx" && n.paint && !n.stroke) result.push(boundsOf(flattenPath(n.path, 0.01).flatMap(c => c.pts)));
    };
    walk(list.root);
    return result.reverse();
  };
  it.each(["vertical", "horizontal"])("caps ink overlap at the requested distance in %s", async writing => {
    const source = `writing: ${writing}, rotate: 0deg, grow: 0, brush: false, distort: { roughen: 0 }, `;
    for (const path of ["", "path: { kind: line, angle: 0deg }, "]) {
      for (const overlap of ["0em", "0.15em", "0.3em"]) {
        const boxes = await glyphBoxes(`${source}${path}perChar: { overlap: ${overlap}, rotate: 0deg, jitter: 0mm }`);
        for (let i = 1; i < boxes.length; i++) {
          const gap = writing === "vertical" ? boxes[i].y - boxes[i-1].y - boxes[i-1].h : boxes[i].x - boxes[i-1].x - boxes[i-1].w;
          if (overlap !== "0em") expect(gap).toBeGreaterThanOrEqual(-parseFloat(overlap) * 10 - 0.01);
          else expect(gap).toBeGreaterThanOrEqual(0.29);
        }
      }
    }
  });
  it.each(["vertical", "horizontal"])("measures overlap relative to the smaller scaled character in %s", async writing => {
    const boxes = await glyphBoxes(`writing: ${writing}, rotate: 0deg, grow: 0, outline: none, brush: false, distort: { roughen: 0 }, chars: [{ index: 1, scale: 0.5 }], perChar: { overlap: 0.01em, rotate: 0deg, jitter: 0mm }`, "ドド");
    const gap = writing === "vertical" ? boxes[1].y - boxes[0].y - boxes[0].h : boxes[1].x - boxes[0].x - boxes[0].w;
    expect(gap).toBeCloseTo(-0.01 * 10 * 0.5, 2);
  });
  it.each(["vertical", "horizontal"].flatMap(writing => ["ドンッ", "ズオオオッ", "バキィッ"].map(text => ({ writing, text }))))("keeps at least 85 percent of every default $writing $text character fill visible", async ({ writing, text }) => {
    const list = await renderer.displayList(input(`writing: ${writing}`, text), 1);
    const paths: PathNode[] = [];
    const walk = (n: Node) => {
      if (n.kind === "group") n.children.forEach(walk);
      if (n.kind === "path") paths.push(n);
    };
    walk(list.root);
    const fills = paths.filter(n => n.tag?.elementId === "sfx" && n.paint && !n.stroke);
    expect(fills).toHaveLength(Array.from(text).length);
    for (const fill of fills) {
      const bb = boundsOf(flattenPath(fill.path, 0.02).flatMap(c => c.pts));
      const canvas = createCanvas(Math.ceil(bb.w * 24) + 8, Math.ceil(bb.h * 24) + 8);
      const ctx = canvas.getContext("2d");
      ctx.scale(24, 24);
      ctx.translate(-bb.x + 4 / 24, -bb.y + 4 / 24);
      ctx.fill(new Path2D(pathToSvg(fill.path)));
      const ink = () => ctx.getImageData(0, 0, canvas.width, canvas.height).data.reduce((sum, v, i) => sum + (i % 4 === 3 ? v : 0), 0);
      const total = ink();
      ctx.globalCompositeOperation = "destination-out";
      for (const front of paths.slice(paths.indexOf(fill) + 1)) {
        if (front.tag?.elementId !== "sfx") continue;
        const path = new Path2D(pathToSvg(front.path));
        if (front.stroke) {
          ctx.lineWidth = front.stroke.width;
          ctx.lineJoin = "round";
          ctx.stroke(path);
        } else if (front.paint) ctx.fill(path);
      }
      expect(ink() / total).toBeGreaterThanOrEqual(0.85);
    }
  });
  it.each(["{ kind: line, angle: 15deg }", "{ kind: arc, radius: 70mm }", "{ kind: wave, amplitude: 2mm, wavelength: 50mm }", "{ kind: points, points: [[0mm, 0mm], [80mm, 0mm], [120mm, 10mm]] }"])("applies ramps and overlap along path %s", async path => {
    const boxes = async (overlap: string) => glyphBoxes(`writing: horizontal, rotate: 0deg, path: ${path}, brush: false, distort: { roughen: 0 }, perChar: { scale: shrink, overlap: ${overlap}, rotate: 0deg, jitter: 0mm }`);
    const normal = await boxes("0em"), packed = await boxes("0.15em");
    expect(packed[0].w).toBeGreaterThan(packed[2].w);
    const distance = (b: typeof packed) => Math.hypot(b[2].x-b[0].x, b[2].y-b[0].y);
    expect(distance(packed)).toBeLessThan(distance(normal));
  });
  it.each(Array.from("ー〜～ｰ︱︲︴"))("stretches long mark %s only along the writing direction", char => {
    expect(sfxStretch(char, true)).toEqual([1, 1.6]);
    expect(sfxStretch(char, false)).toEqual([1.6, 1]);
  });
  it.each(["", "ド", "ッ", "A"])("does not stretch ordinary or empty units %s", char => {
    expect(sfxStretch(char, true)).toEqual([1, 1]);
    expect(sfxStretch(char, false)).toEqual([1, 1]);
  });
  it.each(["vertical", "horizontal"])("renders seeded long marks and waves in %s", async writing => {
    const source = input(`writing: ${writing}`, "ズオーッ〜～");
    const first = await renderer.render(source, { format: "svg" });
    expect(first.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect((await renderer.render(source, { format: "svg" })).pages[0].data).toEqual(first.pages[0].data);
  });
  it("roughens default contours deterministically and permits smooth overrides", async () => {
    expect(BUILTIN_DEFAULTS.sfx.distort).toEqual({ roughen: 0.4, warp: 0, skew: "0deg" });
    const first = await renderer.render(input(), { format: "svg" });
    expect((await renderer.render(input(), { format: "svg" })).pages[0].data).toEqual(first.pages[0].data);
    expect((await renderer.render(input("distort: { roughen: 0 }"), { format: "svg" })).pages[0].data).not.toEqual(first.pages[0].data);
  });
  it("accents the head for impact and grows toward the stop for speed without random scale", () => {
    expect([0, 1, 2].map(i => sfxScale(i, 3, "ド"))).toEqual([1.3, 1.05, 0.8]);
    expect([0, 1, 2].map(i => sfxScale(i, 3, "ド", undefined, 0.7, "speed"))).toEqual([0.95, 1.125, 1.3]);
    expect(sfxScale(0, 1, "ド")).toBe(1.3);
    expect(sfxScale(2, 3, "ド", 0)).toBe(1);
    expect(sfxScale(2, 3, "ド", 0.2)).toBe(1.4);
  });
  it.each(["impact", "speed"] as const)("compensates small-kana stroke weight in %s", style => {
    expect(fullSizeKana("ッ")).toBe("ツ");
    expect(fullSizeKana("ゃ")).toBe("や");
    expect(fullSizeKana("ン")).toBe("ン");
    const stroke = polyPath([{ x: 0, y: 0 }, { x: 1.6, y: 0 }, { x: 1.6, y: 10 }, { x: 0, y: 10 }], true);
    const width = (scale: number) => boundsOf(flattenPath(transformPath(emboldenGlyph(stroke, 10, sfxWeightRadius(style, scale) * 10), [scale, 0, 0, scale, 0, 0])).flatMap(c => c.pts)).w;
    expect(width(0.7)).toBeCloseTo(width(1));
    expect(BUILTIN_DEFAULTS.sfx.perChar).toEqual({ rotate: ["-3deg", "3deg"], overlap: "0.15em" });
  });
  it.each(Array.from("ッっャュョゃゅょァィゥェォヵヶ"))("shrinks small kana %s", char => {
    expect(sfxScale(0, 1, char)).toBeCloseTo(0.78);
    expect(sfxScale(0, 1, char, undefined, 1)).toBe(1.3);
  });
  it("packs scaled glyphs with overlapping negative tracking", () => {
    expect(BUILTIN_DEFAULTS.sfx.letterSpacing).toBe("-0.03em");
    const scales = [0.85, 1, 1.15];
    const shift = sfxShifts(scales, 10);
    for (let i = 1; i < scales.length; i++) {
      const distance = 7.8 + shift[i] - shift[i - 1];
      expect(distance).toBeLessThan((scales[i] + scales[i - 1]) * 5);
    }
    expect(sfxShifts([], 10)).toEqual([]);
  });
  it("reproduces seeded jitter and permits disabling it", async () => {
    const render = async (extra = "") => (await renderer.render(input(extra), { format: "svg" })).pages[0].data;
    const a = await render();
    expect(await render()).toEqual(a);
    expect(await render('perChar: { rotate: 0deg }')).not.toEqual(a);
    expect(await render('perChar: { jitter: 0mm }')).not.toEqual(a);
  });
  it("scales the default double outline with font size and accepts overrides", async () => {
    const svg = async (extra: string) => Buffer.from((await renderer.render(input(`perChar: { scale: 1 }, ${extra}`), { format: "svg" })).pages[0].data).toString();
    expect(await svg("grow: 0")).toContain('stroke-width="2.4"');
    expect(await svg("grow: 0")).toContain('stroke-width="2.9"');
    expect(await svg("grow: 0")).toContain('stroke-width="1.44"');
    const large = input("grow: 0, perChar: { scale: 1 }");
    large.yaml = large.yaml.replace("fontSize: 10mm", "fontSize: 20mm");
    expect(Buffer.from((await renderer.render(large, { format: "svg" })).pages[0].data).toString()).toContain('stroke-width="4.8"');
    expect(await svg('outline: [{ width: 2mm, color: white }]')).toContain('stroke-width="4"');
    expect(await svg('outline: none')).not.toContain('stroke-width=');
    expect((await svg('outline: [{ width: 2mm, color: white }]')).match(/stroke-width=/g)).toHaveLength(3);
  });
  it("paints later characters underneath earlier outlines and fills", async () => {
    const source = input('chars: [{ index: 1, color: red }, { index: 2, color: blue }]');
    source.yaml = source.yaml.replace('size: B5', 'size: B5, color: color');
    const result = await renderer.render(source, { format: "svg" });
    const svg = Buffer.from(result.pages[0].data).toString();
    const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map(m => m[0]).filter(p => p.includes('stroke=') || p.includes('data-id="sfx"'));
    const outlines = paths.flatMap((p, i) => p.includes('stroke="#ffffff"') ? [i] : []);
    const fills = paths.flatMap((p, i) => p.includes('data-id="sfx"') ? [i] : []);
    expect(outlines).toHaveLength(3);
    expect(fills).toHaveLength(3);
    expect(outlines).toEqual([1, 4, 7]);
    expect(fills).toEqual([2, 5, 8]);
    expect(paths[fills[0]]).toContain('fill="#0000ff"');
    expect(paths[fills[1]]).toContain('fill="#ff0000"');
    const widths = outlines.map(i => Number(paths[i].match(/stroke-width="([^"]+)"/)![1]));
    expect(widths[0] / widths[1]).toBeCloseTo(0.6, 2);
    expect(widths[1] / widths[2]).toBeCloseTo(0.8 / 1.3, 2);
    const black = paths.flatMap((p, i) => p.includes('stroke="#000000"') ? [i] : []);
    expect(black).toHaveLength(3);
    expect(black).toEqual([0, 3, 6]);
    black.forEach((index, i) => expect(Number(paths[index].match(/stroke-width="([^"]+)"/)![1]) - widths[i]).toBeCloseTo(0.5));
  });
  it("paints explicit outlines under their own character fill", async () => {
    const result = await renderer.render(input("outline: [{ width: 0.5mm, color: white }, { width: 2mm, color: red }]"), { format: "svg" });
    const paths = [...Buffer.from(result.pages[0].data).toString().matchAll(/<path\b[^>]*>/g)].map(m => m[0]).filter(p => p.includes('stroke=') || p.includes('data-id="sfx"'));
    const outlines = paths.filter(p => p.includes("stroke-width="));
    expect(outlines.map(p => Number(p.match(/stroke-width="([^"]+)"/)![1]))).toEqual([4, 1, 4, 1, 4, 1]);
    expect(paths.flatMap((p, i) => p.includes('data-id="sfx"') ? [i] : [])).toEqual([2, 5, 8]);
  });
  it.each(["vertical", "horizontal"].flatMap(writing => ["バンッ", "ダッ", "ブンッ", "ガシッ"].map(text => ({ writing, text }))))("limits small kana ink bbox overlap in $writing $text", async ({ writing, text }) => {
    const list = await renderer.displayList(input(`writing: ${writing}, rotate: 0deg, perChar: { overlap: 0em }`, text), 1);
    const paths: PathNode[] = [];
    const walk = (node: Node) => {
      if (node.kind === "group") node.children.forEach(walk);
      if (node.kind === "path" && node.tag?.elementId === "sfx" && node.stroke?.paint.type === "solid" && node.stroke.paint.color.r === 1) paths.push(node);
    };
    walk(list.root);
    paths.reverse();
    expect(paths).toHaveLength(Array.from(text).length);
    const boxes = paths.map(p => boundsOf(flattenPath(p.path, 0.01).flatMap(c => c.pts)));
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1], next = boxes[i];
      const overlap = writing === "vertical" ? prev.y + prev.h - next.y : prev.x + prev.w - next.x;
      expect(overlap).toBeLessThanOrEqual(0.5);
      if (i === boxes.length - 1) expect(overlap).toBeLessThanOrEqual(0);
    }
  });
  it.each(["バンッ", "ダッ", "ブンッ", "ガシッ"])("preserves the original footprint for %s", async text => {
    const normal = await renderer.render(input("perChar: { overlap: 0em }", text), { format: "svg" });
    const baseline = await renderer.render(input('grow: 0, smallKanaScale: 1, letterSpacing: -0.05em, perChar: { overlap: 0em, rotate: 0deg, jitter: 0mm }, distort: { roughen: 0, warp: 0, skew: 0deg }', text), { format: "svg" });
    const area = (result: typeof normal) => {
      const b = result.layout[0].elements.find(e => e.id === "sfx")!.bbox;
      return b.w * b.h;
    };
    expect(area(normal)).toBeGreaterThanOrEqual(area(baseline));
  });
  it("renders empty SFX without errors", async () => {
    const result = await renderer.render(input("", ""), { format: "svg" });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  });
  it.each(["en", "fr", "ja"])("uses layout tokenization for small kana after punctuation in %s", async lang => {
    const widths = async (text: string) => {
      const source = input("grow: 0, rotate: 0deg, brush: false, perChar: { rotate: 0deg, jitter: 0mm }", text);
      source.yaml = source.yaml.replace("mangacli: 1", `mangacli: 1\nmeta: { lang: ${lang} }`);
      const svg = Buffer.from((await renderer.render(source, { format: "svg" })).pages[0].data).toString();
      return [...svg.matchAll(/<path\b[^>]*stroke="#ffffff"[^>]*>/g)].map(m => Number(m[0].match(/stroke-width="([^"]+)"/)![1]));
    };
    const result = await widths("...ッ");
    expect(result).toHaveLength(lang === "ja" ? 2 : 4);
    expect(result[0]).toBeCloseTo(1.44);
    expect((await widths("--ッ"))[0]).toBeCloseTo(1.44);
  });
  it("does not undo explicit shrink controls when grow is omitted", async () => {
    const box = async (extra: string, text = "ド") => (await renderer.render(input(`rotate: 0deg, brush: false, distort: { roughen: 0 }, perChar: { rotate: 0deg, jitter: 0mm }, ${extra}`, text), { format: "svg" })).layout[0].elements.find(e => e.id === "sfx")!.bbox;
    const baseline = await box("chars: [{ index: 0, scale: 1 }]");
    const shrunk = await box("chars: [{ index: 0, scale: 0.5 }]");
    expect(shrunk.w / baseline.w).toBeCloseTo(0.5);
    expect(shrunk.h / baseline.h).toBeCloseTo(0.5);
    const small = await box("smallKanaScale: 0.35", "ッ");
    const explicit = await box("smallKanaScale: 0.35, grow: 0", "ッ");
    expect(small.w / explicit.w).toBeCloseTo(1.3);
    expect(small.h / explicit.h).toBeCloseTo(1.3);
  });
  it.each(["vertical", "horizontal"])("preserves explicit spaces and along-axis character offsets in %s SFX", async writing => {
    const boxes = async (text: string, chars = "[]") => {
      const list = await renderer.displayList(input(`writing: ${writing}, rotate: 0deg, grow: 0, brush: false, outline: [{ width: 1mm, color: white }], perChar: { rotate: 0deg, jitter: 0mm }, chars: ${chars}`, text), 1);
      const result: ReturnType<typeof boundsOf>[] = [];
      const walk = (node: Node) => {
        if (node.kind === "group") node.children.forEach(walk);
        if (node.kind === "path" && node.tag?.elementId === "sfx" && node.stroke) result.push(boundsOf(flattenPath(node.path, 0.01).flatMap(c => c.pts)));
      };
      walk(list.root);
      return result.reverse();
    };
    const gap = (b: Awaited<ReturnType<typeof boxes>>) => writing === "vertical" ? b[1].y - b[0].y - b[0].h : b[1].x - b[0].x - b[0].w;
    const baseline = gap(await boxes("ドド"));
    expect(gap(await boxes("ド<space=2/>ド")) - baseline).toBeCloseTo(20);
    const offset = writing === "vertical" ? "[0mm, 5mm]" : "[5mm, 0mm]";
    expect(gap(await boxes("ドド", `[{ index: 1, offset: ${offset} }]`)) - baseline).toBeCloseTo(5);
  });
  it("rejects invalid small-kana scales", async () => {
    const result = await renderer.validate(input("smallKanaScale: -1"));
    expect(result.ok).toBe(false);
  });
  it("allows disabling brush pressure and rejects invalid controls", async () => {
    const a = await renderer.render(input("brush: false"), { format: "svg" });
    const b = await renderer.render(input("brush: { taper: 0, entry: 0, wobble: 0 }"), { format: "svg" });
    expect(a.pages[0].data).toEqual(b.pages[0].data);
    expect((await renderer.validate(input("brush: { taper: -1 }"))).ok).toBe(false);
    expect((await renderer.validate(input("brush: { style: impact }"))).ok).toBe(true);
    expect((await renderer.validate(input("brush: { style: speed }"))).ok).toBe(true);
    expect((await renderer.validate(input("brush: { style: unknown }"))).ok).toBe(false);
  });
});
