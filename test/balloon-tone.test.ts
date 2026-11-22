import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";

function document(background: string, fill: string, as = "narration") {
  return { yaml: `mangacli: 1
seed: 42
page: { size: [80mm, 60mm], bleed: 0mm }
pages:
  - panels:
      - background: ${background}
        layers:
          - balloon: READ ME
            as: ${as}
            writing: horizontal
            at: [50%, 50%]
            size: [48mm, 24mm]
            fill: ${fill}
            hand: clean
            halo: none
` };
}

async function interior(background: string, fill: string, as = "narration", profile = "print-mono") {
  const result = await render(document(background, fill, as), { profile, dpi: 254, crop: "trim" });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return sharp(result.pages[0].data).extract({ left: 300, top: 270, width: 200, height: 60 }).greyscale().raw().toBuffer();
}

describe("balloon tone knockout", () => {
  it.each(["narration", "say", "think"])("keeps %s tone and text independent of the art beneath", async (as) => {
    const paper = await interior("white", "tone(20%)", as);
    expect(await interior("tone(65%)", "tone(20%)", as)).toEqual(paper);
    expect(await interior("black", "tone(20%)", as)).toEqual(paper);
    expect(paper.some((v) => v === 0)).toBe(true);
    expect(paper.some((v) => v === 255)).toBe(true);
    expect([...new Set(paper)].sort()).toEqual([0, 255]);
    const text = await interior("white", "paper", as);
    for (let i = 0; i < text.length; i++) if (text[i] === 0) expect(paper[i]).toBe(0);
  });

  it.each(["tone(0%)", "'#dddddd'"])("also knocks out art for %s", async (fill) => {
    expect(await interior("black", fill)).toEqual(await interior("white", fill));
  });

  it("leaves an explicitly absent fill transparent", async () => {
    expect(await interior("black", "none")).not.toEqual(await interior("white", "none"));
  });

  it("retains flat preview rendering", async () => {
    expect(await interior("tone(65%)", "tone(20%)", "narration", "preview"))
      .toEqual(await interior("white", "tone(20%)", "narration", "preview"));
  });
});
