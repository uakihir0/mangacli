import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRenderer, render, validate } from "../src/api.js";
import { traceAlpha } from "../src/elements/alpha-contour.js";
import type { Node } from "../src/render/ir.js";

const scene = (effect = "", image = true) => ({ yaml: `mangacli: 1
page: { size: [64mm, 72mm], bleed: 0, baseFrame: trim, safeArea: { inset: 0 } }
assets: { cutout: { src: figure.png } }
characters: { hero: {} }
pages:
  - panels:
      - layers:
          ${image ? '- { image: cutout, id: figure, character: hero, size: [24mm, 32mm], at: [32mm, 36mm] }' : '- { text: "", id: box }'}
          ${effect ? `- { ${effect} }` : ""}
` });

async function cutout(empty = false) {
  return sharp(Buffer.from(`<svg width="96" height="128" xmlns="http://www.w3.org/2000/svg">${empty ? "" : '<path d="M28 20H68V50H82V72H64V108H54V82H42V108H32V72H14V50H28Z" fill="#777"/><rect x="85" y="116" width="4" height="4" fill="#777"/>'}</svg>`)).png().toBuffer();
}

async function raster(effect = "", empty = false) {
  const { pages, diagnostics } = await render(scene(effect), { profile: "preview", dpi: 254, colorMode: "color", assets: { cutout: await cutout(empty) } });
  expect(diagnostics.filter(d => d.severity === "error")).toEqual([]);
  return sharp(pages[0].data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe("alpha tracing", () => {
  it.each(["crop", "cover"])("ignores alpha outside the visible %s rectangle", async mode => {
    const input = scene("effect: aura, target: figure, seed: 21");
    input.yaml = input.yaml.replace("character: hero,", mode === "crop" ? "crop: [24, 0, 48, 128]," : "fit: cover,");
    if (mode === "cover") input.yaml = input.yaml.replace("24mm, 32mm", "24mm, 24mm");
    const image = async (full: boolean) => sharp(Buffer.from(`<svg width="96" height="128" xmlns="http://www.w3.org/2000/svg"><rect ${full ? 'width="96" height="128"' : mode === "crop" ? 'x="24" width="48" height="128"' : 'y="16" width="96" height="96"'} fill="#777"/></svg>`)).png().toBuffer();
    const result = async (full: boolean) => {
      const list = await createRenderer({ assets: { cutout: await image(full) } }).displayList(input, 1);
      const effects = (node: Node): Node[] => node.tag?.elementType === "effect" ? [node] : node.kind === "group" ? node.children.flatMap(effects) : [];
      return JSON.stringify(effects(list.root));
    };
    expect(await result(true) === await result(false)).toBe(true);
  });
  it("handles empty grids, disconnected contours and diagonal saddles", () => {
    expect(traceAlpha(new Uint8Array(25), 5, 5)).toEqual([]);
    const mask = new Uint8Array(36);
    mask[7] = mask[14] = mask[28] = 1;
    expect(traceAlpha(mask, 6, 6)).toHaveLength(3);
  });
});

describe.each(["aura", "arcs"])("%s", kind => {
  it("skips missing image placeholders in draft mode", async () => {
    const { diagnostics, pages } = await render(scene(`effect: ${kind}, target: figure`), { draft: true, format: "svg", throwOnError: false });
    expect(diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(pages).toHaveLength(1);
  });
  it("leaves every source-alpha pixel unchanged, even when painted above the image", async () => {
    const baseline = await raster();
    const result = await raster(`effect: ${kind}, target: figure, seed: 21`);
    let inside = 0, outsideInk = 0;
    for (let i = 0; i < baseline.data.length; i += baseline.info.channels) {
      if (baseline.data[i] > 90 && baseline.data[i] < 180) {
        expect(result.data.subarray(i, i + 3)).toEqual(baseline.data.subarray(i, i + 3));
        inside++;
      }
      if (baseline.data[i] === 255 && result.data[i] < 100) outsideInk++;
    }
    expect(inside).toBeGreaterThan(1000);
    expect(outsideInk).toBeGreaterThan(100);
  });
  it("is reproducible and varies with seed", async () => {
    const a = await raster(`effect: ${kind}, target: hero, seed: 42`);
    expect((await raster(`effect: ${kind}, target: hero, seed: 42`)).data).toEqual(a.data);
    expect((await raster(`effect: ${kind}, target: hero, seed: 43`)).data).not.toEqual(a.data);
  });
  it("handles fully transparent images without ink", async () => {
    expect((await raster(`effect: ${kind}, target: figure`, true)).data).toEqual((await raster("", true)).data);
  });
  it("targets ordinary images without character metadata", async () => {
    const input = scene(`effect: ${kind}, target: figure`);
    input.yaml = input.yaml.replace("character: hero, ", "");
    const { pages, diagnostics } = await render(input, { format: "svg", assets: { cutout: await cutout() } });
    expect(diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(Buffer.from(pages[0].data).toString()).toContain('clip-rule="evenodd"');
  });
  it("exports geometric evenodd holes to SVG", async () => {
    const { pages } = await render(scene(`effect: ${kind}, target: figure`), { format: "svg", assets: { cutout: await cutout() } });
    const svg = Buffer.from(pages[0].data).toString();
    expect(svg).toContain('clip-rule="evenodd"');
    expect(svg).toMatch(/<clipPath[^>]*><path d="[^"]*M[^"]*Z[^"]*M[^"]*Z[^"]*" clip-rule="evenodd"/);
    if (kind === "aura") expect(svg).toContain('fill-rule="evenodd"');
  });
  it("also preserves antialiased figure pixels after SVG rasterization", async () => {
    const pixels = async (effect: string) => {
      const input = scene(effect);
      input.yaml = input.yaml.replace("character: hero,", "character: hero, flip: x, rotate: 13deg,");
      const { pages, diagnostics } = await render(input, { format: "svg", colorMode: "color", assets: { cutout: await cutout() } });
      expect(diagnostics.filter(d => d.severity === "error")).toEqual([]);
      const svgAtTestScale = Buffer.from(pages[0].data).toString().replace('width="64mm" height="72mm"', 'width="640" height="720"');
      return sharp(Buffer.from(svgAtTestScale)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    };
    const a = await pixels("");
    const b = await pixels(`effect: ${kind}, target: figure, fill: black`);
    let checked = 0;
    for (let y = 180; y < 540; y++) for (let x = 140; x < 500; x++) {
      const i = (y * a.info.width + x) * a.info.channels;
      if (a.data[i] < 255) {
        expect(b.data.subarray(i, i + 3)).toEqual(a.data.subarray(i, i + 3));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
  it.each([
    ["", "SCHEMA_REQUIRED"], ["target: absent", "REF_NOT_FOUND"], ["target: box", "SCHEMA_TYPE"],
    ["target: figure, length: -1mm", "SCHEMA_TYPE"],
  ])("reports target/length errors: %s", async (extra, code) => {
    const { diagnostics } = await validate(scene(`effect: ${kind}${extra ? `, ${extra}` : ""}`, !extra.includes("box")), { assets: { cutout: await cutout() } });
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", code })]));
  });
});

describe("aura controls", () => {
  it("extends farther above than below with upward bias", async () => {
    const { data, info } = await raster("effect: aura, target: figure, upwardBias: 1, seed: 42");
    const baseline = await raster();
    let top = info.height, bottom = 0;
    for (let y = 0; y < info.height; y++) for (let x = 5; x < info.width - 5; x++) if (data[(y * info.width + x) * info.channels] < 80 && baseline.data[(y * info.width + x) * info.channels] === 255) {
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    expect(top).toBeLessThan(250);
    expect(250 - top).toBeGreaterThan(bottom - 500);
  });
  it.each(["layers: 0", "layers: 4", "upwardBias: 2", "tongues: 0", "count: -1", "fill: nonsense"])("rejects %s", async extra => {
    const { diagnostics } = await validate(scene(`effect: aura, target: figure, ${extra}`));
    expect(diagnostics.some(d => d.severity === "error")).toBe(true);
  });
  it("supports tone fill, 1–3 layers, transformed images, and zero arcs", async () => {
    const renderer = createRenderer({ assets: { cutout: await cutout() } });
    const leaves = (n: Node): Node[] => n.kind === "group" ? n.children.flatMap(leaves) : [n];
    for (const layers of [1, 2, 3]) {
      const input = scene(`effect: aura, target: figure, layers: ${layers}, fill: 'tone(20%)'`);
      input.yaml = input.yaml.replace("character: hero,", "character: hero, flip: x, rotate: 15deg,");
      const list = await renderer.displayList(input, 1);
      expect(leaves(list.root).some(n => n.kind === "path" && n.paint?.type === "tone")).toBe(true);
    }
    const list = await renderer.displayList(scene("effect: arcs, target: figure, count: 0"), 1);
    expect(leaves(list.root).filter(n => n.tag?.elementType === "effect")).toEqual([]);
  });
});
