[English](README.md) | 日本語

# mangacli

mangacli は、漫画の構造を記述したデータから、日本の漫画のページを描画するツールです。コマ割り、吹き出し、セリフ、効果を YAML（または同じ構造の TypeScript オブジェクト）で書くと、完成したページの画像を白黒またはカラーで出力します。

キャラクターや背景などの絵は、画像ファイルとして用意します。それ以外のもの（コマの枠線、吹き出し、写植、描き文字、集中線などの効果線、スクリーントーン、漫符）は mangacli が描きます。どれも**ペンで描いたように**描きます。吹き出しはわずかに揺らぎ、線は筆圧で太さが変わって入り抜きがあり、閉じた輪郭はぴったりとは閉じません。

<p align="center">
  <img src="docs/images/b5-mono-1.png" width="45%" alt="mangacli で描画した B5 の白黒のページ">
  <img src="docs/images/sns-color-yonkoma.jpg" width="40%" alt="mangacli で描画した SNS 向けのカラーの 4 コマ">
</p>

ほかの作例: [カラーの 1 ページ](docs/images/color-page.png)、[吹き出しの一覧](docs/images/gallery-balloons.png)、[効果と描き文字の一覧](docs/images/gallery-effects.png)、[B5 の作例の 2 ページ目](docs/images/b5-mono-2.png)、[英語の左開きのページ](docs/images/en-comic.png)。

白黒の作例には [屋上を舞台にした 4 ページの漫画](sample/) の作画を使っています。ほかの作例には仮の絵を使うものもあります。コマ、吹き出し、写植、追加の効果やトーンは mangacli が描いています。元のファイルは [docs/examples](docs/examples/README.ja.md) にあります。

## 機能

- 日本の漫画の慣習を既定にする: 右から左の読み順、縦書き、アンチゴチ、ルビ、傍点、縦中横、禁則処理、間白、断ち切り、ノンブル。
- さまざまな吹き出し: 楕円、思考の雲、叫びのトゲ、絶叫のギザギザ、震え、小声（破線）、ナレーションの四角、電子音、反転、連結。しっぽは話者の口に向き、顔の手前で止まる。画面外の話者のしっぽは枠で切る。吹き出しは本文に合わせて大きさを決め、読み順に沿って、顔や人物を避けて自動で配置する。
- 効果: 集中線、ベタフラッシュ、ウニフラッシュ、流線、縦線、回転流線、雨、ハッチング、カケアミ、衝撃、ぼかし枠、スクリーントーン（網点・万線・砂目・グラデーション）。
- 描き文字（文字ごとの回転・拡大・歪み・荒らし・縁取り）と、汗・怒りマーク・キラキラ・ハートなどの漫符。
- 出力: PNG・JPEG・WebP・AVIF・TIFF・SVG・PDF（仕上がり・塗り足しの枠付き）。トンボも付けられる。カラー、グレースケール、印刷用の 2 値（既定は B5・600 dpi）。塗り足しと分版にも対応する。
- 決定的: 同じ入力からは常に同じ出力になる。シードを変えると「描き直した」別の線になる。
- 和文フォントは、同梱のカタログ（SIL OFL のフォント。版を固定し、ハッシュで検証する）から必要なときに取得するため、フォントを用意しなくても描画できる。
- 診断は YAML の行と列を示し、ヒントを添える。
- プラグインで拡張できる（吹き出しの形状、効果、漫符、ペン、コマ割りのテンプレート、判型、スタイル、処理のフック）。
- CLI（ライブプレビューのサーバー付き）と TypeScript API の両方を提供する。

## はじめかた

Node.js 24 以降が必要です。

```bash
npm install --save-dev mangacli
npx mangacli init my-manga        # manga.yaml と設定ファイルを作り、フォントを取得する
cd my-manga
npx mangacli render manga.yaml    # out/manga-001.png を書き出す
```

雛形は絵の代わりにプレースホルダーを使うため、そのまま描画できます。絵を `assets/` に置き、`image:` で指定してください。

## 書き方の例

```yaml
mangacli: 1

assets:
  taro: ./assets/taro.png

pages:
  - layout:
      rows: [[1], [1, 1]]
    panels:
      - layers:
          - image: taro
          - balloon: おはよう
      - layers:
          - balloon: |
              今日は
              いい天気だね
      - layers:
          - effect: focus-lines
          - text: その時——
            place: top-right
```

ファイルの先頭に `# yaml-language-server: $schema=./node_modules/mangacli/schema.json` を書くと、エディタで補完と検証が効きます。

## CLI

```bash
mangacli render <file> [-p print-mono|print-gray|print-color|web|sns|preview|draft] [-o out] [--pages 1-3]
mangacli validate <file> [--strict] [--reporter text|json|github]
mangacli watch <file>                  # 保存のたびに描き直す
mangacli preview <file> [--open]       # ブラウザでライブプレビュー（127.0.0.1:4173）
mangacli init [dir] [--template basic|b5-mono|sns-color|yonkoma]
mangacli fonts install [--set manga-basic] [--for manga.yaml] [--dir ./fonts]
mangacli fonts list [--catalog]
mangacli schema [--out schema.json]
mangacli transcript <file> [--format md|json|txt]
mangacli inspect <file> [--layout] [--resolved] [--page p1]
mangacli fonts verify | fonts licenses [file]
mangacli cache info | cache clean
```

すべてのオプションは `mangacli <command> --help` で確認できます。`--json` を付けると機械可読な NDJSON を出力します。

PDF/X で入稿する場合は、印刷所が指定する PDF/X の版と CMYK ICC プロファイルを使います。

```bash
mangacli render manga.yaml -p print-mono -f pdf --pdf-x 4 \
  --pdf-x-icc printer.icc --pdf-x-condition "印刷所指定の出力条件"
```

PDF/X-1a:2001 は `--pdf-x 1a`（ICC v2 のみ）を指定します。どちらも 1 ビットの白黒画像を黒版に保持します。オプションを省略した場合は従来の PDF 出力になります。入稿前に印刷所指定のプリフライトを実施してください。

## API

```ts
import { render } from "mangacli";

const result = await render("./manga.yaml", { profile: "print-mono", outDir: "./out" });
for (const d of result.diagnostics) console.warn(d.code, d.message);
```

`render` には YAML の文字列（`{ yaml }`）やドキュメントのオブジェクトも渡せます。`outDir` を省くと、符号化した画像を返します。詳しくは [docs/11-api.md](docs/11-api.md) を参照してください。

## ドキュメント

仕様書は [docs/](docs/README.ja.md) にあります。

## ライセンス

MIT。カタログのフォントは別に取得するもので、SIL Open Font License に従います。ライセンス文は各フォントの隣に保存します。
