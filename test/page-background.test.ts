import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";

const art = await sharp({ create: { width: 1060, height: 860, channels: 3, background: "black" } }).png().toBuffer();

function document(background: string, gutterFill = "") {
  return { yaml: `mangacli: 1
seed: 42
page:
  size: [100mm, 80mm]
  bleed: 3mm
  ${background}
assets:
  art: { src: art.png, kind: background }
pages:
  - ${gutterFill || "id: splash"}
    layout: { area: [10mm, 10mm, 80mm, 60mm], split: rows, gutter: 10mm, children: [panel, panel] }
    panels:
      - { id: reveal, background: none, border: none }
      - { id: inset, border: 1mm, knockout: 2mm }
` };
}

const options = { profile: "print-mono", dpi: 254, assets: { art } };
const underlay = "background: { image: art, fit: cover, bleed: all }";

async function pixels(png: Uint8Array) {
  const { data, info } = await sharp(png).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return (x: number, y: number) => data[Math.round((y + 3) * 10) * info.width + Math.round((x + 3) * 10)];
}

describe("full-page background images", () => {
  it("covers bleed, shows through the gutter and frameless panel, and renders a measured white knockout in 1-bit", async () => {
    const input = document(underlay, "gutterFill: none");
    const result = await render(input, options);
    const png = result.pages[0].data;
    expect(await sharp(png).metadata()).toMatchObject({ width: 1060, height: 860, bitsPerSample: 1 });
    const at = await pixels(png);
    expect(at(-2, -2)).toBe(0);
    expect(at(102, 82)).toBe(0);
    expect(at(50, 25)).toBe(0);
    expect(at(50, 40)).toBe(0);
    expect(at(50, 42.8)).toBe(0);
    expect(at(50, 43.2)).toBe(255);
    expect(at(50, 45)).toBe(0);
    expect(at(50, 50)).toBe(255);
    expect((await render(input, options)).pages[0].data).toEqual(png);
  });

  it.each(["", "gutterFill: paper"])("masks the layout gaps with paper (%s) without changing panel geometry or order", async (fill) => {
    const result = await render(document(underlay, fill), options);
    const at = await pixels(result.pages[0].data);
    expect(at(50, 40)).toBe(255);
    expect(at(50, 25)).toBe(0);
    expect(at(5, 40)).toBe(0);
    expect(at(-2, -2)).toBe(0);
    const plain = await render(document("background: paper", fill), { ...options, layoutOnly: true });
    expect(result.layout[0].panels).toEqual(plain.layout[0].panels);
  });

  it("clips the image at trim without bleed: all", async () => {
    const result = await render(document("background: { image: art, fit: cover }"), options);
    const at = await pixels(result.pages[0].data);
    expect(at(-2, 40)).toBe(255);
    expect(at(2, 40)).toBe(0);
  });

  it("leaves automatically positioned balloons and their reading order unchanged", async () => {
    const place = (background: string) => {
      const { yaml } = document(background, "gutterFill: none");
      return render({ yaml: yaml.replace(
        "      - { id: reveal, background: none, border: none }",
        `      - id: reveal
        background: none
        border: none
        layers:
          - { balloon: Look, id: look, writing: horizontal, tail: none }
          - { balloon: Up, id: up, writing: horizontal, tail: none }`,
      ) }, { ...options, layoutOnly: true });
    };
    const [artPage, paperPage] = await Promise.all([place(underlay), place("background: paper")]);
    expect(artPage.layout[0].elements.map((el) => el.id)).toEqual(["look", "up"]);
    expect(artPage.layout[0].elements).toEqual(paperPage.layout[0].elements);
    expect(artPage.layout[0].transcript).toEqual(paperPage.layout[0].transcript);
  });

  it("replaces the image and gutter mask when overriding the page ground", async () => {
    const result = await render(document(underlay), { ...options, background: "gray", colorMode: "color" });
    const at = await pixels(result.pages[0].data);
    expect(at(50, 25)).toBe(128);
    expect(at(50, 40)).toBe(128);
    expect(at(50, 50)).toBe(255);
  });
});
