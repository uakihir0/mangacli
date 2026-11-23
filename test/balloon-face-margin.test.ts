import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "../src/api.js";
import type { Rect } from "../src/geom/vec.js";

const doc = (balloon: string) => ({
  filename: join(import.meta.dirname, "../docs/examples/face-margin-test.yaml"),
  yaml: `mangacli: 1
page: { size: [140mm, 85mm], bleed: 0, baseFrame: trim }
characters: { taro: {} }
assets:
  taro: { src: ./assets/taro/normal.png, character: taro, anchors: { mouth: [500, 530] }, regions: { face: [280, 140, 440, 480] } }
pages:
  - panels:
      - layers:
          - { image: taro, id: figure, fit: contain, size: [40mm, 60mm], at: [70mm, 45mm], anchor: center }
          - ${balloon}
`,
});
const gap = (a: Rect, b: Rect) => Math.hypot(Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h)));

async function scene(balloon: string) {
  const r = await render(doc(balloon), { layoutOnly: true });
  const page = r.layout[0];
  const figure = page.elements.find(e => e.id === "figure")!.bbox;
  const scale = Math.min(figure.w / 1000, figure.h / 1400);
  const face = { x: figure.x + (figure.w - 1000 * scale) / 2 + 280 * scale, y: figure.y + (figure.h - 1400 * scale) / 2 + 140 * scale, w: 440 * scale, h: 480 * scale };
  return { face, balloon: page.elements.find(e => e.id === "say")!.bbox, near: r.diagnostics.filter(d => d.code === "BALLOON_NEAR_FACE") };
}

describe("face margin", () => {
  it("keeps auto-placed balloon bodies max(3 bmm, 20% of the face width) away from faces", async () => {
    const s = await scene("{ balloon: おれの名前を呼ぶな, id: say, who: taro, tail: none, autoPlace: { weights: { avoid: 0, figure: 0, speaker: 40 } } }");
    expect(s.near).toEqual([]);
    expect(gap(s.balloon, s.face)).toBeGreaterThanOrEqual(Math.max(3, s.face.w * 0.2) - 0.05);
  });

  it("warns about an explicit position within the margin, naming the balloon and the distance", async () => {
    const s = await scene("{ balloon: おれの名前を呼ぶな, id: say, who: taro, at: [70mm, 30mm] }");
    expect(s.near).toHaveLength(1);
    expect(s.near[0]).toMatchObject({ severity: "warning", elementId: "say" });
    expect(s.near[0].message).toMatch(/say .*figure.* \d+\.\d mm/);
  });

  it("counts a body crossing the face as a band as overlapping", async () => {
    const s = await scene("{ balloon: あ, id: say, tail: none, shape: rect, size: [40mm, 5mm], at: [70mm, 32mm], anchor: center }");
    expect(s.balloon.w).toBeGreaterThan(s.face.w);
    expect(s.balloon.h).toBeLessThan(s.face.h);
    expect(s.near).toHaveLength(1);
    expect(s.near[0].message).toMatch(/overlaps the face/);
  });

  it("measures a custom faceMargin and can be turned off", async () => {
    const at = (m: string) => `{ balloon: あ, id: say, tail: none, size: [10mm, 10mm], at: [47mm, 45mm], faceMargin: ${m} }`;
    const base = await scene(at("none"));
    expect(base.near).toEqual([]);
    const d = gap(base.balloon, base.face);
    expect(d).toBeGreaterThan(1);
    expect((await scene(at(`${(d + 1).toFixed(1)}mm`))).near).toHaveLength(1);
    expect((await scene(at(`${(d - 1).toFixed(1)}mm`))).near).toEqual([]);
    expect((await scene(at((d + 1).toFixed(1)))).near).toHaveLength(1);
  });
});
