import { describe, expect, it } from "vitest";
import { parseMarkup } from "../src/text/markup.js";
import { noEnd, noStart, phraseBoundaries } from "../src/text/linebreak.js";

const chars = (s: string, vertical = true) =>
  parseMarkup(s, { vertical }).units.flatMap((u) => (u.kind === "char" ? [u] : []));

describe("markup", () => {
  it("parses explicit and implicit ruby", () => {
    const p = parseMarkup("｜東京《とうきょう》と漢字《かんじ》", { vertical: true });
    expect(p.rubies.map((r) => r.text)).toEqual(["とうきょう", "かんじ"]);
    expect(p.units.filter((u) => u.kind === "char" && u.ruby === 1).length).toBe(2);
  });
  it("marks emphasis dots", () => {
    const u = chars("《《大事》》な");
    expect(u.map((x) => !!x.emph)).toEqual([true, true, false]);
  });
  it("normalizes ellipsis and dashes", () => {
    const s = chars("えっ...そんな—").map((u) => u.ch).join("");
    expect(s).toBe("えっ…そんな――");
  });
  it("keeps !? runs for tate-chu-yoko and converts lone marks", () => {
    expect(chars("本当!?").map((u) => u.ch).join("")).toBe("本当!?");
    expect(chars("本当!").map((u) => u.ch).join("")).toBe("本当！");
  });
  it("reports unbalanced markup", () => {
    expect(parseMarkup("《《閉じない", { vertical: true }).errors[0]?.code).toBe("TEXT_MARKUP_UNBALANCED");
    expect(parseMarkup("<foo>x</foo>", { vertical: true }).errors[0]?.code).toBe("TEXT_UNKNOWN_TAG");
  });
  it("supports escapes", () => {
    expect(chars("\\《文字\\》").map((u) => u.ch).join("")).toBe("《文字》");
  });
});

describe("line breaking", () => {
  it("applies kinsoku", () => {
    expect(noStart("、", "strict")).toBe(true);
    expect(noStart("っ", "strict")).toBe(true);
    expect(noStart("っ", "loose")).toBe(false);
    expect(noEnd("「", "strict")).toBe(true);
  });
  it("finds phrase boundaries", () => {
    const b = phraseBoundaries("今日はいい天気ですね");
    expect(b.has(0)).toBe(true);
    expect(b.size).toBeGreaterThan(1);
  });
});
