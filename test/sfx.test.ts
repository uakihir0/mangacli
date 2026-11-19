import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { BUILTIN_DEFAULTS } from "../src/model/defaults.js";
import { sfxScale, sfxShifts } from "../src/text/sfx.js";
import { flattenPath } from "../src/geom/path.js";
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
  it("ramps from 95% to 130%, with a strong singleton", () => {
    expect([0, 1, 2].map(i => sfxScale(i, 3, "ド"))).toEqual([0.95, 1.125, 1.3]);
    expect(sfxScale(0, 1, "ド")).toBe(1.3);
    expect(sfxScale(2, 3, "ド", 0)).toBe(1);
    expect(sfxScale(2, 3, "ド", 0.2)).toBe(1.4);
  });
  it.each(Array.from("ッっャュョゃゅょァィゥェォヵヶ"))("shrinks small kana %s", char => {
    expect(sfxScale(0, 1, char)).toBeCloseTo(0.91);
    expect(sfxScale(0, 1, char, undefined, 1)).toBe(1.3);
  });
  it("packs scaled glyphs with overlapping negative tracking", () => {
    expect(BUILTIN_DEFAULTS.sfx.letterSpacing).toBe("-0.22em");
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
  it("scales the default white outline with font size and accepts overrides", async () => {
    const svg = async (extra: string) => Buffer.from((await renderer.render(input(extra), { format: "svg" })).pages[0].data).toString();
    expect(await svg("grow: 0")).toContain('stroke-width="1.2"');
    expect(await svg("grow: 0")).toContain('stroke-width="0.84"');
    const large = input("grow: 0");
    large.yaml = large.yaml.replace("fontSize: 10mm", "fontSize: 20mm");
    expect(Buffer.from((await renderer.render(large, { format: "svg" })).pages[0].data).toString()).toContain('stroke-width="2.4"');
    expect(await svg('outline: [{ width: 2mm, color: white }]')).toContain('stroke-width="4"');
    expect(await svg('outline: none')).not.toContain('stroke="#ffffff"');
  });
  it("paints every white glyph outline behind every glyph fill", async () => {
    const result = await renderer.render(input('chars: [{ index: 1, color: red }, { index: 2, color: blue }]'), { format: "svg" });
    const svg = Buffer.from(result.pages[0].data).toString();
    const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map(m => m[0]);
    const outlines = paths.flatMap((p, i) => p.includes('stroke="#ffffff"') ? [i] : []);
    const fills = paths.flatMap((p, i) => p.includes('data-id="sfx"') ? [i] : []);
    expect(outlines).toHaveLength(3);
    expect(fills).toHaveLength(3);
    expect(Math.max(...outlines)).toBeLessThan(Math.min(...fills));
    const widths = outlines.map(i => Number(paths[i].match(/stroke-width="([^"]+)"/)![1]));
    expect(widths[1] / widths[0]).toBeCloseTo(1.3 / 0.95, 2);
    expect(widths[2] / widths[1]).toBeCloseTo(0.7, 2);
  });
  it.each(["vertical", "horizontal"])("overlaps actual glyph extents in %s writing", async writing => {
    const list = await renderer.displayList(input(`writing: ${writing}`), 1);
    const paths: PathNode[] = [];
    const walk = (node: Node) => {
      if (node.kind === "group") node.children.forEach(walk);
      if (node.kind === "path" && node.tag?.elementId === "sfx" && node.stroke) paths.push(node);
    };
    walk(list.root);
    expect(paths).toHaveLength(3);
    const boxes = paths.map(p => boundsOf(flattenPath(p.path, 0.01).flatMap(c => c.pts)));
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1], next = boxes[i];
      expect(next.x).toBeLessThan(prev.x + prev.w);
      expect(next.y).toBeLessThan(prev.y + prev.h);
      expect(next.x + next.w).toBeGreaterThan(prev.x);
      expect(next.y + next.h).toBeGreaterThan(prev.y);
    }
  });
  it.each(["バンッ", "ダッ", "ブンッ", "ガシッ"])("preserves the original footprint for %s", async text => {
    const normal = await renderer.render(input("", text), { format: "svg" });
    const baseline = await renderer.render(input('grow: 0, smallKanaScale: 1, letterSpacing: -0.05em, perChar: { rotate: 0deg, jitter: 0mm }, distort: { roughen: 0, warp: 0, skew: 0deg }', text), { format: "svg" });
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
  it("rejects invalid small-kana scales", async () => {
    const result = await renderer.validate(input("smallKanaScale: -1"));
    expect(result.ok).toBe(false);
  });
});
