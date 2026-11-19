# sample — 作例の漫画「三十一戦目」

mangacli の作例として、生成 AI（Sogni）で描いた絵に mangacli で吹き出し・写植・効果を載せた 4 ページの漫画です。

- `manga.yaml` — 原稿（コマ割り・セリフ・効果）
- `effect-figure-clear.yaml` — 透明な人物画像の輪郭で集中線・曲がる流線を入り抜きし、不透明な一枚絵では集中線が消えないことを示す比較用作例。`art/effect-hero.png` は `scripts/make-sample-assets.ts` の CC0 テスト用人物画（`docs/examples/assets/taro/surprised.png` と同じ）
- `art/` — コマの絵（`art/prompts.json` の指示で Sogni の Relaxed ネットワークの `qwen_image_2512_lightning` で生成。文字・吹き出しなしで描かせ、候補から選んでいる。`p1-1` は `qwen_image_edit_2511_lightning_8bit` で絵の中の枠を消している）
- `chars/` — キャラクターの設定画（同じく Sogni で生成）
- `refs/` — 吹き出しの参考に Sogni で生成した、吹き出し付きの漫画のページ
- `out/` — 描画結果
- `tools/` — 生成用のスクリプト（`npm install` で Sogni の SDK を入れる）
- `NOTES.md` — 吹き出しのデザインの修正と、画像生成 AI の絵を mangacli で使うときのコツの記録

```bash
cd sample/tools && npm install && cd ../..
(while :; do node sample/tools/daemon.mjs; sleep 5; done) &   # Relaxed で生成を流し続ける（接続が切れたら繋ぎ直す）（sample/.env に SOGNI_API_KEY・SOGNI_APP_ID）
node sample/tools/enqueue.mjs sample/art/prompts.json     # 足りない絵をジョブとして積む（--n 3 で候補を 3 枚ずつ）
npx mangacli render sample/manga.yaml -p print-mono
npx mangacli render sample/effect-figure-clear.yaml -p preview
```

同じ `SOGNI_APP_ID` の接続は 1 本までなので、デーモンは 1 つだけ動かす。
