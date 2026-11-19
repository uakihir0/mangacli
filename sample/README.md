# sample — 作例の漫画「三十一戦目」

mangacli の作例として、生成 AI（Sogni）で描いた絵に mangacli で吹き出し・写植・効果を載せた 4 ページの漫画です。

- `manga.yaml` — 原稿（コマ割り・セリフ・効果）
- `shonen-proof.yaml` — 同じ絵を使った少年誌向けの原稿見本。斜めのコマ割りで最後の裁ち切りへ視線を誘導し、アンチゴチ・ゴシック・明朝で声を区別する。
- `art/` — コマの絵。Sogni の Fast ネットワークで FLUX 3 Image Klein を使い、`art/print-prompts.json` の指示と設定画から生成。元のピクセル寸法のままグレースケールに変換しています。
- `chars/` — キャラクターの設定画（同じく Sogni で生成）
- `refs/` — 吹き出しの参考に Sogni で生成した、吹き出し付きの漫画のページ
- `out/` — 描画結果
- `tools/` — 生成用のスクリプト（`npm install` で Sogni の SDK を入れる）
- `NOTES.md` — 吹き出しのデザインの修正と、画像生成 AI の絵を mangacli で使うときのコツの記録

```bash
cd sample/tools && npm install && cd ../..
(while :; do SOGNI_NETWORK=fast node sample/tools/daemon.mjs; sleep 5; done) &   # SOGNI_API_KEY・SOGNI_APP_ID が必要
node sample/tools/enqueue.mjs sample/art/print-prompts.json    # 足りない絵を積む（--n 3 で候補を 3 枚ずつ）
npx mangacli render sample/manga.yaml -p print-mono
npx mangacli render sample/shonen-proof.yaml -p print-mono --crop marks
```

原稿は 600 dpi で出力され、コマ絵は掲載寸法で 300 ppi 以上です。線画の目標は 600 ppi ですが、生成時の上限（長辺 4096 px、参照画像付きの場合は約 4 メガピクセル）により、すべてのコマが 600 ppi に達するわけではありません。拡大補間はしていません。

同じ `SOGNI_APP_ID` の接続は 1 本までなので、デーモンは 1 つだけ動かす。
