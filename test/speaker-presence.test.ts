import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { validate } from "../src/api.js";

function scene(image: Record<string, unknown>, panelLevel = false) {
  return {
    mangacli: 1,
    meta: { lang: "en" },
    page: { size: ["100mm", "80mm"], bleed: "0mm", baseFrame: "trim" },
    assets: { figure: { src: "figure.png", character: "hero" } },
    pages: [{
      layers: panelLevel ? [] : [image],
      panels: [
        { id: "a", box: ["0mm", "0mm", "45mm", "80mm"], layers: panelLevel ? [image] : [] },
        { id: "b", box: ["55mm", "0mm", "45mm", "80mm"], layers: [{ balloon: "Hello", who: "hero", id: "speech", at: ["50%", "30%"] }] },
      ],
    }],
  };
}

const image = { image: "figure", id: "figure-image", coords: "page", size: ["100mm", "80mm"], at: ["0mm", "0mm"], anchor: "top-left", fit: "fill" };

async function art(width: number, alpha = 255) {
  return sharp({ create: { width: 100, height: 80, channels: 4, background: "transparent" } })
    .composite([{ input: await sharp({ create: { width, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: alpha / 255 } } }).png().toBuffer(), left: 0, top: 10 }])
    .png().toBuffer();
}

async function absent(doc: ReturnType<typeof scene>, data?: Buffer) {
  const result = await validate(doc, data ? { assets: { figure: data } } : {});
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.diagnostics.some((d) => d.code === "DIALOGUE_SPEAKER_NOT_IN_PANEL" && d.elementId === "speech");
}

describe("visible speaker presence", () => {
  it.each([false, true])("ignores transparent overlap with panel-level = %s", async (panelLevel) => {
    expect(await absent(scene({ ...image, ...(panelLevel ? { clip: { to: ["a", "b"] } } : {}) }, panelLevel), await art(40))).toBe(true);
  });

  it("recognizes opaque art reaching the neighbouring panel", async () => {
    expect(await absent(scene(image), await art(75))).toBe(false);
  });

  it("does not mistake a clip target list for visible art", async () => {
    expect(await absent(scene({ ...image, clip: { to: ["a", "b"] } }), await art(40))).toBe(true);
  });

  it("does not count pixels outside the element crop", async () => {
    expect(await absent(scene({ ...image, size: ["40mm", "80mm"], fit: "cover" }), await art(100))).toBe(true);
  });

  it("does not count transparent art or low alpha", async () => {
    for (const alpha of [0, 100]) expect(await absent(scene(image), await art(100, alpha))).toBe(true);
  });

  it("requires more than a stray coarse alpha cell", async () => {
    const data = await sharp({ create: { width: 80, height: 64, channels: 4, background: "transparent" } })
      .composite([{ input: Buffer.from([0, 0, 0, 255]), raw: { width: 1, height: 1, channels: 4 }, left: 60, top: 30 }]).png().toBuffer();
    expect(await absent(scene(image), data)).toBe(true);
  });

  it("checks the panel polygon rather than its bounding box", async () => {
    const doc = scene({ ...image, size: ["4mm", "4mm"], at: ["55mm", "0mm"] });
    Object.assign(doc.pages[0].panels[1], { shape: { kind: "ellipse" } });
    expect(await absent(doc, await art(100))).toBe(true);
  });

  it("does not assume a panel-level image is visible in its owner", async () => {
    const doc = scene({ ...image, at: ["60mm", "0mm"], size: ["30mm", "80mm"] }, true);
    doc.pages[0].panels[0].layers.push({ balloon: "Hello", who: "hero", id: "speech", at: ["50%", "30%"] });
    doc.pages[0].panels[1].layers = [];
    expect(await absent(doc, await art(100))).toBe(true);
  });

  it.each([true, false])("falls back to the placeholder visible box: reaches = %s", async (reaches) => {
    const doc = scene({ ...image, image: undefined, placeholder: "Hero", character: "hero", size: [reaches ? "100mm" : "40mm", "80mm"] });
    expect(await absent(doc)).toBe(!reaches);
  });
});
