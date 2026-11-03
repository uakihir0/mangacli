[English](README.md) | 日本語

# サンプル

| ファイル | 内容 | 使う機能の優先度 |
|---|---|---|
| [minimal.yaml](minimal.yaml) | 最小の例。既定値（B5・モノクロ・右綴じ・縦書き・`ink`・フォントセット `manga-basic`）で 1 ページ | P0 のみ |
| [b5-mono.yaml](b5-mono.yaml) | B5 判モノクロの同人誌原稿 2 ページ。断ち切り、斜めの間白、分割木、カタログのフォントによる混植、ルビ・傍点、各種の吹き出し・効果・トーン、描き文字、漫符、セリフの省略記法、連結、はみ出し、コマをまたぐ吹き出し、入稿用プロファイル | P0・P1 |
| [sns-color-yonkoma.yaml](sns-color-yonkoma.yaml) | SNS 投稿用のカラー 4 コマ（1080 × 1350 px）。px 単位、色・グラデーションの塗り、4 コマのテンプレート | P0・P1 |

- フォントはカタログのものを使うため、初回のレンダリング時に自動でダウンロードする。事前に取得する場合は `npx mangacli fonts install --for docs/examples/b5-mono.yaml` を実行する。
- サンプルが参照する素材のファイルは、リポジトリには含めない。実装時に、再配布できるライセンスの素材を `docs/examples/assets/` に用意する。
- 素材がない状態でも、ドラフトモードで構成を確認できる。

```bash
npx mangacli render docs/examples/b5-mono.yaml --draft
```
