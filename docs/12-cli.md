# 12. CLI

## 12.1 概要

```bash
npm install --save-dev mangacli
npx mangacli render manga.yaml
```

- コマンド名は `mangacli`。
- CLI は API の薄いラッパーであり、同じ処理を API から実行できる（[2.1](02-architecture.md#21-全体構成)）。
- 標準出力には結果（`--json` の場合は機械可読な出力、`--stdout` の場合は画像）、標準エラー出力には進捗と診断を出す。

## 12.2 共通オプション

| オプション | 説明 |
|---|---|
| `--config <path>` | 設定ファイルを指定する |
| `--no-config` | 設定ファイルを探さない |
| `--cwd <dir>` | 作業ディレクトリ |
| `--root <dir>` | プロジェクトルート（ファイル参照の上限） |
| `--log-level <level>` | `silent`、`error`、`warn`、`info`（既定）、`debug`、`trace` |
| `-q, --quiet` | `--log-level error` と同じ |
| `-v, --verbose` | `--log-level debug` と同じ |
| `--json` | 診断と結果を JSON（1 行 1 オブジェクトの NDJSON）で出力する |
| `--no-color` | 色付きの表示をしない（環境変数 `NO_COLOR` でも同じ） |
| `--locale <ja\|en>` | メッセージの言語。既定は環境変数 `MANGACLI_LOCALE`、`LANG` から判定し、日本語以外は英語 |
| `--version` | バージョンを表示する |
| `-h, --help` | ヘルプを表示する |

## 12.3 コマンド

| コマンド | 説明 | 優先度 |
|---|---|---|
| `render` | レンダリングして出力する | P0 |
| `validate` | 検証して診断を表示する | P0 |
| `init` | 新しいプロジェクトの雛形を作る | P0 |
| `watch` | ファイルの変更を監視して再レンダリングする | P0 |
| `schema` | JSON Schema を出力する | P0 |
| `preview` | ブラウザでライブプレビューする | P1 |
| `inspect` | 解決済みの値・レイアウト・組版の結果を表示する | P1 |
| `fonts` | カタログのフォントの取得（`install`）・一覧（P0）、字形の確認・ライセンスの書き出し（P1） | P0 / P1 |
| `transcript` | セリフ一覧を出力する | P1 |
| `migrate` | 旧バージョンのドキュメントを変換する | P1 |
| `cache` | キャッシュの情報表示・削除 | P1 |

### 12.3.1 render

```bash
mangacli render <file | -> [options]
```

| オプション | 説明 |
|---|---|
| `-o, --out <dir>` | 出力先。既定は `output.dir`、なければ `./out` |
| `-p, --profile <name>` | 出力プロファイル（[10.7](10-color-and-output.md#107-出力プロファイル)）。既定 `web` |
| `-f, --format <fmt[,fmt]>` | 出力形式 |
| `--pdf-x <1a\|4>` | 白黒二値 PDF の入稿用規格。PDF/X-1a:2001 または PDF/X-4。下の 2 オプションと併用 |
| `--pdf-x-icc <path>` | 印刷所指定の CMYK 出力プロファイル。1a は ICC v2、4 は ICC v2 または v4 |
| `--pdf-x-condition <name>` | 印刷所指定の出力条件名 |
| `--color <color\|gray\|mono>` | カラーモード |
| `--dpi <n>`、`--scale <n>`、`--width <px>`、`--height <px>` | 解像度・寸法（[10.5](10-color-and-output.md#105-解像度とサイズ)） |
| `--max-output-pixels <n>` | グレー・カラー・RGBA 互換経路の出力 1 ページの画素数上限（既定 200000000、分割見開きは片側ごと）。 |
| `--max-output-bytes <n>` | 不透明 mono 1-bit PNG/TIFF G4/PDF の推定メモリ予算（既定 402653184 bytes = 384 MiB）。B4 / 1200 dpi 分割はトンボ付きでも既定で出力可能。バンドと packed バッファを使い、画素数上限は適用しない。巨大画像・フィルターなどのノード作業領域も推定に含む。 |
| `--crop <trim\|bleed\|marks>` | 出力範囲 |
| `--pages <range>` | 出力するページ。数値は `pages` のリストでの順番（見開きも 1 つ、ノンブルではない）。例: `1-3,5`、`p7`（ID）、`3-`（3 番目以降） |
| `--lang <tag>` | 本文の言語（[7.16](07-text.md#716-多言語)） |
| `--seed <n>` | ドキュメントの `seed` の上書き（ページ・コマ・要素で明示したシードは変えない） |
| `--draft` | ドラフトモード（`sketch` の手描き、プレースホルダー） |
| `--debug [layers]` | デバッグオーバーレイ（[10.11](10-color-and-output.md#1011-デバッグ出力)） |
| `--tone <dots\|flat\|auto>` | トーンの描画 |
| `--spread <joined\|split>` | 見開きの出力 |
| `--separate [names]` | 分版出力。名前を省略するとすべて |
| `--emit <kinds>` | 付随出力（`layout`、`ir`、`transcript`、`manifest`） |
| `--name <template>` | ファイル名のテンプレート |
| `--contact-sheet` | 一覧画像も出力する |
| `--stdout` | 画像を標準出力に書く（出力が 1 ファイルの場合のみ） |
| `--base-dir <dir>` | 標準入力（`-`）から読む場合の相対パスの基準 |
| `--clean` | 出力の前に、出力先の同じテンプレートに一致するファイルを削除する |
| `--strict` | 警告をエラーとして扱う |
| `--concurrency <n>` | 並列数 |
| `--no-cache` | キャッシュを使わない |
| `--allow-network` | URL の素材の取得を許可する |
| `--no-download` | カタログのフォントを自動で取得しない（`fontDownload: never`）。手元にないフォントはエラー |
| `--timings` | 段階ごとの所要時間を表示する |

### 12.3.2 validate

```bash
mangacli validate <file> [--profile <name>] [--lang <tag>] [--strict] [--reporter <text|json|github>]
```

- スキーマ検証に加え、レイアウトまで実行して、本文のあふれや解像度不足などの診断も行う（画像は生成しない）。
- `--profile` を指定すると、そのプロファイルの解像度で解像度不足を判定する。
- `--reporter github` は GitHub Actions の注釈の形式で出力する。

### 12.3.3 init

```bash
mangacli init [dir] [--template <basic|b5-mono|sns-color|yonkoma>] [--no-fonts] [--force]
```

次のファイルを作る。既存のファイルは、`--force` がない限り上書きしない。

| ファイル | 内容 |
|---|---|
| `manga.yaml` | テンプレートのドキュメント。`yaml-language-server` の `$schema` の指定と、現在の `engine` の番号、ID を付けたページを含む |
| `mangacli.config.ts` | 設定ファイルの雛形。`"type": "module"` でないパッケージの中では `mangacli.config.mts` にする（Node.js が ES モジュールとして読み込めるように） |
| `assets/` | 素材の置き場所（説明の README を含む） |
| `fonts/README.md` | フォントの扱いの説明（カタログのフォントの自動取得、`fonts install --dir` でプロジェクトに置く方法、独自のフォントの登録、ライセンスの注意） |
| `.gitignore` | `out/` を追加する |

- 既定で、フォントセット `manga-basic` のフォントをユーザーのキャッシュに取得する（`mangacli fonts install --set manga-basic` と同じ）。`--no-fonts` で省略する。取得に失敗しても雛形は作り、警告を出す（初回のレンダリング時に再び取得を試みる）。

### 12.3.4 watch

```bash
mangacli watch <file> [render のオプション]
```

- エントリの YAML、インポート・インクルードしたファイル、素材、フォント、設定ファイルを監視する。
- 変更を検出したら 150 ms 待ってから（連続した保存をまとめて）再レンダリングする。
- 変更の影響を受けるページだけを再レンダリングする（ページ出力のキャッシュ、P1。P0 では全ページ）。
- 診断は再レンダリングのたびに表示し直す。エラーがあっても監視を続ける。

### 12.3.5 preview

（P1）

```bash
mangacli preview <file> [--port 4173] [--host 127.0.0.1] [--open] [--guides] [--profile preview]
```

- ローカルの HTTP サーバーを起動し、ブラウザでページを表示する。
- 表示: 一覧（見開きの並び）、1 ページ、見開き。
- 保存のたびに、変更したページを自動で更新する（Server-Sent Events）。
- 診断の一覧で要素に対応する警告をクリックすると、該当ページへスクロールし、画像上の要素を枠で強調する。再クリックまたは Esc で解除する。選択は自動再読み込み後も保たれ、ガイドの表示とは独立している。
- デバッグオーバーレイの項目、プロファイル（`preview` / `web`）、シードを画面上で切り替えられる。
- 画面上部の「ガイド」チェックで、断裁位置・塗り足しの外周・安全領域の線と見開きの中央の危険帯（デバッグオーバーレイの `guides`）を重ねて表示する。ガイド表示中は塗り足しまで含めて表示するので、紙の端が断裁位置か塗り足しの外側かを見分けられる（`--crop marks` のときはトンボ付きのまま）。警告が出る前に、要素を置く位置の目安にする。選択はブラウザに保存され、再読み込み後も保たれる。`--guides` で初期状態をオンにする。
- 既定で `127.0.0.1` にのみバインドする（[2.13](02-architecture.md#213-セキュリティ)）。

### 12.3.6 schema

```bash
mangacli schema [--out <file>] [--config <path>]
```

JSON Schema を出力する。設定ファイルのプラグインのパラメータを含める。

### 12.3.7 inspect

（P1）

```bash
mangacli inspect <file> [--page <ref>] [--element <id>] [--resolved] [--layout] [--text] [--json]
```

| オプション | 表示内容 |
|---|---|
| `--resolved` | 解決済みの値と、各値の由来（組み込みの既定値、`defaults`、スタイル名、要素自身、ファイル・行） |
| `--layout` | コマの多角形・読み順・テンプレートの展開結果、要素の外接矩形 |
| `--text` | 本文の正規化の結果、改行位置、縦中横・ルビの判定、使用フォント |

### 12.3.8 fonts

```bash
mangacli fonts install [ids...] [--set <name>] [--for <file>] [--all] [--dir <dir>] [--force]   # P0
mangacli fonts list [--catalog | --system | file]                                              # P0
mangacli fonts check <file>                                                                    # P1
mangacli fonts verify [--dir <dir>]                                                            # P1
mangacli fonts licenses [file] [-o <file>]                                                     # P1
```

| サブコマンド | 説明 |
|---|---|
| `install` | カタログのフォントを取得する（[7.3.10](07-text.md#7310-フォントのカタログと取得)）。対象は、指定した ID、`--set` のフォントセット（既定 `manga-basic`）、`--for` のドキュメントが実際に使うフォント、`--all`（カタログのすべて）のいずれか。`--dir` を指定すると、ユーザーのキャッシュではなくそのディレクトリに置く。取得済みのものは、`--force` がない限り取得し直さない |
| `list` | ドキュメントで登録したフォントとロールの対応、使うカタログのフォントと取得の状態を表示する。`--catalog` でカタログの一覧（ID、書体、太さ、大きさ、取得の状態）、`--system` でインストール済みフォントの名前・ファイル・フェイス番号を表示する |
| `check` | ドキュメントの字形の欠落を一覧する |
| `verify` | 取得済みのフォントのハッシュを検証する |
| `licenses` | 使用したフォントのライセンス文と著作権表示を一覧・書き出す |


### 12.3.9 transcript

（P1）

```bash
mangacli transcript <file> [--format <md|json|txt>] [--lang <tag>] [-o <file>]
```

セリフ一覧（[10.12](10-color-and-output.md#1012-付随出力)）を出力する。

### 12.3.10 migrate

（P1）

```bash
mangacli migrate <file> [--write]
```

旧バージョンのスキーマのドキュメントを現行のバージョンに変換する。`--write` がない場合は差分を表示するだけとする。

### 12.3.11 cache

（P1）

```bash
mangacli cache info
mangacli cache clean
```

## 12.4 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功（警告があっても成功。`--strict` の場合を除く） |
| 1 | 入力の誤り（検証のエラー、`--strict` での警告） |
| 2 | 処理の失敗（入出力、素材・フォントの読み込み、レンダリング） |
| 3 | 使い方の誤り（未知のオプション、不正な値） |
| 70 | 内部エラー |
| 130 | 中断（SIGINT） |

## 12.5 設定ファイル

### 12.5.1 探索

- `mangacli.config.ts`、`.mts`、`.js`、`.mjs`、`.json`、`.yaml` を、**エントリの YAML があるディレクトリ**から親ディレクトリへ向かって探す（標準入力から読む場合は作業ディレクトリから）。`package.json` があるディレクトリ、またはファイルシステムのルートで探索を止める。
- JavaScript・TypeScript の設定ファイルはコードとして実行される。信頼できないリポジトリのドキュメントをレンダリングする場合は `--no-config` を使う（[2.13](02-architecture.md#213-セキュリティ)）。
- TypeScript の設定ファイルは、Node.js の型の除去機能が使える場合はそれで読み込み、使えない場合は同梱の軽量なローダーで読み込む。
- `--config` で明示した場合は探索しない。`--no-config` で読み込まない。

### 12.5.2 内容

```ts
import { defineConfig } from "mangacli";
import myKit from "./plugins/my-kit.js";

export default defineConfig({
  root: ".",
  plugins: [myKit],
  fonts: {
    dialogue: "./fonts/ZenKakuGothicNew-Bold.ttf",
  },
  fontFallback: ["./fonts/NotoSansJP-Regular.ttf"],
  fontSet: "manga-basic",
  fontDownload: "auto",
  fontDir: "./fonts",
  assetPaths: ["./assets"],
  missingAssets: "error",
  allowNetwork: false,
  allowOutsideRoot: false,
  defaults: {
    balloon: { fontSize: "13Q" },
  },
  hand: { preset: "ink" },
  output: {
    dir: "./out",
    profile: "web",
    profiles: {
      doujin: { extends: "print-mono", crop: "marks" },
    },
  },
  diagnostics: {
    TEXT_NEAR_FOLD: "off",
    ASSET_LOW_RESOLUTION: "error",
  },
  concurrency: 4,
  cache: { dir: "node_modules/.cache/mangacli" },
  limits: { maxPages: 500 },
  locale: "ja",
});
```

| キー | 型 | 説明 |
|---|---|---|
| `root` | パス | プロジェクトルート |
| `plugins` | MangaPlugin[] | プラグイン |
| `fonts` | Map\<名前, FontDef\> | 全ドキュメント共通のフォントの登録。ドキュメントの `fonts` が優先する |
| `fontFallback` | (パス \| フォント名)[] | 全体のフォールバック（[7.3.5](07-text.md#735-フォールバック)） |
| `fontSet` | フォントセット名 \| `none` | ドキュメントに `fontSet` がない場合の既定（[7.3.10](07-text.md#7310-フォントのカタログと取得)） |
| `fontDownload` | `auto` \| `never` | カタログのフォントの自動取得 |
| `fontDir` | パス | プロジェクトのフォントの置き場所（ユーザーのキャッシュより先に探す） |
| `fontCacheDir` | パス | ユーザーのキャッシュの場所 |
| `fontMirror` | URL | 取得元の URL の接頭辞の置き換え |
| `assetPaths` | パス[] | 素材を名前で探すディレクトリ |
| `missingAssets` | `error` \| `placeholder` | 素材が見つからない場合の扱い（[5.12](05-elements-and-images.md#512-プレースホルダー)） |
| `allowNetwork` | 真偽値 \| `{ hosts, timeoutMs, maxBytes, allowPrivate }` | URL の素材の取得 |
| `allowOutsideRoot` | 真偽値 | ルート外のファイル参照 |
| `defaults` | Defaults | カスケードの段階 2（[3.8](03-document-format.md#38-スタイルと既定値のカスケード)） |
| `styles` | Map\<名前, Style\> | 共通のスタイル。ドキュメントの `styles` が優先する |
| `hand` | Hand | 手描き設定の既定値 |
| `output` | OutputSettings | 出力の既定値とプロファイル |
| `diagnostics` | Map\<コード, 重大度 \| `off`\> | 診断の重大度の変更（[13.4](13-validation.md#134-重大度の変更)） |
| `concurrency` | 整数 | 並列数 |
| `cache` | `{ dir, enabled }` | キャッシュ |
| `limits` | Limits | 入力の上限（[2.13](02-architecture.md#213-セキュリティ)） |
| `locale` | `ja` \| `en` | メッセージの言語 |

## 12.6 環境変数

| 変数 | 説明 |
|---|---|
| `MANGACLI_CONFIG` | 設定ファイルのパス |
| `MANGACLI_LOCALE` | メッセージの言語 |
| `MANGACLI_CACHE_DIR` | キャッシュの場所 |
| `MANGACLI_FONT_CACHE` | カタログのフォントのキャッシュの場所（`fontCacheDir`） |
| `MANGACLI_FONT_MIRROR` | フォントの取得元の置き換え（`fontMirror`） |
| `MANGACLI_NO_DOWNLOAD` | `1` のとき、フォントを自動で取得しない（`fontDownload: never`） |
| `MANGACLI_CONCURRENCY` | 並列数 |
| `NO_COLOR` | 色付きの表示をしない |
| `CI` | 設定されている場合、対話的な進捗表示（スピナーなど）をしない |
| `SOURCE_DATE_EPOCH` | 出力のメタデータに書く時刻（[2.9](02-architecture.md#29-決定性と再現性)） |

## 12.7 表示の例

```text
$ mangacli render manga.yaml --profile print-mono
✔ 読み込み  manga.yaml（12 ページ、素材 34、フォント 4）
⚠ TEXT_OVERFLOW  manga.yaml:48:11
  吹き出し p3-k2-balloon1 の本文が、文字サイズを 75 % まで縮小しても収まらないため、はみ出した部分を切りました。
    46 |       - balloon: |
    47 |           そんなことって
  > 48 |           あるわけないだろ
       |           ^^^^^^^^^^^^^^^^
    49 |         size: [18mm, 30mm]
  ヒント: size を auto にするか、size を大きくしてください。
✔ 12 ページを出力しました（out/、18.4 秒）
  警告 1 件
```

`--json` の場合は、診断・進捗・結果を次の形の 1 行ずつの JSON で出力する。

```json
{"type":"diagnostic","code":"TEXT_OVERFLOW","severity":"warning","location":{"file":"manga.yaml","line":48,"column":11},"message":"..."}
{"type":"progress","phase":"render","pageId":"p3","done":3,"total":12}
{"type":"result","files":[{"path":"out/manga-001.png","pageId":"p1","width":4441,"height":6213}],"warnings":1,"errors":0}
```
