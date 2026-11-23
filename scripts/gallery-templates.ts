import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { render } from "../src/api.js";

const names = ["impact-diagonal", "cascade", "zoom-in", "splash-with-insets", "vertical-strip", "spread-hero", "dominant-panel"];
const counts = [2, 4, 4, 3, 3, 9, 5];
const out = process.env.TEMPLATE_OUTPUT ?? `${process.env.HOME}/mangacli-gallery`;
mkdirSync(out, { recursive: true });
const pages = names.map((name, i) => ({
  id: name,
  ...(name === "spread-hero" ? { type: "spread" } : {}),
  layout: name === "dominant-panel" ? { rows: [{ cols: [1, 1], slant: "-8mm" }, { height: 2, slant: "8mm" }, { cols: [1, 1] }] } : { template: name, params: { seed: 42 } },
  panels: Array.from({ length: counts[i] }, (_, j) => ({
    ...(name === "dominant-panel" && j === 2 ? { dominant: { overlap: "9mm" } } : {}),
    background: ["#d8e5ed", "#f3dcc5", "#e5e8d1", "#e8d8e6"][j % 4],
    border: { width: "0.6mm", ruler: true },
    layers: [{ text: String(j + 1), at: ["50%", "50%"], fontSize: "18pt" }],
  })),
}));
const result = await render({ mangacli: 1, page: { size: "B5" }, pages }, { profile: "preview", format: "png", width: 540, outDir: out, name: "{id}", crop: "bleed" });
if (result.diagnostics.some((d) => d.severity === "error")) throw new Error(JSON.stringify(result.diagnostics));
const cards = await Promise.all(names.map(async (name) => {
  const page = await sharp(`${out}/${name}.png`).resize(440, 570, { fit: "contain", background: "white" }).png().toBuffer();
  const label = Buffer.from(`<svg width="480" height="50"><rect width="480" height="50" fill="white"/><text x="240" y="32" text-anchor="middle" font-family="sans-serif" font-size="23">${name}</text></svg>`);
  return sharp({ create: { width: 480, height: 640, channels: 4, background: "white" } }).composite([{ input: label, top: 0, left: 0 }, { input: page, top: 55, left: 20 }]).png().toBuffer();
}));
await sharp({ create: { width: 1440, height: Math.ceil(cards.length / 3) * 640, channels: 4, background: "white" } }).composite(cards.map((input, i) => ({ input, left: (i % 3) * 480, top: Math.floor(i / 3) * 640 }))).png().toFile("docs/images/gallery-templates.png");
await sharp("docs/images/gallery-templates.png").toFile(`${out}/gallery.png`);
console.log(`Gallery: docs/images/gallery-templates.png; individual renders: ${out}`);
