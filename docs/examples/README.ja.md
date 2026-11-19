[English](README.md) | 日本語

# サンプル

| ファイル | 内容 | 使う機能の優先度 |
|---|---|---|
| [span-figure.yaml](span-figure.yaml) | 3 コマをまたぐ人物、和集合クリップ、上辺の開放、枠線の下の絵、顔を避ける吹き出し（[出力](../images/span-figure.png)） | P0・P1 |
| [aside.yaml](aside.yaml) | 顔の横に置く小さな手書きのセリフ。白フチと短い引き出し線（[描画結果](../images/aside.png)） | P1 |
| [minimal.yaml](minimal.yaml) | 最小の例。既定値（B5・モノクロ・右綴じ・縦書き・`ink`・フォントセット `manga-basic`）で 1 ページ | P0 のみ |
| [b5-mono.yaml](b5-mono.yaml) | B5 判モノクロの放課後の場面 2 ページ。斜めの間白、裁ち切り、混植、ルビ、心の声、描き文字、トンボ付き出力 | P0・P1 |
| [sns-color-yonkoma.yaml](sns-color-yonkoma.yaml) | SNS 投稿用のカラー 4 コマ（1080 × 1350 px）。px 単位、色・グラデーションの塗り、4 コマのテンプレート | P0・P1 |
| [color-page.yaml](color-page.yaml) | B5 のカラー 1 ページ。グラデーションの地、背景の乗算、雨、波に沿った描き文字、色付きの集中線・ウニフラッシュ、照れの漫符 | P0・P1 |
| [gallery-balloons.yaml](gallery-balloons.yaml) | 組み込みの吹き出しのスタイル（`as`）の一覧 | P0・P1 |
| [gallery-effects.yaml](gallery-effects.yaml) | 効果・トーン・漫符・描き文字の一覧 | P0・P1 |
| [light-effects.yaml](light-effects.yaml) | 黒ベタの上の後光、人物の背後の光線、舞台のスポットライト（カラー・1 ビット） | P1 |
| [aura.yaml](aura.yaml) | 透明な人物画像の輪郭に沿う闘気と短い放電 | P1 |
| [en-comic.yaml](en-comic.yaml) | 英語のページ（`lang: en`）。左から右へ読む順、`comic-basic` フォントセットの大文字の横書きの吹き出し、行の均等化 | P0・P1 |
| [full-page-art.yaml](full-page-art.yaml) | 間白や枠なしゴマから塗り足しまでの絵が見えるぶち抜きゴマ。小ゴマに白い抜き縁を付ける（[出力画像](../images/full-page-art.png)） | P1 |

- フォントはカタログのものを使うため、初回のレンダリング時に自動でダウンロードする。事前に取得する場合は `npx mangacli fonts install --for docs/examples/b5-mono.yaml` を実行する。
- B5・最小例・カラーの作例には Sogni で生成した同じ絵柄の素材（`assets/school/`）を使用しています。B5 と最小例の作画は掲載寸法で 300 ppi 以上、入稿用プロファイルの文字・コマ線は 600 dpi です。
- ぶち抜きゴマの作例にも Sogni で生成したイラストを使用しています。ほかの作例の仮の絵は `scripts/make-sample-assets.ts` で生成しています。自分の絵に差し替えて使えます。
- 描画結果は [../images](../images) にある。

```bash
npx mangacli render docs/examples/b5-mono.yaml                 # ドキュメントの output の設定で出力
npx mangacli render docs/examples/b5-mono.yaml -p print-mono   # 入稿用の 600 dpi・2 値
npx mangacli render docs/examples/b5-mono.yaml --draft         # 高速な下描き。素材がなければプレースホルダー
```
