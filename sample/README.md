# sample — 作例の漫画「三十一戦目」

mangacli の作例として、生成 AI（Sogni）で描いた絵に mangacli で吹き出し・写植・効果を載せた 4 ページの漫画です。

- `manga.yaml` — 原稿（コマ割り・セリフ・効果）
- `art/` — コマの絵（`art/prompts.json` の指示で Sogni の Relaxed ネットワークの `qwen_image_2512_lightning` で生成。文字・吹き出しなしで描かせ、候補から選んでいる。`p1-1` は `qwen_image_edit_2511_lightning_8bit` で絵の中の枠を消している）
- `chars/` — キャラクターの設定画（同じく Sogni で生成）
- `refs/` — 吹き出しの参考に Sogni で生成した、吹き出し付きの漫画のページ
- `out/` — 描画結果
- `tools/` — 生成用のスクリプト（`npm install` で Sogni の SDK を入れる）
- `NOTES.md` — 吹き出しのデザインの修正と、画像生成 AI の絵を mangacli で使うときのコツの記録

```bash
cd sample/tools && npm install && cd ../..
(while :; do node sample/tools/daemon.mjs; sleep 5; done) &   # Relaxed で生成を流し続ける（接続が切れたら繋ぎ直す）
node sample/tools/enqueue.mjs sample/art/prompts.json     # 足りない絵をジョブとして積む（--n 3 で候補を 3 枚ずつ）
npx mangacli render sample/manga.yaml -p print-mono
```

`SOGNI_API_KEY` と `SOGNI_APP_ID` は環境変数または `sample/.env` に設定する（環境変数を優先）。同じ `SOGNI_APP_ID` の接続は 1 本までなので、デーモンは 1 つだけ動かす。

新しい作品を作る場合は [漫画制作スキル](../.agents/skills/manga-production/SKILL.md) も参照。

完了イベントを取り逃した場合、デーモンは Sogni に結果を再照会する。これは同じ生成ジョブの画像を回収する処理で、再生成はしない。
