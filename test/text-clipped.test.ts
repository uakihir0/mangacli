import { expect, it } from "vitest";
import { createRenderer } from "../src/api.js";

const renderer = createRenderer({ profile: "preview", strict: true });

const input = (layers: string, panel = "", layout = "") => ({
  yaml: `mangacli: 1
meta: {lang: en}
page: {size: [100mm, 100mm], bleed: 0mm}
book: {readingDirection: ltr}
pages:
  - id: page-one
    ${layout}
    panels:
      - id: first
        ${panel}
        layers:
          ${layers}
${layout ? "      - id: second" : ""}
`,
});

const frameWarnings = (result: Awaited<ReturnType<typeof renderer.validate>>) =>
  result.diagnostics.filter((d) => d.code === "TEXT_CLIPPED");

it("warns only when lettering crosses a colSlant edge", async () => {
  const doc = (x: string) => input(
    `- {balloon: O, id: bubble, clip: panel, tail: none, writing: horizontal, fontSize: 5mm, size: [24mm, 12mm], at: [${x}, 25%]}`,
    "",
    "layout: {rows: [{cols: [1, 1], colSlant: [24mm]}]}",
  );
  const intact = await renderer.validate(doc("26mm"));
  expect(frameWarnings(intact)).toEqual([]);
  expect(intact.ok).toBe(true);
  const clipped = await renderer.validate(doc("34mm"));
  expect(frameWarnings(clipped)).toEqual([expect.objectContaining({
    elementId: "bubble", pageId: "page-one", message: "bubble: 「O」 is cut by the panel frame",
  })]);
  expect(clipped.ok).toBe(false);
});

it("keeps rectangular panel warnings for cut glyphs, not text padding", async () => {
  const doc = (at: string, clip = "panel") => input(
    `- {text: O, id: label, clip: ${clip}, writing: horizontal, fontSize: 5mm, size: [20mm, 12mm], at: [${at}, 50%]}`,
  );
  expect(frameWarnings(await renderer.validate(doc("4mm")))).toEqual([]);
  expect(frameWarnings(await renderer.validate(doc("1mm")))).toEqual([expect.objectContaining({
    elementId: "label", message: "label: 「O」 is cut by the panel frame",
  })]);
  expect(frameWarnings(await renderer.validate(doc("1mm", "none")))).toEqual([]);
});

it("names the ruby glyph clipped after its parent group is transformed", async () => {
  const doc = input(`- type: group
            size: [20mm, 20mm]
            at: [1mm, 50%]
            anchor: center
            rotate: 90deg
            children:
              - {text: "<ruby=R>I</ruby>", id: label, writing: horizontal, fontSize: 8mm, at: [50%, 50%], rotate: 180deg}`);
  expect(frameWarnings(await renderer.validate(doc))).toEqual([expect.objectContaining({
    elementId: "label", message: "label: 「R」 is cut by the panel frame",
  })]);
});

it("does not warn for parts of a grouped glyph already hidden by a hard mask", async () => {
  const doc = (maskX: string) => input(`- type: group
            mask: {rect: [${maskX}, 0mm, 100%, 100%]}
            children:
              - {text: O, id: label, writing: horizontal, fontSize: 5mm, at: [1mm, 50%]}`);
  expect(frameWarnings(await renderer.validate(doc("-3mm")))).toHaveLength(1);
  expect(frameWarnings(await renderer.validate(doc("0mm")))).toEqual([]);
});

it("attributes a clipped connected balloon glyph to the balloon that owns it", async () => {
  const doc = input(`- {balloon: A, id: first-part, clip: panel, tail: none, writing: horizontal, fontSize: 5mm, at: [8mm, 50%]}
          - {balloon: O, id: second-part, clip: panel, tail: none, writing: horizontal, fontSize: 5mm, at: [0mm, 60%], connect: {to: first-part, style: line}}`);
  expect(frameWarnings(await renderer.validate(doc))).toEqual([expect.objectContaining({
    elementId: "second-part", message: "second-part: 「O」 is cut by the panel frame",
  })]);
});
