import { describe, expect, it } from "vitest";
import { render, validate } from "../src/api.js";
import { Contour, definePlugin, z } from "../src/plugin.js";

const kit = definePlugin({
  name: "test-kit",
  balloonShapes: {
    "kit/diamond": {
      params: z.object({ kind: z.string(), pinch: z.number().default(0.5) }),
      outline: (_ctx, p, size) => Contour.polygon([[0, -0.5], [0.5 * (p.pinch as number), 0], [0, 0.5], [-0.5 * (p.pinch as number), 0]]).scale(size),
    },
  },
  effects: {
    "kit/cross": {
      draw(ctx) {
        const b = ctx.bounds;
        ctx.line([{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]);
        ctx.line([{ x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }]);
      },
    },
    "kit/hearts-rain": {
      params: z.object({ count: z.number().int().default(12) }).passthrough(),
      generate(ctx, params) {
        const nodes = [];
        for (let i = 0; i < (params.count as number); i++) nodes.push(...ctx.marks.draw("heart", { at: ctx.randomPointIn(ctx.region), size: ctx.rng.range(2, 5) }));
        return nodes;
      },
    },
  },
  marks: {
    "kit/dot": { draw: (ctx) => ctx.shape(Contour.ellipse(ctx.size / 3, ctx.size / 3).translate(ctx.center.x, ctx.center.y).points, "black") },
  },
  pens: { "kit/fat": { pressure: 0 } },
  pageSizes: { "kit-square": { width: 100, height: 100 } },
  layoutTemplates: { "kit/two": () => ({ rows: [{ cols: [1, 1] }] }) },
  styles: { "kit-loud": { shape: { kind: "spike" }, fontScale: 1.4 } },
});

const doc = `mangacli: 1
page: { size: kit-square, bleed: 0 }
pages:
  - layout: { template: kit/two }
    panels:
      - layers:
          - effect: kit/cross
          - effect: kit/hearts-rain
          - mark: kit/dot
          - { balloon: ひし形, shape: { kind: kit/diamond, pinch: 0.8 } }
      - layers:
          - { balloon: うおお, as: kit-loud }
`;

describe("plugins", () => {
  it("registers shapes, effects, marks, templates, page sizes and styles", async () => {
    const v = await validate({ yaml: doc, filename: "/v/t.yaml" }, { plugins: [kit] });
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(v.layout[0].panels.length).toBe(2);
    expect(v.layout[0].geom.trimW).toBe(100);
    const r = await render({ yaml: doc, filename: "/v/t.yaml" }, { plugins: [kit], profile: "preview" });
    expect(r.pages.length).toBe(1);
  });
  it("rejects name conflicts", async () => {
    const bad = definePlugin({ name: "bad", effects: { "focus-lines": { draw: () => {} } } });
    const v = await validate({ yaml: "mangacli: 1\npages: [{}]\n", filename: "/v/t.yaml" }, { plugins: [bad] });
    expect(v.diagnostics.some((d) => d.code === "PLUGIN_NAME_CONFLICT")).toBe(true);
  });
  it("fails on unknown kinds without the plugin", async () => {
    const v = await validate({ yaml: doc, filename: "/v/t.yaml" });
    expect(v.ok).toBe(false);
  });
});
