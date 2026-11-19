import sharp from "sharp";
import { hash2 } from "../../src/core/random.js";

export const backgrounds = ["black", "tone", "photo"] as const;
export type Background = typeof backgrounds[number];

export async function photoLike(): Promise<Buffer> {
  const width = 400;
  const height = 500;
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const noise = (hash2(7107, x, y) / 0xffffffff - 0.5) * 58;
    const hills = Math.sin(x / 37 + Math.sin(y / 61)) * 32 + Math.cos(y / 43) * 20;
    pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(45 + x / width * 125 + hills + noise)));
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

export function outlineFixture(background: Background) {
  return {
    mangacli: 1,
    seed: 7107,
    page: { size: ["80mm", "100mm"], bleed: 0, baseFrame: "trim", safeArea: { inset: 0 } },
    defaults: {
      text: { writing: "horizontal", fontSize: "5mm", outline: "auto" },
      sfx: { writing: "horizontal", fontSize: "7mm", lettering: "font", perChar: { rotate: ["0deg", "0deg"] }, distort: { roughen: 0, warp: 0 }, hand: false },
      monologue: { writing: "horizontal", fontSize: "5mm", shape: "none", tail: "none", textOutline: "auto" },
      balloon: { hand: false, stroke: "0.3mm black", halo: "0.8mm white", shape: { kind: "ellipse", irregularity: 0 } },
    },
    pages: [{ id: background, number: false, panels: [{
      border: "none",
      background: background === "tone" ? { tone: { density: "60%", lpi: 35, angle: "45deg" } } : "black",
      layers: [
        ...(background === "photo" ? [{ image: "photo", size: ["80mm", "100mm"], at: ["40mm", "50mm"], fit: "fill" }] : []),
        { text: "白フチ 固定", id: "fixed", at: ["40mm", "10mm"], outline: "0.8mm white" },
        { text: "白フチ 自動", id: "adaptive", at: ["40mm", "25mm"] },
        { sfx: "ドドドザザッ", id: "dakuten", at: ["40mm", "43mm"], outline: [{ width: "1.4mm", color: "black", join: "miter" }, { width: "0.8mm", color: "white", fillHoles: "0.6mm" }] },
        { sfx: "ドドド", id: "auto-sfx", at: ["40mm", "58mm"], fontSize: "5mm", outline: "auto" },
        { balloon: "地のセリフ", id: "monologue", as: "monologue", at: ["40mm", "71mm"] },
        ...["wedge", "bubbles", "line"].map((kind, i) => ({ balloon: "", id: `halo-${kind}`, at: [`${14 + i * 26}mm`, "85mm"], size: ["18mm", "10mm"], tail: { kind, direction: "60deg", length: "9mm", bend: 0, width: "2mm", bubbleSize: "2mm" } })),
      ],
    }] }],
  };
}
