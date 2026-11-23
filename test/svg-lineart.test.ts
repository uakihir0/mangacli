import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { render } from "../src/api.js";

// 1 px black/white columns: any downsampling turns them into flat gray
async function stripes(size: number): Promise<Buffer> {
  const px = Buffer.alloc(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px[y * size + x] = x % 2 ? 255 : 0;
  return sharp(px, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
}

const doc = (kind: string) => `mangacli: 1
page: { size: [60mm, 60mm], bleed: 0mm, color: mono }
assets:
  art: { src: art.png, kind: ${kind} }
pages:
  - layers:
      - { image: art, size: [25.4mm, 25.4mm], at: [10mm, 10mm], anchor: top-left, smoothing: none }
`;

async function embedded(kind: string, dpi: number, format: "svg" | ["svg", "png"] = "svg") {
  const r = await render({ yaml: doc(kind) }, { profile: "print-mono", dpi, format, assets: { art: await stripes(600) } });
  const page = r.pages.find((p) => p.format === "svg")!;
  const svg = Buffer.from(page.data).toString("utf8");
  const b64 = svg.match(/<image[^>]*href="data:image\/png;base64,([^"]+)"/)![1];
  const { data, info } = await sharp(Buffer.from(b64, "base64")).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, values: [...new Set(data)].sort((a, b) => a - b), r };
}

describe("SVG embedded line art", () => {
  it("keeps 600 ppi binary line art at full resolution and 1-bit", async () => {
    const e = await embedded("lineart", 600);
    expect([e.width, e.height]).toEqual([600, 600]);
    expect(e.values).toEqual([0, 255]);
  });

  it("does not exceed the source resolution", async () => {
    const e = await embedded("lineart", 1200);
    expect([e.width, e.height]).toEqual([600, 600]);
  });

  it("thresholds line art downsampled below its source resolution", async () => {
    const e = await embedded("lineart", 400);
    expect([e.width, e.height]).toEqual([400, 400]);
    expect(e.values).toEqual([0, 255]);
  });

  it("still caps general images at 300 ppi", async () => {
    const e = await embedded("art", 600);
    expect([e.width, e.height]).toEqual([300, 300]);
  });

  it("accounts for image scale when adapting the manga screen ruling", async () => {
    const art = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#888888" } }).png().toBuffer();
    const yaml = `mangacli: 1
page: { size: [100mm, 100mm], bleed: 0mm, color: mono }
assets:
  art: { src: art.png }
pages:
  - layers:
      - { image: art, size: [25.4mm, 25.4mm], at: [5mm, 5mm], anchor: top-left, scale: 2, filters: [manga] }
`;
    const embeddedSize = async (scale: number) => {
      const r = await render({ yaml: yaml.replace("scale: 2,", `scale: ${scale},`) }, { profile: "print-mono", dpi: 96, format: "svg", assets: { art } });
      const svg = Buffer.from(r.pages[0].data).toString("utf8");
      const b64 = svg.match(/<image[^>]*href="data:image\/png;base64,([^"]+)"/)![1];
      const meta = await sharp(Buffer.from(b64, "base64")).metadata();
      return [meta.width, meta.height];
    };
    expect(await embeddedSize(2)).toEqual([360, 360]);
    expect(await embeddedSize(4)).toEqual([384, 384]);
  });

  it("leaves the raster output's line art intact when rendered together", async () => {
    const { r } = await embedded("lineart", 600, ["svg", "png"]);
    const png = r.pages.find((p) => p.format === "png")!;
    const x0 = Math.round((10 * 600) / 25.4);
    const { data } = await sharp(Buffer.from(png.data)).extract({ left: x0, top: x0, width: 600, height: 600 }).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    expect([...new Set(data)].sort((a, b) => a - b)).toEqual([0, 255]);
    let ink = 0;
    for (let x = 0; x < 600; x++) if (data[300 * 600 + x] === 0) ink++;
    expect(ink).toBe(300);
  });
});
