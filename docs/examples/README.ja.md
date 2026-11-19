[English](README.md) | 日本語

# サンプル

| ファイル | 内容 | 使う機能の優先度 |
|---|---|---|
| [aside.yaml](aside.yaml) | 顔の横に置く小さな手書きのセリフ。白フチと短い引き出し線（[描画結果](../images/aside.png)） | P1 |
| [minimal.yaml](minimal.yaml) | 最小の例。既定値（B5・モノクロ・右綴じ・縦書き・`ink`・フォントセット `manga-basic`）で 1 ページ | P0 のみ |
| [b5-mono.yaml](b5-mono.yaml) | B5 判モノクロの同人誌原稿 2 ページ。断ち切り、斜めの間白、分割木、カタログのフォントによる混植、ルビ・傍点、各種の吹き出し・効果・トーン、描き文字、漫符、セリフの省略記法、連結、はみ出し、コマをまたぐ吹き出し、入稿用プロファイル | P0・P1 |
| [sns-color-yonkoma.yaml](sns-color-yonkoma.yaml) | SNS 投稿用のカラー 4 コマ（1080 × 1350 px）。px 単位、色・グラデーションの塗り、4 コマのテンプレート | P0・P1 |
| [color-page.yaml](color-page.yaml) | B5 のカラー 1 ページ。グラデーションの地、背景の乗算、雨、波に沿った描き文字、色付きの集中線・ウニフラッシュ、照れの漫符 | P0・P1 |
| [gallery-balloons.yaml](gallery-balloons.yaml) | 組み込みの吹き出しのスタイル（`as`）の一覧 | P0・P1 |
| [gallery-effects.yaml](gallery-effects.yaml) | 効果・トーン・漫符・描き文字の一覧 | P0・P1 |
| [light-effects.yaml](light-effects.yaml) | 黒ベタの上の後光、人物の背後の光線、舞台のスポットライト（カラー・1 ビット） | P1 |
| [en-comic.yaml](en-comic.yaml) | 英語のページ（`lang: en`）。左から右へ読む順、`comic-basic` フォントセットの大文字の横書きの吹き出し、行の均等化 | P0・P1 |

- フォントはカタログのものを使うため、初回のレンダリング時に自動でダウンロードする。事前に取得する場合は `npx mangacli fonts install --for docs/examples/b5-mono.yaml` を実行する。
- `assets/` の画像は、`scripts/make-sample-assets.ts` で生成した簡単な仮の絵（本プロジェクトと同じ MIT）。自分の絵に差し替えて使う。
- 描画結果は [../images](../images) にある。

```bash
npx mangacli render docs/examples/b5-mono.yaml                 # ドキュメントの output の設定で出力
npx mangacli render docs/examples/b5-mono.yaml -p print-mono   # 入稿用の 600 dpi・2 値
npx mangacli render docs/examples/b5-mono.yaml --draft         # 高速な下描き。素材がなければプレースホルダー
```
