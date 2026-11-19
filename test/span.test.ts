import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { parse } from "yaml";
import { createRenderer, layout, render, validate } from "../src/api.js";
import type { GroupNode, Node } from "../src/render/ir.js";

function groups(n: Node): GroupNode[] {
  return n.kind === "group" ? [n, ...n.children.flatMap(groups)] : [];
}

function scene(open = "", stack = "over", ids = "a, b") {
  return `mangacli: 1
page: { size: [100mm, 80mm], bleed: 0mm }
pages:
  - layout: { rows: [{ cols: [1, 1] }] }
    panels:
      - { id: a }
      - { id: b }
    layers:
      - type: fill
        id: span
        region: page
        paint: black
        clip: { to: [${ids}]${open ? `, open: [${open}]` : ""} }
        stack: ${stack}
`;
}

describe("spanning elements", () => {
  it.each(["png", "svg"] as const)("interrupts only figure-covered open frames for art and over spans in %s", async (format) => {
    const figure = await sharp({ create: { width: 100, height: 80, channels: 4, background: "transparent" } })
      .composite([{ input: await sharp({ create: { width: 20, height: 80, channels: 4, background: "#888888" } }).png().toBuffer(), left: 30, top: 0 }])
      .png().toBuffer();
    for (const stack of ["art", "over"]) {
      const doc = parse(scene("top", stack));
      delete doc.pages[0].layout;
      doc.page.baseFrame = "trim";
      doc.pages[0].panels = [
        { id: "a", box: ["10mm", "20mm", "80mm", "20mm"], border: { width: "2mm", color: "black" } },
        { id: "b", box: ["10mm", "50mm", "80mm", "20mm"], border: { width: "2mm", color: "black" } },
      ];
      doc.assets = { figure: { src: "figure.png" } };
      doc.pages[0].layers = [{ image: "figure", size: ["100mm", "80mm"], at: ["0mm", "0mm"], anchor: "top-left", fit: "fill", outline: "0.8mm white", clip: { to: ["a", "b"], open: ["top"] }, stack }];
      const result = await render(doc, { format, dpi: 127, colorMode: "gray", assets: { figure } });
      const { data, info } = await sharp(result.pages[0].data).resize(500, 400).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => data[(Math.round(y * 5) * info.width + Math.round(x * 5)) * info.channels];
      for (const y of [19.4, 20, 20.6]) expect(at(40, y)).toBeGreaterThan(100);
      expect(at(40, 20)).toBeLessThan(160);
      expect(Math.abs(at(40, 21) - at(40, 25))).toBeLessThan(3);
      expect(at(70, 20)).toBeLessThan(10);
      expect(at(40, 40)).toBeLessThan(40);
      if (stack === "art") expect(at(40, 50)).toBeLessThan(40);
      expect(at(40, 45)).toBeGreaterThan(240);
      expect(at(10, 30)).toBeLessThan(10);
    }
  });

  it.each(["png", "svg"] as const)("keeps curved top breakouts continuous in %s", async (format) => {
    const doc = parse(scene("top", "over", "a"));
    doc.pages[0].panels[0].shape = { kind: "ellipse" };
    const result = await render(doc, { format, dpi: 127, colorMode: "gray" });
    const box = result.layout[0].panels.find((p) => p.id === "a")!.box;
    const { data, info } = await sharp(result.pages[0].data).resize(500, 400).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(Math.round(y * 5) * info.width + Math.round(x * 5)) * info.channels];
    for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      expect(at(box.x + box.w * fraction, box.y - 2)).toBeLessThan(10);
    }
    expect(at(box.x + box.w / 2, box.y + box.h / 2)).toBeLessThan(10);
    expect(at(box.x + 0.5, box.y + box.h - 0.5)).toBeGreaterThan(240);
  });

  it.each(["ellipse", "rounded", "cloud"])("clips over spans to the real %s panel shape", async (kind) => {
    const doc = parse(scene());
    doc.pages[0].panels[0].shape = { kind, radius: "10mm" };
    doc.pages[0].layers[0].clip.to = ["a"];
    const result = await render(doc, { format: "png", dpi: 127, colorMode: "gray", keepLists: true });
    const box = result.layout[0].panels.find((p) => p.id === "a")!.box;
    const { data, info } = await sharp(result.pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(Math.round(y * 5) * info.width + Math.round(x * 5)) * info.channels];
    expect(at(box.x + 0.5, box.y + 0.5)).toBeGreaterThan(240);
    expect(at(box.x + box.w / 2, box.y + box.h / 2)).toBeLessThan(10);
    expect(groups(result.lists![0].root).some((g) => g.clip?.some((c) => c[0] === "C") && !g.tag)).toBe(true);
  });

  it("uses one nonzero path with a subpath for every panel and is deterministic", async () => {
    const r = createRenderer({ seed: 42 });
    const a = await r.displayList({ yaml: scene() }, 1);
    const b = await r.displayList({ yaml: scene() }, 1);
    expect(a).toEqual(b);
    const clip = groups(a.root).find((g) => g.clip?.filter((c) => c[0] === "M").length === 2);
    expect(clip?.clipRule).toBe("nonzero");
  });

  it.each(["png", "svg"] as const)("keeps gutters empty and overlapping open polygons filled outside the panels in %s", async (format) => {
    const pixels = async (open: string) => {
      const result = await render({ yaml: scene(open) }, { format, dpi: 127, colorMode: "gray" });
      return sharp(result.pages[0].data).resize(500, 400).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    };
    const closed = await pixels("");
    const opened = await pixels("left, right");
    const at = (p: typeof closed, x: number, y: number) => p.data[(y * p.info.width + x) * p.info.channels];
    expect(at(closed, 250, 200)).toBeGreaterThan(240);
    expect(at(opened, 250, 200)).toBeGreaterThan(240);
    expect(at(closed, 20, 200)).toBeGreaterThan(240);
    expect(at(opened, 20, 200)).toBeLessThan(10);
  });

  it.each(["png", "svg"] as const)("preserves internal gutters for art spans with an open top in %s", async (format) => {
    const yaml = scene("top", "art").replace("rows: [{ cols: [1, 1] }]", "rows: [{ cols: [1] }, { cols: [1] }]");
    const result = await render({ yaml }, { format, dpi: 127, colorMode: "gray" });
    const { data, info } = await sharp(result.pages[0].data).resize(500, 400).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(200 * info.width + 250) * info.channels]).toBeGreaterThan(240);
    expect(data[(20 * info.width + 250) * info.channels]).toBeLessThan(10);
  });

  it.each(["png", "svg"] as const)("keeps overlapping target frames above open art spans in %s", async (format) => {
    const doc = parse(scene("top", "art"));
    delete doc.pages[0].layout;
    doc.page.baseFrame = "trim";
    doc.pages[0].panels = [
      { id: "a", box: ["10mm", "20mm", "50mm", "50mm"], border: { width: "2mm", color: "black" } },
      { id: "b", box: ["30mm", "10mm", "50mm", "50mm"], border: { width: "2mm", color: "black" } },
    ];
    doc.pages[0].layers[0].paint = "white";
    const result = await render(doc, { format, dpi: 127, colorMode: "gray" });
    const { data, info } = await sharp(result.pages[0].data).resize(500, 400).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(100 * info.width + 200) * info.channels]).toBeLessThan(10);
  });

  it.each(["over", "art"])("puts %s spans in the intended frame layer", async (stack) => {
    const list = await createRenderer().displayList({ yaml: scene("", stack) }, 1);
    const all = groups(list.root);
    const arts = all.filter((g) => g.tag?.role === "art");
    const containsSpan = (g: GroupNode) => groups(g).some((n) => n.clip?.filter((c) => c[0] === "M").length === 2);
    expect(arts).toHaveLength(2);
    expect(arts.every(containsSpan)).toBe(stack === "art");
    const root = all.find((g) => g.children.some((n) => n.tag?.role === "frame"))!;
    if (stack === "over") expect(containsSpan(root.children.at(-1) as GroupNode)).toBe(true);
  });

  it("reports missing targets with a path and keeps valid targets", async () => {
    const result = await validate({ yaml: scene("", "over", "a, missing") });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "REF_NOT_FOUND", path: expect.arrayContaining(["clip", "to"]) }));
  });

  it("rejects an empty target list", async () => {
    expect((await validate({ yaml: scene("", "over", "") })).ok).toBe(false);
  });

  it.each(["face", "avoid"])("avoids page-image %s regions in a spanned panel before placing its balloons", async (kind) => {
    const data = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    const place = async (regions: string) => layout({ yaml: `mangacli: 1
meta: { lang: en }
page: { size: [100mm, 80mm], bleed: 0mm }
assets:
  figure: { src: figure.png, ${regions} }
pages:
  - layout: { rows: [{ cols: [1, 1] }] }
    layers:
      - { image: figure, size: [100mm, 80mm], at: [0mm, 0mm], anchor: top-left, fit: fill, clip: { to: [a, b] } }
    panels:
      - id: a
        layers:
          - { balloon: Hello, id: speech }
      - { id: b }
` }, { seed: 42, assets: { figure: data } });
    const baseline = await place("regions: {}");
    const initial = baseline.pages[0].elements.find((e) => e.id === "speech")!.bbox;
    const region = [initial.x, initial.y / 0.8, initial.w, initial.h / 0.8];
    const avoided = await place(`regions: { ${kind}: [${region.join(", ")}] }`);
    const moved = avoided.pages[0].elements.find((e) => e.id === "speech")!.bbox;
    expect(moved).not.toEqual(initial);
    const overlap = Math.max(0, Math.min(moved.x + moved.w, initial.x + initial.w) - Math.max(moved.x, initial.x)) * Math.max(0, Math.min(moved.y + moved.h, initial.y + initial.h) - Math.max(moved.y, initial.y));
    expect(overlap).toBeLessThan(initial.w * initial.h * 0.1);
  });

  it("accepts span clips on panel elements as well as page layers", async () => {
    const parsed = parse(scene());
    parsed.pages[0].panels[0].layers = parsed.pages[0].layers;
    delete parsed.pages[0].layers;
    const list = await createRenderer().displayList(parsed, 1);
    expect(groups(list.root).some((g) => g.clip?.filter((c) => c[0] === "M").length === 2)).toBe(true);
  });

  it.each([true, false])("recognizes page-level speakers with span clip = %s and aims at their mouth", async (clipped) => {
    const data = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    const yaml = `mangacli: 1
meta: { lang: en }
page: { size: [100mm, 80mm], bleed: 0mm }
assets:
  figure: { src: figure.png, character: hero, anchors: { mouth: [75, 40] } }
pages:
  - layers:
      - { image: figure, id: figure-image, size: [100mm, 80mm], at: [0mm, 0mm], anchor: top-left, fit: fill${clipped ? ", clip: { to: [a] }" : ""} }
    panels:
      - id: a
        layers:
          - { balloon: Hello, who: hero, id: speech, at: [20%, 20%], tail: { kind: line, allowVertical: true } }
`;
    const options = { seed: 42, assets: { figure: data } };
    const result = await validate({ yaml }, options);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "DIALOGUE_SPEAKER_NOT_IN_PANEL")).toBe(false);
    const implicit = await createRenderer(options).displayList({ yaml }, 1);
    const explicit = await createRenderer(options).displayList({ yaml: yaml.replace("kind: line,", "kind: line, to: figure-image.mouth,") }, 1);
    expect(implicit).toEqual(explicit);
  });

  it("does not register a clipped page speaker in an unlisted intersecting panel", async () => {
    const doc = parse(scene("", "over", "a"));
    doc.assets = { figure: { src: "figure.png", character: "hero", anchors: { mouth: [75, 40] } } };
    doc.pages[0].layers = [{ image: "figure", size: ["100mm", "80mm"], at: ["0mm", "0mm"], anchor: "top-left", fit: "fill", clip: { to: ["a"] } }];
    doc.pages[0].panels[1].layers = [{ balloon: "Hello", who: "hero", id: "unlisted-speech" }];
    const data = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    const result = await validate(doc, { assets: { figure: data } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "DIALOGUE_SPEAKER_NOT_IN_PANEL", elementId: "unlisted-speech" }));
  });

  it("registers a panel-level spanning speaker in each target panel", async () => {
    const doc = parse(scene());
    doc.assets = { figure: { src: "figure.png", character: "hero", anchors: { mouth: [75, 40] } } };
    doc.pages[0].panels[0].layers = [{ image: "figure", id: "figure-image", coords: "page", size: ["100mm", "80mm"], at: ["0mm", "0mm"], anchor: "top-left", fit: "fill", clip: { to: ["a", "b"] } }];
    doc.pages[0].panels[1].layers = [{ balloon: "Hello", who: "hero", id: "speech", tail: { kind: "line", allowVertical: true } }];
    delete doc.pages[0].layers;
    const data = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    const options = { seed: 42, assets: { figure: data } };
    const result = await validate(doc, options);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "DIALOGUE_SPEAKER_NOT_IN_PANEL")).toBe(false);
    const implicit = await createRenderer(options).displayList(doc, 1);
    doc.pages[0].panels[1].layers[0].tail.to = "figure-image.mouth";
    expect(await createRenderer(options).displayList(doc, 1)).toEqual(implicit);
  });
});
