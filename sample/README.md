# sample — 作例の漫画「三十一戦目」

mangacli の作例として、生成 AI（Sogni）で描いた絵に mangacli で吹き出し・写植・効果を載せた 4 ページの漫画です。

- `manga.yaml` — 原稿（コマ割り・セリフ・効果）
- `shonen-proof.yaml` — 同じ絵を使った少年誌向けの原稿見本。斜めのコマ割りで最後の裁ち切りへ視線を誘導し、アンチゴチ・ゴシック・明朝で声を区別する。
- `effect-figure-clear.yaml` — 透明な人物画像の輪郭で集中線・水平な流線を入り抜きし、不透明な一枚絵では集中線が消えないことを示す比較用作例。`art/effect-hero.png` は `scripts/make-sample-assets.ts` の CC0 テスト用人物画（`docs/examples/assets/taro/surprised.png` と同じ）
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
npx mangacli render sample/effect-figure-clear.yaml -p preview
```

原稿は 600 dpi で出力され、コマ絵は掲載寸法で 300 ppi 以上です。線画の目標は 600 ppi ですが、生成時の上限（長辺 4096 px、参照画像付きの場合は約 4 メガピクセル）により、すべてのコマが 600 ppi に達するわけではありません。拡大補間はしていません。

`SOGNI_API_KEY` と `SOGNI_APP_ID` は環境変数に設定する。同じ `SOGNI_APP_ID` の接続は 1 本までなので、デーモンは 1 つだけ動かす。

新しい作品を作る場合は [漫画制作スキル](../.agents/skills/manga-production/SKILL.md) も参照。

完了イベントを取り逃した場合、デーモンは Sogni に結果を再照会する。これは同じ生成ジョブの画像を回収する処理で、再生成はしない。
