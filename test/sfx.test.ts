import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/api.js";
import { BUILTIN_DEFAULTS } from "../src/model/defaults.js";
import { sfxScale, sfxShifts } from "../src/text/sfx.js";

const renderer = createRenderer({ profile: "preview" });
const input = (extra = "", text = "バンッ") => ({ yaml: `mangacli: 1
page: { size: B5 }
pages:
  - panels: []
    layers:
      - { sfx: "${text}", id: sfx, at: [50%, 50%], fontSize: 10mm, ${extra} }
`, filename: "/v/sfx.yaml" });

describe("SFX lettering", () => {
  it("ramps from 85% to 115%, with a neutral singleton", () => {
    expect([0, 1, 2].map(i => sfxScale(i, 3, "ド"))).toEqual([0.85, 1, 1.15]);
    expect(sfxScale(0, 1, "ド")).toBe(1);
    expect(sfxScale(2, 3, "ド", 0)).toBe(1);
    expect(sfxScale(2, 3, "ド", 0.2)).toBe(1.4);
  });
  it.each(Array.from("ッっャュョゃゅょァィゥェォヵヶ"))("shrinks small kana %s", char => {
    expect(sfxScale(0, 1, char)).toBe(0.65);
    expect(sfxScale(0, 1, char, undefined, 1)).toBe(1);
  });
  it("packs scaled glyphs with overlapping negative tracking", () => {
    expect(BUILTIN_DEFAULTS.sfx.letterSpacing).toBe("-0.22em");
    const scales = [0.85, 1, 1.15];
    const shift = sfxShifts(scales, 10);
    for (let i = 1; i < scales.length; i++) {
      const distance = 7.8 + shift[i] - shift[i - 1];
      expect(distance).toBeLessThan((scales[i] + scales[i - 1]) * 5);
    }
    expect(sfxShifts([], 10)).toEqual([]);
  });
  it("reproduces seeded jitter and permits disabling it", async () => {
    const render = async (extra = "") => (await renderer.render(input(extra), { format: "svg" })).pages[0].data;
    const a = await render();
    expect(await render()).toEqual(a);
    expect(await render('perChar: { rotate: 0deg }')).not.toEqual(a);
  });
  it("scales the default white outline with font size and accepts overrides", async () => {
    const svg = async (extra: string) => Buffer.from((await renderer.render(input(extra), { format: "svg" })).pages[0].data).toString();
    expect(await svg("")).toContain('stroke-width="1.4"');
    const large = input();
    large.yaml = large.yaml.replace("fontSize: 10mm", "fontSize: 20mm");
    expect(Buffer.from((await renderer.render(large, { format: "svg" })).pages[0].data).toString()).toContain('stroke-width="2.8"');
    expect(await svg('outline: [{ width: 2mm, color: white }]')).toContain('stroke-width="4"');
    expect(await svg('outline: none')).not.toContain('stroke-width="1.4"');
  });
  it("renders empty SFX without errors", async () => {
    const result = await renderer.render(input("", ""), { format: "svg" });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  });
  it("rejects invalid small-kana scales", async () => {
    const result = await renderer.validate(input("smallKanaScale: -1"));
    expect(result.ok).toBe(false);
  });
});
