// Finishing passes on the rendered raster (spec 9.12, 10.14).
import sharp from "sharp";
import { parseColor } from "../core/color.js";
import { fbm1, noise2 } from "../core/random.js";
import type { DiagnosticBag } from "../core/diagnostics.js";

type Obj = Record<string, unknown>;

export interface Finish {
  inkBleed?: number;
  inkTexture?: number;
  paper?: "none" | "grain" | { strength?: number };
  paperColor?: string;
}

export async function applyFinish(
  img: { data: Uint8ClampedArray; width: number; height: number },
  finish: Finish,
  o: { dpi: number; colorMode: "color" | "gray" | "mono"; seed: number; bag: DiagnosticBag },
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const { width: w, height: h } = img;
  let data = img.data;
  const pxPerMm = o.dpi / 25.4;
  if (finish.inkBleed && finish.inkBleed > 0) {
    // soften corners, then restore the ink level
    const sigma = Math.max(0.3, finish.inkBleed * 0.04 * pxPerMm * 2);
    const out = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: w, height: h, channels: 4 } }).blur(sigma).raw().toBuffer();
    data = new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = data[i + c] / 255;
        data[i + c] = o.colorMode === "mono" ? (v < 0.5 ? 0 : 255) : Math.round(Math.max(0, Math.min(1, (v - 0.12) / 0.76)) * 255);
      }
    }
  }
  if (o.colorMode === "mono") {
    const ignored = (["inkTexture", "paper", "paperColor"] as const).filter((k) => finish[k] !== undefined && finish[k] !== "none" && finish[k] !== 0);
    if (ignored.length) o.bag.warn("OUTPUT_FINISH_IGNORED", `finish ${ignored.join(", ")} is ignored for 1-bit output`);
    return { data, width: w, height: h };
  }
  const tex = finish.inkTexture ?? 0;
  const grain = finish.paper === "grain" ? 1 : typeof finish.paper === "object" ? ((finish.paper as Obj).strength as number) ?? 1 : 0;
  const pc = finish.paperColor ? parseColor(finish.paperColor) : null;
  if (!tex && !grain && !pc) return { data, width: w, height: h };
  const inkScale = 1 / (1.2 * pxPerMm); // ink density varies over ~1 mm
  const grainScale = 1 / (0.12 * pxPerMm); // paper fibres ~0.1 mm
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      let lift = 0;
      if (tex && lum < 0.6) lift = tex * 0.18 * (0.5 + 0.5 * noise2(o.seed, x * inkScale, y * inkScale)) * (1 - lum);
      const g = grain ? 1 - grain * 0.05 * (0.5 + 0.5 * noise2(o.seed ^ 0x77, x * grainScale, y * grainScale)) - grain * 0.015 * fbm1(o.seed, y * grainScale * 0.1) : 1;
      for (let c = 0; c < 3; c++) {
        let v = data[i + c] / 255;
        v = v + (1 - v) * lift;
        v *= g;
        if (pc) v *= c === 0 ? pc.r : c === 1 ? pc.g : pc.b;
        data[i + c] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
    }
  }
  return { data, width: w, height: h };
}
