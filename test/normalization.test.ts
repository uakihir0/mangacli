import { describe, expect, it } from "vitest";
import { createRenderer, resolve } from "../src/api.js";
import { DiagnosticBag } from "../src/core/diagnostics.js";
import { normDefaults, normElementProps, normalizeDocument } from "../src/load/normalize.js";
import { resolveDocument } from "../src/model/resolve.js";
import { BUILTIN_DEFAULTS } from "../src/model/defaults.js";

type Obj = Record<string, unknown>;
const document = (layers: Obj[]) => ({ mangacli: 1, page: { size: ["60mm", "50mm"], bleed: 0 }, pages: [{ panels: [{ layers }] }] });

describe("context-sensitive property normalization", () => {
  it.each(["named", "speech", "inherited"])("normalizes same-name style layers before overlaying (%s)", async (mode) => {
    const name = mode === "speech" ? "say" : "bubble";
    const layer = mode === "speech" ? { balloon: "A", as: "say" } : { balloon: "A", style: mode === "inherited" ? "child" : name };
    const doc = {
      ...document([layer]),
      styles: { [name]: { shape: { kind: "ellipse", tilt: ["12deg", "12deg"], irregularity: 0.7 } }, child: { extends: name } },
      locales: { ja: { styles: { [name]: { shape: "cloud" } } } },
    };
    const config = { styles: { [name]: { shape: { kind: "rect", lobes: 9 } } } };
    const shape = resolve(doc, { config }).pages[0].panels[0].elements[0].props.shape;
    expect(shape).toMatchObject({ kind: "cloud", tilt: ["12deg", "12deg"], irregularity: 0.7, lobes: 9 });
    expect((await createRenderer({ config, profile: "preview", dpi: 36 }).render(doc)).failures).toEqual([]);
    const reset = { ...doc, locales: { ja: { styles: { [name]: { shape: null } } } } };
    expect(resolve(reset, { config }).pages[0].panels[0].elements[0].props.shape).toEqual(BUILTIN_DEFAULTS.balloon.shape);
  });

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

  it("normalizes contextual styles before inheritance and property merging", () => {
    const doc = {
      ...document([{ sfx: "A", style: "thin" }, { balloon: "A", style: "round" }]),
      defaults: { sfx: { edge: { width: "1mm", color: "red" } } },
      styles: { thin: { edge: "0.4mm" }, irregular: { shape: { kind: "ellipse", irregularity: 0.4 } }, round: { extends: "irregular", shape: "round-rect" } },
    };
    const elements = resolve(doc).pages[0].panels[0].elements;
    expect(elements[0].props.edge).toEqual({ width: "0.4mm", color: "red" });
    expect(elements[1].props.shape).toMatchObject({ kind: "round-rect", irregularity: 0.4 });
  });
});

describe("null resets", () => {
  it("leaves null shorthand properties and null default roles untouched", () => {
    const props = Object.fromEntries(["stroke", "edge", "outline", "textOutline", "halo", "hand", "pen", "shape", "tail", "tails", "padding", "size", "lettering"].map((key) => [key, null]));
    const bag = new DiagnosticBag();
    for (const type of [undefined, "balloon", "sfx", "effect", "fill"]) expect(normElementProps(props, [], bag, type)).toEqual(props);
    expect(normElementProps({}, [], bag)).toEqual({});
    expect(normDefaults({ effect: null, mark: null, balloon: props }, [], bag)).toEqual({ effect: null, mark: null, balloon: props });
    expect(bag.items).toEqual([]);
  });

  it.each(["element", "document", "include", "locale", "config", "config-defaults", "character", "voice", "dialogue"])("resets padding from %s instead of creating null lengths", (source) => {
    const balloon: Obj = { balloon: "A" };
    const doc: Obj = document([balloon]);
    const panel: Obj = (doc.pages as { panels: Obj[] }[])[0].panels[0];
    const page = (doc.pages as Obj[])[0];
    const props = { padding: null };
    const config: Obj = {};
    if (source === "element") Object.assign(balloon, props);
    if (["document", "locale", "config"].includes(source)) balloon.style = "reset";
    if (source === "document") doc.styles = { reset: props };
    if (source === "locale") doc.locales = { ja: { styles: { reset: props } } };
    if (source === "include") Object.defineProperty(page, "__includeDefaults", { value: { balloon: props } });
    if (source === "config") config.styles = { reset: props };
    if (source === "config-defaults") config.defaults = { balloon: props };
    if (source === "character" || source === "voice") {
      balloon.who = "speaker";
      doc.characters = { speaker: source === "character" ? { balloon: props } : { voice: { say: props } } };
    }
    if (source === "dialogue") { delete panel.layers; panel.dialogue = [{ text: "A", ...props }]; }
    const bag = new DiagnosticBag();
    const resolved = resolveDocument(normalizeDocument(doc, bag), bag, { configStyles: config.styles as Record<string, Obj>, configDefaults: config.defaults as Obj });
    expect(resolved.pages[0].panels[0].elements[0].props.padding).toEqual(BUILTIN_DEFAULTS.balloon.padding);
    expect(bag.items.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("renders a config padding reset using the builtin lengths", async () => {
    const doc = { ...document([{ balloon: "A", style: "reset" }]), defaults: { balloon: { padding: "5mm" } } };
    const r = createRenderer({ profile: "preview", dpi: 36, config: { styles: { reset: { padding: null } } } });
    const result = await r.render(doc);
    expect(result.failures).toEqual([]);
    expect(result.pages).toHaveLength(1);
  });
});
