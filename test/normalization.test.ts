import { describe, expect, it } from "vitest";
import { createRenderer, resolve } from "../src/api.js";

type Obj = Record<string, unknown>;
const document = (layers: Obj[]) => ({ mangacli: 1, page: { size: ["60mm", "50mm"], bleed: 0 }, pages: [{ panels: [{ layers }] }] });

describe("context-sensitive property normalization", () => {
  it.each(["element", "style", "config-style", "defaults", "config-defaults"])("keeps fill/effect edges and SFX strokes distinct in %s", async (source) => {
    const layers: Obj[] = [{ type: "fill", paint: "black" }, { effect: "hatching" }, { sfx: "A" }];
    const props = [{ edge: "soft" }, { edge: "clean" }, { edge: "0.4mm black" }];
    const defaults = { fill: props[0], effect: { hatching: props[1] }, sfx: props[2] };
    const styles = Object.fromEntries(props.map((p, i) => [`edge${i}`, p]));
    const doc: Obj = document(layers);
    const config: Obj = {};
    if (source === "element") layers.forEach((l, i) => Object.assign(l, props[i]));
    if (source.endsWith("style")) layers.forEach((l, i) => { l.style = `edge${i}`; });
    if (source === "style") doc.styles = styles;
    if (source === "config-style") config.styles = styles;
    if (source === "defaults") doc.defaults = defaults;
    if (source === "config-defaults") config.defaults = defaults;
    const elements = resolve(doc, { config }).pages[0].panels[0].elements;
    expect(elements.map((e) => e.props.edge)).toEqual(["soft", "clean", { width: "0.4mm", color: "black" }]);
    const r = createRenderer({ config, profile: "preview", dpi: 36 });
    expect((await r.validate(doc)).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const rendered = await r.render(doc);
    expect(rendered.failures).toEqual([]);
    expect(rendered.pages).toHaveLength(1);
  });

  it("preserves effect shapes while expanding balloon shapes after style resolution", async () => {
    const doc = { ...document([{ effect: "vignette", style: "oval" }, { balloon: "A", style: "oval" }]), styles: { oval: { shape: "ellipse" } } };
    const elements = resolve(doc).pages[0].panels[0].elements;
    expect(elements[0].props.shape).toBe("ellipse");
    expect(elements[1].props.shape).toMatchObject({ kind: "ellipse" });
    expect((await createRenderer({ profile: "preview", dpi: 36 }).render(doc)).failures).toEqual([]);
  });

  it("rejects an enum edge in an SFX stroke context", async () => {
    const r = createRenderer({ profile: "preview" });
    const result = await r.validate(document([{ sfx: "A", edge: "clean" }]));
    expect(result.diagnostics.some((d) => d.message.includes('invalid stroke token "clean"'))).toBe(true);
  });
});
