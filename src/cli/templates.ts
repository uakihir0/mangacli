// `mangacli init` templates (spec 12.3.3).

const HEADER = "# yaml-language-server: $schema=./node_modules/mangacli/schema.json\n";

export const TEMPLATES: Record<string, string> = {
  basic: `${HEADER}
mangacli: 1
engine: 1

meta:
  title: はじめての漫画
  lang: ja

page:
  size: B5
  color: mono

pages:
  - id: p1
    layout:
      rows:
        - { cols: [1], height: 1 }
        - { cols: [3, 2], height: 1.2 }
    panels:
      - layers:
          - image: assets/background.png
            placeholder: 背景・教室
          - balloon: その日の放課後——
            as: narration
            place: top-right
      - layers:
          - image: assets/hero.png
            id: hero
            placeholder: 主人公・正面
            size: [auto, 90%]
            at: [50%, 100%]
            anchor: bottom
          - effect: focus-lines
            inner: [35%, 30%]
        dialogue:
          - { text: えっ、ほんとに！？, as: shout }
      - layers:
          - image: assets/friend.png
            placeholder: 友人・笑顔
        dialogue:
          - text: |
              うそだよ
              《《じょうだん》》
`,
  "b5-mono": `${HEADER}
mangacli: 1
engine: 1

meta:
  title: タイトル
  lang: ja

book:
  pageNumbers: { start: 1 }

page:
  size: B5
  color: mono
  bleed: 3mm

pages:
  - id: p1
    layout: { template: tiers, params: { counts: [1, 2, 2] } }
    panels:
      - bleed: [top, left, right]
        layers:
          - image: assets/bg.png
            placeholder: 背景
      - layers: [{ image: assets/a.png, placeholder: キャラA }]
        dialogue: [{ text: こんにちは }]
      - layers: [{ image: assets/b.png, placeholder: キャラB }]
        dialogue: [{ text: やあ }]
      - layers: [{ image: assets/c.png, placeholder: 寄り }]
      - layers: [{ image: assets/d.png, placeholder: 引き }]
`,
  "sns-color": `${HEADER}
mangacli: 1
engine: 1

meta:
  title: タイトル
  lang: ja

page:
  size: sns-portrait
  color: color
  background: "#fffaf2"

output:
  profile: sns

pages:
  - id: p1
    layout: { template: grid, params: { cols: 2, rows: 2 } }
    panels:
      - background: "linear-gradient(to bottom, #ffe9c7, #fff6e8)"
        layers: [{ image: assets/1.png, placeholder: 1 コマ目 }]
        dialogue: [{ text: おはよう }]
      - layers: [{ image: assets/2.png, placeholder: 2 コマ目 }]
      - layers: [{ image: assets/3.png, placeholder: 3 コマ目 }]
      - layers: [{ image: assets/4.png, placeholder: 4 コマ目 }]
`,
  yonkoma: `${HEADER}
mangacli: 1
engine: 1

meta:
  title: 4 コマのタイトル
  lang: ja

page:
  size: sns-portrait
  color: color
  background: "#fffaf2"

output:
  profile: sns

pages:
  - id: p1
    title: 4 コマのタイトル
    layout:
      template: yonkoma
      params: { title: true }
    panels:
      - layers: [{ image: assets/1.png, placeholder: 起 }]
        dialogue: [{ text: ある朝 }]
      - layers: [{ image: assets/2.png, placeholder: 承 }]
      - layers: [{ image: assets/3.png, placeholder: 転 }]
        dialogue: [{ text: えっ！？, as: shout }]
      - layers: [{ image: assets/4.png, placeholder: 結 }]
`,
};

export const CONFIG_TEMPLATE = `import { defineConfig } from "mangacli";

export default defineConfig({
  // fontSet: "manga-basic",
  // fonts: { dialogue: "./fonts/MyFont.ttf" },
  // missingAssets: "placeholder",
  output: {
    dir: "./out",
  },
});
`;

export const ASSETS_README = `# assets

Put the artwork (PNG / JPEG / WebP) referenced by \`manga.yaml\` here.
Images with a white background can use \`whiteToAlpha: true\`; line art and tones are best
supplied at the output resolution (600 dpi for mono print, 350 dpi for color print).
`;

export const FONTS_README = `# fonts

mangacli downloads the catalog fonts it needs (the \`manga-basic\` font set by default)
into the user cache on first use. To keep fonts inside the project instead:

    npx mangacli fonts install --dir ./fonts

and set \`fontDir: "./fonts"\` in \`mangacli.config.ts\`.

Your own fonts can be registered in the document:

    fonts:
      dialogue: ./fonts/MyFont.ttf

Check each font's license before distributing rendered images or the font files.
Catalog fonts are licensed under the SIL Open Font License; the license text is saved next to
each downloaded font.
`;
