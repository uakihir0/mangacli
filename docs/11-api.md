# 11. TypeScript API

## 11.1 方針

- すべての処理を非同期関数（`Promise`）で提供する。
- グローバルな状態を持たない。キャッシュは `Renderer` のインスタンスが持つ。
- 利用者の入力の誤りは診断（`Diagnostic`）として返す。例外は、入出力の失敗、中断、内部エラー、および `render` がエラーの診断を受け取った場合（`throwOnError` が `true` のとき）に限る。
- 入力の型（`MangaDocumentInput`）は Zod スキーマから推論し、YAML と同じ構造を TypeScript で書けるようにする。
- ファイルシステム、素材・フォントの取得、ログ出力は差し替えられる。

## 11.2 主要な関数

```ts
import {
  render, renderPage, renderStream,
  loadDocument, parseDocument, validate, resolve, layout,
  createRenderer, defineManga, defineConfig, definePlugin,
  installFonts,
} from "mangacli";
```

| 関数 | 説明 |
|---|---|
| `render(input, options?)` | ドキュメントをレンダリングする。`outDir` を指定するとファイルに書き出す。指定しないとバイト列を返す |
| `renderPage(input, page, options?)` | 1 ページだけをレンダリングする |
| `renderStream(input, options?)` | ページを順にレンダリングし、完成したものから返す（`AsyncIterable`） |
| `loadDocument(path, options?)` | YAML ファイルを読み込む（インポート・インクルードを含む） |
| `parseDocument(text, options?)` | YAML 文字列を解析する |
| `validate(input, options?)` | 検証し、診断を返す |
| `resolve(input, options?)` | カスケードを適用した `ResolvedDocument` を返す |
| `layout(input, options?)` | `LayoutTree` を返す（画像は生成しない） |
| `createRenderer(options?)` | キャッシュを共有するレンダラーを作る（11.4） |
| `defineManga(doc)` | 型付きでドキュメントを書くための恒等関数 |
| `defineConfig(config)` | 型付きで設定を書くための恒等関数 |
| `definePlugin(plugin)` | 型付きでプラグインを書くための恒等関数 |
| `installFonts(options)` | カタログのフォントを取得する（`mangacli fonts install` と同じ。[7.3.10](07-text.md#7310-フォントのカタログと取得)）。`{ set?, ids?, for?: MangaInput, dir?, force?, signal?, onProgress? }` を受け取り、取得したファイルの一覧を返す |

`input`（`MangaInput`）には次のいずれかを渡せる。

```ts
type MangaInput =
  | string                 // ファイルパス（.yaml / .yml / .json）
  | URL                    // file: URL
  | { yaml: string; filename?: string; baseDir?: string }   // YAML 文字列
  | MangaDocumentInput     // オブジェクト
  | LoadedDocument;        // loadDocument の結果
```

- ファイルパスで渡した場合、相対パスはそのファイルのディレクトリを基準に解決する。YAML 文字列・オブジェクトで渡した場合は、`baseDir`（オブジェクトでは `RenderOptions.baseDir`）、なければ `root`、なければ作業ディレクトリを基準とする。
- API は既定で設定ファイルを探さない（`config` を指定した場合だけ読み込む。`config: true` でエントリのディレクトリから探す）。

## 11.3 使用例

### 11.3.1 ファイルからレンダリングする

```ts
import { render } from "mangacli";

const result = await render("./manga.yaml", {
  profile: "print-mono",
  outDir: "./out",
});

for (const d of result.diagnostics) console.warn(d.message);
console.log(result.files.map((f) => f.path));
```

### 11.3.2 オブジェクトからバイト列を得る

```ts
import { render, defineManga } from "mangacli";
import { readFile } from "node:fs/promises";

const doc = defineManga({
  mangacli: 1,
  page: { size: "sns-portrait", color: "color" },
  fonts: { dialogue: "./fonts/ZenKakuGothicNew-Bold.ttf" },
  pages: [
    {
      layout: { template: "yonkoma" },
      panels: [
        { layers: [{ type: "image", src: "a" }, { type: "balloon", text: "おはよう" }] },
        // ...
      ],
    },
  ],
});

const result = await render(doc, {
  format: "png",
  assets: { a: await readFile("./a.png") },   // メモリ上の素材
  root: process.cwd(),
});

const png: Uint8Array = result.pages[0].data;
```

### 11.3.3 サーバーに組み込む

```ts
import { createRenderer } from "mangacli";

const renderer = createRenderer({
  root: "/srv/manga-assets",      // この外のファイルは読まない
  allowNetwork: false,
  ignoreDocumentOutput: true,     // 投稿されたドキュメントの output（解像度・出力先）を無視する
  limits: { maxPages: 8, maxOutputPixels: 20_000_000 },
  fonts: { dialogue: "/srv/fonts/ZenKakuGothicNew-Bold.ttf" },   // 共通のフォント
});

app.post("/render", async (req, res) => {
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const project = await renderer.load({ yaml: req.body.yaml });
  const check = await renderer.validate(project);
  if (!check.ok) return res.status(422).json(check.diagnostics);
  const page = await renderer.renderPage(project, 1, { profile: "sns", signal: ac.signal });
  res.type(page.mimeType).send(Buffer.from(page.data));
});
```

### 11.3.4 エディタでレイアウトを使う

```ts
const project = await renderer.load(doc);
const tree = await renderer.layout(project);
for (const panel of tree.pages[0].panels) drawPolygon(panel.polygon);

const list = await renderer.displayList(project, "p1", { dpi: 96 });
// list.root を独自の描画系で描く。tag.elementId で当たり判定を行う
```

## 11.4 レンダラー

```ts
function createRenderer(options?: RendererOptions): Renderer;

interface Renderer {
  load(input: MangaInput, options?: LoadOptions): Promise<Project>;
  validate(project: Project, options?: ValidateOptions): Promise<ValidationResult>;
  resolve(project: Project): Promise<ResolvedDocument>;
  layout(project: Project, options?: LayoutOptions): Promise<LayoutTree>;
  displayList(project: Project, page: PageRef, options?: RenderOptions): Promise<DisplayList>;
  render(project: Project, options?: RenderOptions): Promise<RenderResult>;
  renderPage(project: Project, page: PageRef, options?: RenderOptions): Promise<RenderedPage>;
  renderStream(project: Project, options?: RenderOptions): AsyncIterable<RenderedPage>;
  invalidate(paths?: string[]): void;     // ファイルの変更を通知してキャッシュを捨てる
  dispose(): Promise<void>;               // ワーカーとキャッシュを解放する
}

type PageRef = number /* pages のリストでの 1 始まりの順番（見開きも 1 つ） */ | string /* ページ ID */;
```

- `Project` は、読み込んだドキュメントとそのソースマップ・依存ファイルの一覧を持つ不変のオブジェクトである。
- 1 つの `Renderer` で複数の `render` を同時に実行してよい。
- `RendererOptions` は、`RenderOptions` のうちリソースと実行環境に関するもの（`root`、`fs`、`assetResolver`、`fontResolver`、`fonts`、`fontDownload`、`fontDir`、`fontCacheDir`、`fontMirror`、`plugins`、`config`、`cache`、`concurrency`、`limits`、`allowNetwork`、`logger`）を持つ。

## 11.5 レンダリングオプション

```ts
interface RenderOptions {
  // 出力
  profile?: string;                              // 既定 "web"
  format?: OutputFormat | OutputFormat[];
  colorMode?: "color" | "gray" | "mono";
  dpi?: number;
  scale?: number;
  width?: number;
  height?: number;
  crop?: "trim" | "bleed" | "marks";
  toneRendering?: "dots" | "flat" | "auto";
  spread?: "joined" | "split";
  separate?: SeparationName[] | "all" | false;
  background?: Paint | "transparent";
  emit?: ("layout" | "ir" | "transcript" | "manifest")[];
  outDir?: string;                               // 指定時のみファイルに書き出す
  name?: string;                                 // ファイル名のテンプレート
  clean?: boolean;

  // 内容
  pages?: string | (number | string)[] | ((page: PageInfo) => boolean);   // "1-3,5" など
  lang?: string;
  seed?: number;
  draft?: boolean;
  debug?: boolean | DebugLayer[];

  // 検証と実行
  strict?: boolean;                              // 警告をエラーとして扱う
  throwOnError?: boolean;                        // 既定 true
  failFast?: boolean;                            // 既定 false。true なら 1 ページの失敗で全体を止める（11.9）
  diagnostics?: Partial<Record<DiagnosticCode, "error" | "warning" | "info" | "off">>;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  logger?: Logger;

  // リソース
  root?: string;
  assets?: Record<string, Uint8Array | AssetSource>;
  fonts?: Record<string, Uint8Array | FontDefInput>;
  fontSet?: string | "none";                     // ドキュメントの fontSet の上書き
  fontDownload?: "auto" | "never";               // カタログのフォントの自動取得（既定 auto）
  fontDir?: string;                              // プロジェクトのフォントの置き場所
  fontCacheDir?: string;                         // ユーザーのキャッシュの場所
  fontMirror?: string;                           // 取得元の URL の接頭辞の置き換え
  assetResolver?: AssetResolver | AssetResolver[];
  fontResolver?: FontResolver | FontResolver[];
  fs?: FileSystemAdapter;
  allowNetwork?: boolean | { hosts: string[]; timeoutMs?: number; maxBytes?: number };
  allowOutsideRoot?: boolean;
  baseDir?: string;                              // オブジェクトで渡した場合の相対パスの基準
  assetPaths?: string[];                         // 素材を名前で探すディレクトリ
  missingAssets?: "error" | "placeholder";       // 素材がない場合（5.12）
  ignoreDocumentOutput?: boolean;                // ドキュメントの output を無視する（2.13）
  segmenter?: TextSegmenter;                     // 文節区切りの差し替え（7.6.2）。メインスレッドで呼ぶ
  plugins?: MangaPlugin[];
  config?: MangaConfig | string | boolean;       // 既定 false（探さない）。true でエントリのディレクトリから探す
  cache?: CacheOptions | false;
  limits?: Partial<Limits>;
}

interface ProgressEvent {
  phase: "load" | "validate" | "resolve" | "prepare" | "layout" | "generate" | "render" | "encode" | "write";
  pageId?: string;
  done: number;
  total: number;
}
```

- オプションの値は、プロファイルの値より優先する（[10.7](10-color-and-output.md#107-出力プロファイル)）。
- `assets` と `fonts` は、ドキュメントの同名の登録より優先する。サーバーで素材をメモリから与える場合に使う。
- `signal` で中断した場合は、`MangaAbortError`（`name` は `"AbortError"`）を投げる。書きかけのファイルは残さない（一時ファイルに書いてから名前を変える）。

## 11.6 リゾルバー

素材とフォントの取得方法を差し替える。

```ts
interface AssetResolver {
  name: string;
  resolve(ref: AssetRef, ctx: ResolveContext): Promise<AssetSource | null>;   // null なら次のリゾルバーへ
}

interface AssetRef {
  name?: string;                 // assets の登録名
  src: string;                   // 書かれたパス・URL
  from: SourceLocation;          // 書かれた場所
}

type AssetSource =
  | { kind: "file"; path: string }
  | { kind: "buffer"; data: Uint8Array; mimeType?: string; name?: string }
  | { kind: "url"; url: string };

interface FontResolver {
  name: string;
  resolve(ref: FontRef, ctx: ResolveContext): Promise<FontSource | null>;
}

interface FileSystemAdapter {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean }>;
  realpath?(path: string): Promise<string>;
  writeFile?(path: string, data: Uint8Array): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  mkdir?(path: string, options: { recursive: true }): Promise<void>;
}
```

- 既定のリゾルバーの順序は、`options.assets` → 利用者のリゾルバー → プラグインのリゾルバー → ファイル（`root` の内側） → URL（許可時）とする。
- どのリゾルバーも解決できない場合は `ASSET_NOT_FOUND`（フォントは `FONT_NOT_FOUND`）。
- `root` の外側のパス、許可されていない URL は、リゾルバーに渡す前に拒否する（`SECURITY_PATH_OUTSIDE_ROOT`、`SECURITY_NETWORK_DENIED`）。

## 11.7 結果の型

```ts
interface RenderResult {
  pages: RenderedPage[];             // ページ順（分版・複数形式の場合はその分だけ）。失敗したページは含まない
  failures: { pageId: string; index: number; error: MangaError }[];   // 失敗したページ（11.9）
  files: OutputFile[];               // outDir を指定した場合に書き出したファイル
  diagnostics: Diagnostic[];
  timings: Record<string, number>;   // 段階ごとの所要時間（ms）
  extras: { layout?: LayoutTree; transcript?: Transcript; manifest?: Manifest };
}

interface RenderedPage {
  id: string;
  index: number;                     // 通し番号（1 始まり）
  number: number | [number, number] | null; // ノンブル（見開きは 2 つ。番号を持たないページは null）
  side: "left" | "right" | "spread";
  format: OutputFormat;
  mimeType: string;
  colorMode: "color" | "gray" | "mono";
  width: number;                     // px
  height: number;                    // px
  dpi: number;
  separation?: SeparationName;
  data: Uint8Array;
  diagnostics: Diagnostic[];
}

interface ValidationResult {
  ok: boolean;                       // エラーがなければ true
  diagnostics: Diagnostic[];
}

interface Diagnostic {
  code: DiagnosticCode;              // 例: "TEXT_OVERFLOW"
  severity: "error" | "warning" | "info";
  message: string;                   // 表示言語のメッセージ
  messageId: string;                 // 翻訳用のキー
  params: Record<string, unknown>;   // メッセージの差し込み値
  location?: SourceLocation;         // { file, line, column, endLine, endColumn }
  path?: (string | number)[];        // ドキュメント内の位置（例: ["pages", 0, "panels", 2]）
  elementId?: string;
  pageId?: string;
  hint?: string;                     // 修正の手がかり
  related?: { message: string; location?: SourceLocation }[];
}
```

`LayoutTree`、`DisplayList`、`ResolvedDocument` の型は `mangacli/schema`、`mangacli/ir` から公開する（[2.4](02-architecture.md#24-データモデルの段階)、[2.5](02-architecture.md#25-表示リストir)）。

## 11.8 プラグイン

（P1）組み込みの形状・効果・漫符・ペン・テンプレートも、内部ではこの仕組みで登録する。

### 11.8.1 定義

プラグインは、既定のエクスポートでプラグインを返す ES モジュールとして作る。ワーカースレッドでも同じプラグインを読み込むため（[2.10](02-architecture.md#210-並列化キャッシュ性能)）、設定ファイルではモジュール指定子で指定することを推奨する（`plugins: ["./plugins/my-kit.js", "mangacli-plugin-foo"]`）。プラグインのオブジェクトを直接渡す場合は、`module` フィールドに自身のモジュール指定子（`import.meta.url`）を書く。

```ts
import { definePlugin, z } from "mangacli/plugin";

export default definePlugin({
  name: "my-manga-kit",
  version: "1.0.0",
  balloonShapes: {
    "my-kit/heart": {
      params: z.object({ depth: z.number().min(0).max(1).default(0.3) }),
      outline(ctx, params, size) {
        // 単位正方形の中のハート形を作り、ctx.rng で L1 の不規則さを加える
        return ctx.contour.fromSvgPath(heartPath(params.depth)).scale(size).jitter(ctx.irregularity);
      },
      textArea(ctx, params, size) {
        return ctx.contour.ellipse(size.width * 0.32, size.height * 0.28).translate(0, -size.height * 0.05);
      },
      defaultTail: "wedge",
    },
  },
  effects: {
    "my-kit/hearts-rain": {
      params: z.object({ count: z.number().int().default(30) }),
      generate(ctx, params) {
        const nodes = [];
        for (let i = 0; i < params.count; i++) {
          const p = ctx.randomPointIn(ctx.region);
          nodes.push(...ctx.marks.draw("heart", { at: p, size: ctx.rng.range(2, 5) }));
        }
        return nodes;
      },
    },
  },
});
```

### 11.8.2 登録できるもの

| キー | 内容 |
|---|---|
| `balloonShapes` | 吹き出しの形状（`outline`、`textArea`、任意で `fit`、`strokePlan`） |
| `tailKinds` | しっぽの種類 |
| `effects` | 効果（`generate` が表示リストのノードを返す） |
| `marks` | 漫符 |
| `pens` | ペンプリセット |
| `handPresets` | 手描きプリセット |
| `layoutTemplates` | コマ割りテンプレート（`rows` / `split` を返す） |
| `pageSizes` | 判型プリセット |
| `styles` | 組み込みスタイル（`as` で選べる発話の種類を含む） |
| `filters` | 画像フィルタ |
| `elements` | 新しい要素の種類（`type`） |
| `assetResolvers`、`fontResolvers` | リゾルバー |
| `backends` | 出力のバックエンド（新しい形式） |
| `hooks` | 処理の段階ごとのフック（11.8.4） |

現在の実装（engine 1）で使えるのは、`balloonShapes`（`outline`・`textArea`・`ruler`）、`effects`・`marks`（`draw` または `generate`）、`pens`、`handPresets`、`layoutTemplates`、`pageSizes`、`styles`、`hooks`（`afterLoad`・`afterResolve`・`beforeRender`・`afterRender`）である。`tailKinds`、`filters`、`elements`、リゾルバー、`backends`、`afterLayout` のフック、パラメータのスキーマの JSON Schema への取り込みは今後の拡張とする。組み込みの形状を厳密に検証するため、プラグインの形状のパラメータは、組み込みにない `kind` の場合にだけ受け付ける。

### 11.8.3 文脈（context）

プラグインの関数には、決定性を保つための道具を文脈として渡す。プラグインは `Math.random()` や時刻を使ってはならない。

| 文脈の項目 | 内容 |
|---|---|
| `rng` | 要素と用途から導出した乱数の生成器（`next()`、`range(a, b)`、`normal()`、`pick(list)`） |
| `noise` | ノイズ関数（[9.2.3](09-hand-drawn.md#923-ノイズ関数)） |
| `hand` | 解決済みの手描き設定 |
| `irregularity` | 形状レベルの不規則さ（`shape.irregularity` × `hand.irregularity`） |
| `contour` | 輪郭の作成・変換の道具（楕円、多角形、SVG パス、ブール演算、オフセット） |
| `ink` | 手描き化の道具（`stroke(path, options)`、`fillShape(contour, paint)`、`strokeShape(contour, stroke)`） |
| `tone` | トーンの塗りの作成 |
| `marks` | 漫符の描画 |
| `region`、`bounds` | 効果の範囲と外接矩形（mm） |
| `resolvePoint(p)` | 点（座標・参照）を mm に解決する |
| `randomPointIn(region)` | 領域の中の点を、文脈の乱数で一様に選ぶ |
| `page`、`panel` | ページ・コマのレイアウト |
| `units` | 単位の換算 |
| `diagnostics.report(...)` | 診断を報告する |
| `line(points, options)`、`shape(points, fill)`、`push(...nodes)` | 効果・漫符の `draw` で、手描きの線・閉じた図形（塗り付き）・任意のノードを描く（実装での簡便な形） |
| `marks.draw(kind, { at, size, rotate })` | 漫符を描いたノードを返す（`at` は mm の点） |

### 11.8.4 フック

| フック | 呼ばれる時点 | 受け取るもの | 返すもの |
|---|---|---|---|
| `afterLoad` | 読み込みの後 | 正規形のドキュメント | 置き換えるドキュメント（任意） |
| `afterResolve` | カスケードの後 | ResolvedDocument | 置き換え（任意） |
| `afterLayout` | レイアウトの後 | ページの LayoutTree | 置き換え（任意） |
| `beforeRender` | バックエンドへ渡す前 | 表示リスト | 置き換え（任意） |
| `afterRender` | エンコードの前 | ラスタ画像 | 置き換え（任意） |

フックは受け取ったデータを変更せず、変更したい場合は新しいデータを返す。

### 11.8.5 名前の衝突

- プラグインが登録する名前は、`<プラグイン名>/<名前>` の形を推奨する。
- 組み込みや他のプラグインと同じ名前を登録した場合はエラー（`PLUGIN_NAME_CONFLICT`）。`override: true` を付けた場合のみ置き換える。
- プラグインのパラメータのスキーマは、JSON Schema の生成に含める（[3.20](03-document-format.md#320-json-schema-とエディタ補完)）。

## 11.9 例外と部分的な失敗

### 11.9.1 例外

| 例外 | 発生する条件 |
|---|---|
| `MangaValidationError` | 検証の段階（[13.1](13-validation.md#131-検証の段階) の 1〜6）でエラーの診断があり、`throwOnError` が `true`（既定）。`diagnostics` を持つ。ドキュメントに書かれたルート外のパス・許可されていない URL・上限の超過も、診断（`SECURITY_*`）としてここに含まれる |
| `MangaResourceError` | 素材・フォントの読み込みに失敗（ファイルが壊れている、形式に対応していない） |
| `MangaRenderError` | バックエンドやエンコードの失敗。部分的な失敗（11.9.2）をまとめて投げる場合にも使う |
| `MangaSecurityError` | 検証の後の処理中に検出した違反（URL のリダイレクト先が許可されていない、処理時間の上限 `pageTimeoutMs` の超過など） |
| `MangaAbortError` | `signal` による中断。`name` は `"AbortError"` |

すべての例外は `MangaError` を継承し、`code`（診断コードと同じ体系）を持つ。

### 11.9.2 部分的な失敗

複数ページのレンダリングで、一部のページの処理（段階 7〜10）だけが失敗した場合の扱いを次のとおりとする。

| `failFast` | 処理 |
|---|---|
| `false`（既定） | 他のページの処理を続ける。成功したページのファイルは書き出し、`manifest.json` には成功したページだけを載せ、失敗したページを `failures` に記録する。すべてのページを処理した後、`throwOnError` が `true` なら `MangaRenderError`（`failures` を持つ）を投げ、`false` なら `RenderResult.failures` に入れて返す。CLI の終了コードは 2 |
| `true` | 最初の失敗で残りの処理を中止し、例外を投げる。書き出し済みのファイルは残す |

- `renderStream` では、検証のエラーは最初のページを返す前に投げる。ページの失敗は `onDiagnostic` で通知して次のページへ進み、すべてのページを返し終えた後に、`throwOnError` に従って投げる（`failFast: true` ならその時点で投げる）。


## 11.10 型の公開

| エントリ | 主な型 |
|---|---|
| `mangacli` | `MangaInput`、`RenderOptions`、`RenderResult`、`RenderedPage`、`Renderer`、`Diagnostic`、`MangaConfig` |
| `mangacli/schema` | `MangaDocumentInput`、`MangaDocument`、要素ごとの型（`BalloonInput`、`ImageInput` など）、`ResolvedDocument`、`LayoutTree`、Zod スキーマ本体、JSON Schema |
| `mangacli/plugin` | `MangaPlugin`、`BalloonShapeDef`、`EffectDef`、文脈の型、`z`（Zod の再公開） |
| `mangacli/ir` | `DisplayList` と各ノードの型、正規化・シリアライズの関数 |

公開する型と関数の互換性は、パッケージのセマンティックバージョニングに従う。表示リストと LayoutTree の構造は `version` フィールドを持ち、互換性のない変更ではこれを上げる。
