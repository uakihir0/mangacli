import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { YamlText, flow, offsetOf } from "../src/cli/yaml-edit.js";

const SRC = `pages:
  - layout:
      rows: [[1], [1, 1]]   # comment
    panels:
      - layers:
          - image: taro   # art
          - balloon: おはよう
            who: taro
          - { balloon: やあ, at: [10%, 20%] }
          - balloon: |
              今日は
              いい天気
            tail:
              to: taro.mouth
      - dialogue:
          - こんにちは
`;
const at = (line: number, column: number) => offsetOf(SRC, line, column);
const edit = (f: (y: YamlText) => void) => {
  const y = new YamlText(SRC);
  f(y);
  return y.text;
};

describe("yaml-edit", () => {
  it("adds a key to a block mapping, keeping the comments", () => {
    const out = edit((y) => y.set(at(7, 13), ["at"], ["30%", "12.5mm"]));
    expect(out).toContain("            who: taro\n            at: [30%, 12.5mm]\n");
    expect(out).toContain("rows: [[1], [1, 1]]   # comment");
    expect(out).toContain("- image: taro   # art");
  });

  it("changes a value in a flow mapping in place", () => {
    const out = edit((y) => {
      y.set(at(9, 13), ["at"], ["1%", "2%"]);
      y.set(at(9, 13), ["size"], ["30mm", "auto"]);
    });
    expect(out).toContain("- { balloon: やあ, at: [1%, 2%], size: [30mm, auto] }");
  });

  it("edits nested keys of a block mapping and removes keys", () => {
    const out = edit((y) => {
      y.set(at(10, 13), ["tail", "length"], "5mm");
      y.delete(at(10, 13), ["tail", "to"]);
    });
    expect(out).toContain("            tail:\n              length: 5mm\n");
    expect(out).not.toContain("taro.mouth");
  });

  it("wraps a scalar line into a mapping", () => {
    const out = edit((y) => y.set(at(16, 13), ["at"], ["1%", "2%"], { rootWrap: "text" }));
    expect(out).toContain("- { text: こんにちは, at: [1%, 2%] }");
  });

  it("writes multi-line text as a literal block", () => {
    const out = edit((y) => y.set(at(7, 13), ["balloon"], "二行\nです"));
    expect(out).toContain("          - balloon: |\n              二行\n              です\n            who: taro");
  });

  it("inserts and removes list items", () => {
    const added = edit((y) => y.insert(at(5, 9), ["layers"], Infinity, { balloon: "新しい", at: ["50%", "50%"] }));
    expect(parse(added).pages[0].panels[0].layers[4]).toEqual({ balloon: "新しい", at: ["50%", "50%"] });
    const removed = edit((y) => y.delete(at(2, 5), ["panels", 1]));
    expect(parse(removed).pages[0].panels).toHaveLength(1);
  });

  it("replaces a block value with block YAML", () => {
    const out = edit((y) => y.set(at(2, 5), ["layout"], { split: "rows", children: ["panel", { split: "cols", children: ["panel", "panel"] }] }));
    expect(parse(out).pages[0].layout).toEqual({ split: "rows", children: ["panel", { split: "cols", children: ["panel", "panel"] }] });
    expect(out).toContain("  - layout:\n      split: rows\n");
  });

  it("writes plain scalars only when they read back the same", () => {
    expect(flow(["30%", "-4deg", "true", "a: b", "1.5"])).toBe('[30%, -4deg, "true", "a: b", "1.5"]');
    expect(flow({ to: "taro.mouth", length: 3 })).toBe("{ to: taro.mouth, length: 3 }");
  });
});
