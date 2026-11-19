import { describe, expect, it } from "vitest";
import { load } from "../src/api.js";
import { FontRegistry } from "../src/fonts/registry.js";
import { resolveDocument } from "../src/model/resolve.js";

const reg = new FontRegistry(new Map() as never, "manga-basic", [], {});

describe("title lettering", () => {
  it("sets titles in square-cut extra-bold gothic, not a rounded face", async () => {
    const text = "朝をひとつ";
    await reg.prepare("title", text);
    const keys = [...text].map((ch) => reg.pick("title", ch.codePointAt(0)!)?.font.key ?? "");
    // an installed Gothic MB101 U / Shin Go U wins; otherwise Noto Sans JP Black
    for (const k of keys) expect(k === "cat:noto-sans-jp@900" || !k.startsWith("cat:")).toBe(true);
  });

  it.each([
    ["thick-white", "white", "black"],
    ["thick-black", "black", "white"],
  ])("expands outline: %s into a thick rim edged with the other colour", (name, rim, edge) => {
    const { doc, bag } = load({
      filename: "/virtual/title.yaml",
      yaml: `mangacli: 1
pages:
  - panels:
      - layers:
          - { sfx: "朝をひとつ", font: title, outline: ${name} }
`,
    });
    const props = resolveDocument(doc, bag).pages[0].panels[0].elements[0].props;
    expect(bag.items.filter((d) => d.severity === "error")).toEqual([]);
    expect(props.outline).toEqual([
      { width: "1.4mm", color: rim, join: "miter" },
      { width: "1.9mm", color: edge, join: "miter" },
    ]);
  });
});
