# sample — 作例の漫画「三十一戦目」

mangacli の作例として、生成 AI（Sogni）で描いた絵に mangacli で吹き出し・写植・効果を載せた 4 ページの漫画です。

- `manga.yaml` — 原稿（コマ割り・セリフ・効果）
- `shonen-proof.yaml` — 同じ絵を使った少年誌向けの原稿見本。斜めのコマ割りで最後の裁ち切りへ視線を誘導し、アンチゴチ・ゴシック・明朝で声を区別する。
- `art/` — コマの絵（`art/prompts.json` の指示で Sogni の Relaxed ネットワークの `qwen_image_2512_lightning` で生成。文字・吹き出しなしで描かせ、候補から選んでいる。`p1-1` は `qwen_image_edit_2511_lightning_8bit` で絵の中の枠を消している）
- `chars/` — キャラクターの設定画（同じく Sogni で生成）
- `refs/` — 吹き出しの参考に Sogni で生成した、吹き出し付きの漫画のページ
- `out/` — 描画結果
- `tools/` — 生成用のスクリプト（`npm install` で Sogni の SDK を入れる）
- `NOTES.md` — 吹き出しのデザインの修正と、画像生成 AI の絵を mangacli で使うときのコツの記録

```bash
cd sample/tools && npm install && cd ../..
(while :; do node sample/tools/daemon.mjs; sleep 5; done) &   # Relaxed で生成を流し続ける（環境変数 SOGNI_API_KEY・SOGNI_APP_ID が必要）
node sample/tools/enqueue.mjs sample/art/prompts.json     # 足りない絵をジョブとして積む（--n 3 で候補を 3 枚ずつ）
npx mangacli render sample/manga.yaml -p print-mono
npx mangacli render sample/shonen-proof.yaml -p print-mono --crop marks
```

原稿見本のトンボ・文字・コマ線は 600 dpi で出力されますが、流用したコマ絵には 300 ppi を下回るものがあります。入稿用には高解像度の原画に差し替えてください。

同じ `SOGNI_APP_ID` の接続は 1 本までなので、デーモンは 1 つだけ動かす。
