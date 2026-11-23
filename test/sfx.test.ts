import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { BUILTIN_DEFAULTS } from "../src/model/defaults.js";
import { fullSizeKana, sfxInkHeadDepth, sfxScale, sfxShifts, sfxStretch, sfxWeightRadius, type SfxScaleRamp } from "../src/text/sfx.js";
import { emboldenGlyph } from "../src/text/brush.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { flattenPath, parseSvgPath, polygonArea, polyPath, transformPath } from "../src/geom/path.js";
import { boundsOf } from "../src/geom/vec.js";

const renderer = createRenderer({ profile: "preview" });
const input = (extra = "", text = "バンッ") => ({ yaml: `mangacli: 1
page: { size: B5 }
pages:
  - panels: []
    layers:
      - { sfx: "${text}", id: sfx, at: [50%, 50%], fontSize: 10mm, ${extra} }
`, filename: "/v/sfx.yaml" });

const svgPaths = async (extra = "", text = "ブオン") => {
  const source = input(extra, text);
  source.yaml = source.yaml.replace("size: B5", "size: B5, color: color");
  const result = await renderer.render(source, { format: "svg" });
  const svg = Buffer.from(result.pages[0].data).toString();
  return [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"[^>]*data-id="sfx"[^>]*\/>/g)].map(([, d, color]) => {
    const contours = flattenPath(parseSvgPath(d), 0.01);
    return { color, contours, bbox: boundsOf(contours.flatMap(c => c.pts)) };
  });
};

const inkBox = async (extra = "", text = "ドドド") => {
  const [ink] = await svgPaths(`outline: none, ${extra}`, text);
  return ink.bbox;
};

describe("SFX lettering", () => {
  it("uses the default SFX face even when the document registers a shout font", async () => {
    const sfx = input("writing: vertical", "ブオン");
    const render = async (fonts: string, explicit = "") => {
      const yaml = sfx.yaml.replace("id: sfx", `id: sfx${explicit}`);
      return (await renderer.render({ ...sfx, yaml: yaml + fonts }, { format: "svg" })).pages[0].data;
    };
    const shout = "fonts: { shout: 'catalog:dela-gothic-one', dialogue: 'catalog:zen-antique' }\n";
    const gothic = await render("", ", font: 'catalog:dela-gothic-one'");
    const unpinned = await render(shout);
    expect(unpinned).not.toEqual(gothic);
    expect(unpinned).toEqual(await render("", ", font: 'catalog:yuji-syuku'"));
    expect(await render("fonts: { sfx: 'catalog:dela-gothic-one' }\n")).toEqual(gothic);
  });
  it("uses a registered fallback before the catalog fallback for missing SFX glyphs", async () => {
    const fonts = new FontRegistry(new Map([["shout", { kind: "catalog", id: "rocknroll-one" }]]), "manga-basic", [], {});
    await fonts.prepare("sfx", "ゴ〜");
    expect(fonts.pick("sfx", "ゴ".codePointAt(0)!)?.font.key).toBe("cat:yuji-syuku@400");
    expect(fonts.pick("sfx", "〜".codePointAt(0)!)?.font.key).toBe("cat:rocknroll-one@400");
  });
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
  it.each(["vertical", "horizontal"])("packs ink in %s without collapsing the word", async writing => {
    const source = `writing: ${writing}, rotate: 0deg, grow: 0, brush: false, distort: { roughen: 0 }`;
    const axis = writing === "vertical" ? "h" : "w";
    const single = await inkBox(source, "ド");
    const normal = await inkBox(`${source}, perChar: { overlap: 0em }, letterSpacing: 0.15em`);
    const packed = await inkBox(source);
    expect(normal[axis]).toBeGreaterThan(3 * single[axis]);
    expect(packed[axis]).toBeLessThan(normal[axis]);
    expect(packed[axis]).toBeGreaterThan(2 * single[axis]);
  });
  it.each(["{ kind: line, angle: 15deg }", "{ kind: arc, radius: 70mm }", "{ kind: wave, amplitude: 2mm, wavelength: 50mm }", "{ kind: points, points: [[0mm, 0mm], [8mm, 0mm], [40mm, 10mm]] }"])("applies the word path %s before merging", async path => {
    const source = "writing: horizontal, rotate: 0deg, brush: false, perChar: { scale: shrink }";
    expect(await svgPaths(`${source}, path: ${path}`, "ドドド")).not.toEqual(await svgPaths(source, "ドドド"));
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
    const width = (scale: number, compensate = true) => boundsOf(flattenPath(transformPath(emboldenGlyph(stroke, 10, sfxWeightRadius(style, compensate ? scale : 1) * 10), [scale, 0, 0, scale, 0, 0])).flatMap(c => c.pts)).w;
    expect(width(0.7)).toBeGreaterThan(width(0.7, false));
    expect(width(0.7)).toBeLessThan(width(1));
    expect(BUILTIN_DEFAULTS.sfx.perChar).toEqual({ overlap: "0.22em" });
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
  it("applies seeded character rotation and jitter only when requested", async () => {
    const render = async (extra = "") => (await renderer.render(input(extra), { format: "svg" })).pages[0].data;
    const normal = await render();
    expect(await render("perChar: { rotate: 0deg, jitter: 0mm }")).toEqual(normal);
    const jittered = 'perChar: { rotate: [-3deg, 3deg], jitter: 0.4mm }';
    expect(await render(jittered)).not.toEqual(normal);
    expect(await render(jittered)).toEqual(await render(jittered));
  });
  it.each(["vertical", "horizontal"])("emits one continuous outer contour per outline layer for %s ブオン", async writing => {
    const layers = await svgPaths(`writing: ${writing}`);
    expect(layers.map(l => l.color)).toEqual(["#000000", "#ffffff", "#000000"]);
    for (const layer of layers.slice(0, 2)) {
      const outer = layer.contours.filter(c => polygonArea(c.pts) > 0);
      expect(outer).toHaveLength(1);
      expect(outer[0].closed).toBe(true);
    }
  });
  it.each(["vertical", "horizontal"])("keeps repeated kana distinct at the requested size in %s", async writing => {
    const style = `writing: ${writing}, grow: 0, rotate: 0deg`;
    const axis = writing === "vertical" ? "h" : "w";
    const [single] = await svgPaths(`${style}, outline: none`, "オ");
    const layers = await svgPaths(style, "オオオオ");
    const fill = layers.at(-1)!;
    const largest = Math.max(...single.contours.map(c => polygonArea(c.pts)));
    const letters = fill.contours.filter(c => polygonArea(c.pts) > 0.8 * largest);
    expect(letters).toHaveLength(4);
    expect(fill.bbox[axis]).toBeGreaterThan(3.8 * single.bbox[axis]);
    expect(layers[0].contours.filter(c => polygonArea(c.pts) > 0)).toHaveLength(1);
  });
  it("uses the word's size for default outlines and honors absolute explicit widths", async () => {
    const normal = await svgPaths("rotate: 0deg, grow: 0");
    expect((normal[1].bbox.w - normal[2].bbox.w) / 2).toBeCloseTo(1.2, 2);
    expect((normal[0].bbox.w - normal[1].bbox.w) / 2).toBeCloseTo(0.25, 2);
    const explicit = await svgPaths("outline: [{ width: 0.5mm, color: white }, { width: 2mm, color: red }]");
    expect(explicit.map(l => l.color)).toEqual(["#ff0000", "#ffffff", "#000000"]);
    expect((explicit[0].bbox.h - explicit[2].bbox.h) / 2).toBeCloseTo(2, 1);
    expect((explicit[1].bbox.h - explicit[2].bbox.h) / 2).toBeCloseTo(0.5, 1);
    expect(await svgPaths("outline: none")).toHaveLength(1);
  });
  it("preserves per-character colors without redrawing the outline for each letter", async () => {
    const layers = await svgPaths("chars: [{ index: 1, color: red }, { index: 2, color: blue }]");
    expect(layers.slice(0, 2).map(l => l.color)).toEqual(["#000000", "#ffffff"]);
    expect(layers.slice(2).map(l => l.color)).toEqual(expect.arrayContaining(["#000000", "#ff0000", "#0000ff"]));
    expect(layers.filter(l => l.color === "#ffffff")).toHaveLength(1);
  });
  it("keeps both dakuten strokes separate after adding weight to ゴ", async () => {
    const [fill] = await svgPaths("outline: none", "ゴ");
    expect(fill.contours.filter(c => polygonArea(c.pts) > 0)).toHaveLength(3);
  });
  it("keeps speed-style dakuten thin and the small kana distinct", async () => {
    const style = "writing: vertical, grow: 0, outline: none, chars: [{ index: 0, color: red }, { index: 1, color: blue }]";
    const [voiced, small] = await svgPaths(`${style}, brush: { style: speed }`, "ブォン");
    const [impact] = await svgPaths(style, "ブォン");
    const strokes = (layer: typeof voiced) => layer.contours.map(c => polygonArea(c.pts)).filter(a => a > 0.1).sort((a, b) => b - a);
    const [body, ...marks] = strokes(voiced);
    expect(voiced.color).toBe("#ff0000");
    expect(small.color).toBe("#0000ff");
    expect(marks).toHaveLength(2);
    expect(marks[0]).toBeLessThan(strokes(impact)[1]);
    expect(body).toBeGreaterThan(5 * marks[0]);
    expect(strokes(small)).toHaveLength(1);
    expect(small.bbox.h).toBeLessThan(voiced.bbox.h);
  });
  it("shapes square brush terminals before rounding the weighted ink", async () => {
    const style = "font: 'catalog:rocknroll-one', writing: horizontal, grow: 0, outline: none, distort: { roughen: 0, warp: 0 }";
    const [plain] = await svgPaths(`${style}, brush: false`, "I");
    const [entry] = await svgPaths(`${style}, brush: { taper: 0, entry: 1, wobble: 0 }`, "I");
    const [taper] = await svgPaths(`${style}, brush: { taper: 1, entry: 0, wobble: 0 }`, "I");
    expect(entry.bbox.h).toBeGreaterThan(plain.bbox.h);
    expect(taper.bbox.h).toBeGreaterThan(plain.bbox.h);
  });
  it("assigns brush extensions to the character that owns them", async () => {
    const style = "font: 'catalog:rocknroll-one', writing: horizontal, grow: 0, outline: none, distort: { roughen: 0, warp: 0 }, chars: [{ index: 0, color: red }, { index: 1, color: blue }]";
    const plain = await svgPaths(`${style}, brush: false`, "II");
    const custom = await svgPaths(`${style}, brush: { taper: 1, entry: 1, wobble: 0 }`, "II");
    expect(custom.map(layer => layer.color)).toEqual(["#ff0000", "#0000ff"]);
    custom.forEach((layer, i) => expect(layer.bbox.h).toBeGreaterThan(plain[i].bbox.h));
  });
  it("keeps interior counters in the ink and narrow custom outlines", async () => {
    const layers = await svgPaths("writing: horizontal, outline: [{ width: 0.2mm, color: white }]", "O");
    expect(layers).toHaveLength(2);
    expect(layers.every(l => l.contours.some(c => polygonArea(c.pts) < 0))).toBe(true);
  });
  it.each(["〜", "～"])("stretches the default font's %s to fill the vertical cell", async mark => {
    const { w, h } = await inkBox("writing: vertical, rotate: 0deg, grow: 0", mark);
    expect(h).toBeGreaterThan(7);
    expect(h).toBeGreaterThan(2 * w);
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
  it.each(["en", "fr", "ja"])("preserves small kana scaling after punctuation in %s", async lang => {
    const source = input("grow: 0, rotate: 0deg, brush: false, outline: none", "...ッ");
    source.yaml = source.yaml.replace("mangacli: 1", `mangacli: 1\nmeta: { lang: ${lang} }`);
    const render = async (scale: number) => {
      const scaled = { ...source, yaml: source.yaml.replace("grow: 0", `grow: 0, smallKanaScale: ${scale}`) };
      const result = await renderer.render(scaled, { format: "svg" });
      return result.layout[0].elements.find(e => e.id === "sfx")!.bbox;
    };
    const small = await render(0.6), full = await render(1);
    expect(lang === "ja" ? small.h : small.w).toBeLessThan(lang === "ja" ? full.h : full.w);
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
    const source = `writing: ${writing}, rotate: 0deg, grow: 0, brush: false, distort: { roughen: 0 }`;
    const axis = writing === "vertical" ? "h" : "w";
    const baseline = (await inkBox(source, "ドド"))[axis];
    expect((await inkBox(source, "ド<space=2/>ド"))[axis] - baseline).toBeCloseTo(20, 2);
    const offset = writing === "vertical" ? "[0mm, 5mm]" : "[5mm, 0mm]";
    expect((await inkBox(`${source}, chars: [{ index: 1, offset: ${offset} }]`, "ドド"))[axis] - baseline).toBeCloseTo(5, 2);
    const [outline] = await svgPaths(`${source}, outline: [{ width: 1mm, color: white }]`, "ド<space=2/>ド");
    expect(outline.contours.filter(c => polygonArea(c.pts) > 0).length).toBeGreaterThanOrEqual(2);
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
