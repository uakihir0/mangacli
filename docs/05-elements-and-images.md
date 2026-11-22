# 5. 要素と画像素材

## 5.1 要素の種類

要素は、コマの `layers`、ページの `layers`、グループの `children` に置く描画対象である。

| `type` | 名称 | 説明 | 参照 | 優先度 |
|---|---|---|---|---|
| `image` | 画像 | 素材画像を置く | [5.5](#55-画像image) | P0 |
| `balloon` | 吹き出し | 吹き出しとその中のセリフ | [6](06-balloons.md) | P0 |
| `text` | 地の文字 | 吹き出しのない文字（ナレーション、注釈、手書き文字、題など） | [7.13](07-text.md#713-地の文字text) | P0 |
| `sfx` | 描き文字 | 擬音・擬態語の装飾文字 | [7.14](07-text.md#714-描き文字sfx) | P1 |
| `effect` | 効果 | 集中線、流線、フラッシュなど | [8](08-effects.md) | P0 |
| `fill` | 塗り | 領域をベタ・トーン・グラデーションで塗る | [5.9](#59-塗りfill) | P0 |
| `mark` | 漫符 | 汗、怒りマークなど | [8.15](08-effects.md#815-漫符mark) | P1 |
| `draw` | 描画図形 | 線、矢印、矩形、楕円、多角形、パス | [5.8](#58-描画図形draw) | P1 |
| `group` | グループ | 要素をまとめて配置・変形する | [5.10](#510-グループgroup) | P1 |
| `scatter` | 散布 | 漫符や素材を領域にばらまく | [8.16](08-effects.md#816-散布scatter) | P1 |

## 5.2 共通プロパティ

すべての要素が持つプロパティである。種類によって意味を持たないもの（`effect` の `size` など）は、各節で明記する。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `type` | 要素の種類 | 必須（省略記法を除く） | [5.1](#51-要素の種類) |
| `id` | ID | 自動 | [3.7](03-document-format.md#37-id-と参照) |
| `at` | Point | 種類による | 要素を置く位置（`anchor` の点をこの位置に合わせる） |
| `anchor` | 位置キーワード \| `[u, v]` | `center` | 要素のどの点を `at` に合わせるか。`[u, v]` は外接矩形内の相対位置（0〜1） |
| `place` | 位置キーワード | - | 基準領域の 9 点のいずれかに寄せて置く（`at` と同時に指定できない） |
| `inset` | Length | 2 mm | `place` のときの、基準領域の端からの距離 |
| `offset` | `[dx, dy]` | `[0, 0]` | 位置の微調整 |
| `size` | Size | 種類による | 要素の大きさ |
| `rotate` | Angle | `0` | `anchor` の点を中心とした回転 |
| `scale` | 数値 \| `[sx, sy]` | `1` | `anchor` の点を中心とした拡大縮小 |
| `flip` | `none` \| `x` \| `y` \| `xy` | `none` | 内容の反転（`x` は左右反転）。外接矩形の中で反転し、配置には影響しない（[5.3.4](#534-変換の計算)） |
| `coords` | `panel` \| `page` \| `baseFrame` \| 要素の ID | コマ内は `panel`、ページは `page` | 座標系（[3.6](03-document-format.md#36-座標系)） |
| `opacity` | 0〜1 | `1` | 不透明度 |
| `blend` | BlendMode | `normal` | 合成モード: `normal`、`multiply`、`screen`、`overlay`、`darken`、`lighten`、`color-dodge`、`color-burn`、`hard-light`、`soft-light`、`difference`、`exclusion` |
| `z` | 数値 | `0` | 重なり順。同じ値ならリストの順 |
| `clip` | Clip | 種類による | [5.4](#54-クリップとはみ出し) |
| `mask` | Mask | - | [5.11](#511-マスク)（P1） |
| `visible` | 真偽値 | `true` | 描画するか。`false` でもレイアウトの計算（参照・自動配置の障害物）には含める |
| `style` | スタイル名 \| スタイル名[] | - | 適用するスタイル（[3.8](03-document-format.md#38-スタイルと既定値のカスケード)） |
| `hand` | Hand | - | この要素の手描き設定（[9.9](09-hand-drawn.md#99-手描き設定hand)） |
| `seed` | 整数 | 導出 | シードの上書き（[9.2](09-hand-drawn.md#92-乱数とノイズ)） |
| `separation` | 分版名 | 種類による | 分版出力での振り分け先（[10.10](10-color-and-output.md#1010-分版出力)） |
| `note` | 文字列 | - | メモ。描画しない |
| `stack` | `over` \| `under` \| `art` | `over` | `under` はページ要素をコマより下に描く。複数コマへのクリップでは `art` は各コマの絵と同じ層、`over` は枠線より上（[4.12](04-pages-and-panels.md#412-描画順)） |

## 5.3 配置

### 5.3.1 位置

- `at` に点（[3.4.4](03-document-format.md#344-点point)）を書き、要素の `anchor` の点をそこに合わせる。
- `at` に参照を書くと、参照先に追従する（例: `at: taro1.eyes` に `mark: sweat` を置く）。
- `offset` は最後に加える。

```yaml
- mark: sweat
  at: taro1.face
  anchor: bottom-left
  offset: [4mm, -2mm]
```

### 5.3.2 place

`place` は、基準領域を `inset` だけ内側に縮めた矩形の 9 点に要素を寄せる。`anchor` を省略すると、`place` と同じキーワードを `anchor` に使う（`place: top-right` なら要素の右上をその点に合わせる）。

```yaml
- balloon: 翌日
  as: narration
  place: top-right
```

### 5.3.3 サイズ

| 種類 | `size` を省略した場合 | `auto` の意味 |
|---|---|---|
| `image` | コマ全体（塗り足しを含む外接矩形）を `fit` に従って覆う | 縦横比を保つ |
| `balloon` | 本文に合わせて決める | 本文に合わせる |
| `text` | 本文に合わせて決める | 本文に合わせる |
| `sfx` | 文字サイズと文字数から決める | 同左 |
| `mark` | 種類ごとの既定値（[8.15](08-effects.md#815-漫符mark)） | - |
| `draw` | `points` から決める（`rect` / `ellipse` は必須） | - |
| `group` | 基準領域と同じ | - |
| `effect`、`fill`、`scatter` | 使わない（`region` を使う） | - |

### 5.3.4 変換の計算

要素の変換行列は次の順に合成する。

```text
M = translate(at + offset) · rotate(rotate) · scale(scale) · translate(−anchorPoint)
```

`anchorPoint` は要素の外接矩形（大きさ `size`、原点は左上）の中の `anchor` の点である。`flip` は外接矩形の中で内容に適用し、`M` には含めない。

`flip` の効果:

- 画像では、素材のアンカー・領域・`focus` も内容と一緒に反転する。`flip: x` の画像の `taro1.mouth` は、反転後の口の位置を指す。
- 吹き出しでは、本体の形（形状レベルの不規則さを含む）としっぽだけを反転し、本文は反転しない。
- 地の文字・描き文字では、文字の形を反転する（鏡文字）。
- 自動で決める `anchor` の点（`place` に合わせた点など）は反転しない。

### 5.3.5 解決の順序

要素の位置とサイズが他の要素に依存する場合（参照、`auto` のサイズ、自動配置）は、依存関係のグラフを作り、トポロジカル順に解決する。循環はエラー（`REF_CYCLE`）。自動配置（[6.12](06-balloons.md#612-自動配置)）は、位置を明示した要素をすべて解決した後に行う。

## 5.4 クリップとはみ出し

| 値 | 意味 |
|---|---|
| `panel` | コマの形でクリップする |
| `none` | クリップしない。描画順はすべてのコマの枠線より後（[4.12](04-pages-and-panels.md#412-描画順)） |
| `trim` | 仕上がりでクリップする（ページの `layers` 用） |
| `auto` | 吹き出し用。コマの間の枠線にかかる場合は `none` と同じく枠線の上に描き、枠の外周（コマの並びの外側の辺）を越える場合は `panel` と同じく枠で切る。枠で切る場合は、本文を外周の辺から `max(2.5 bmm, 0.8em)` 内側へ寄せる |
| `{ to: panel, open: [辺...] }` | コマの形でクリップするが、指定した辺の方向には塗り足しの端まで開放する（P1） |
| `{ to: [コマID, ...], open: [辺...] }` | 指定したコマのクリップ多角形の和集合でクリップする。`open` は省略可能（全辺を閉じる）（[5.4.1](#541-はみ出しの表現)） |

| 種類 | `clip` の既定値 |
|---|---|
| `balloon` | `auto` |
| `text`、`sfx` | `none` |
| それ以外（コマ内） | `panel` |
| ページの `layers` | `none` |

吹き出しをコマ枠で切るとき、切断によって生じた約 3 mm 未満の孤立した輪郭の破片は、他の線を傷めずに除ける場合は描かない。取り除いた破片と枠の間に小さな隙間が残るときは、不透明な単色の吹き出しの塗りでその隙間を閉じる。本文は通常どおりクリップする。

### 5.4.1 はみ出しの表現

ページの `layers`（またはコマの要素）から複数のコマに人物をまたがせるには、`to` にコマ ID の配列（1 個以上）を指定する。

```yaml
- image: taro
  coords: page
  clip: { to: [p-left, p-right, p-bottom], open: [top] }
  stack: art
```

各コマのクリップ多角形の和集合で切り抜くため、間白では絵が消える。重なった開放領域も和集合として描く。`open` は省略可能で、省略時は全辺を閉じる。存在しない ID は `REF_NOT_FOUND` エラーになり、残りのコマだけでクリップする。
複数コマの `open` は対象コマ全体の外接矩形より外側に向けて開放し、矩形内の間白は開放方向にあっても残す。縦に並べたコマで `open: [top]` を使うと、最上段の枠から上へはみ出し、段の間では絵が切れる。
既定の `stack: over` は枠線より上。`stack: art` は各対象コマの絵の層にコピーし、コマ内の要素と `z`、リスト順で並べ、枠線より下に描く。開放方向のコマ外の部分だけはページ層に描く。ページ画像の顔・回避領域と口のアンカーは、交差する各コマの吹き出し自動配置でも考慮する。
実例: [span-figure.yaml](examples/span-figure.yaml)、[出力](images/span-figure.png)。

コマの枠を突き抜けて人物が飛び出す表現は、次のように書く。

```yaml
- image: taro-jump
  size: [auto, 130%]
  at: [50%, 100%]
  anchor: bottom
  clip: { to: panel, open: [top] }   # 上方向だけ枠の外に出す
  outline: 0.8mm white               # 枠線との境目を白で抜く
```

- `open` を指定した要素は、クリップを開放した方向について枠線より手前に描く。描画順は `clip: none` と同じ扱いとする。
- 開放しない辺では、コマの多角形を枠線の幅の半分だけ内側に縮めた形でクリップする。枠線より手前に描いても、閉じた辺の枠線を覆わない。
- 枠線との境界をきれいに見せるため、はみ出す要素には白の `outline`（[5.7](#57-縁取りと影)）を付けることを推奨する。

## 5.5 画像（image）

```yaml
- image: school-corridor          # コマ全体を覆う（cover）

- type: image
  src: taro-surprised
  size: [auto, 90%]
  at: [35%, 100%]
  anchor: bottom
  fit: contain
  flip: x
  filters: [ "levels(0.05, 0.95)" ]
```

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `src` | 素材名 \| パス | 必須（`placeholder` 指定時を除く） | 素材（[3.14](03-document-format.md#314-assets)）。登録していないパスを直接書いてもよい |
| `fit` | `cover` \| `contain` \| `fill` \| `none` \| `width` \| `height` | `size` 省略時は `cover`、指定時は `contain` | 箱への収め方。`none` は素材の実寸（画素数 ÷ `ppi`） |
| `focus` | `[u, v]` \| アンカー名 \| 領域名 | `[0.5, 0.5]` | `cover` で切り取るときに残す中心。素材内の相対位置（0〜1）またはアンカー・領域 |
| `zoom` | 数値 | `1` | `fit` の後に `focus` を中心として拡大する倍率。寄りの構図に使う |
| `crop` | Rect | 素材の値 | 素材の一部だけを使う（画素） |
| `character` | キャラクター ID | 素材の値 | 描かれている人物 |
| `characters` | Map\<キャラクター ID, { anchors?, regions? }\> | 素材の値 | 人物ごとにアンカー・領域を上書き・追加する。座標は素材の画素単位 |
| `anchors` | Map | 素材の値 | アンカーの上書き・追加 |
| `regions` | Map | 素材の値 | 領域の上書き・追加 |
| `filters` | Filter[] | 素材の値 | フィルタ（素材のフィルタの後に適用） |
| `outline` | Outline \| Outline[] | - | 不透明部分の縁取り（[5.7](#57-縁取りと影)） |
| `shadow` | Shadow | - | 影（P1） |
| `smoothing` | `high` \| `medium` \| `none` | `high` | 拡大縮小の補間。ドット絵などは `none` |
| `blend` | BlendMode | 素材の `kind` による | 合成モード |
| `placeholder` | 文字列 | - | 素材の代わりにプレースホルダーを描き、この文字列をラベルにする（[5.12](#512-プレースホルダー)） |

- `fit` の基準となる箱は、`size` を指定した場合はその箱、省略した場合はコマ全体（塗り足しを含む外接矩形）である。ページの `layers` では塗り足し全体である。
- `fit: cover` では、箱を覆いつつ `focus` が箱の中心に近づくように位置を決める（箱を覆えなくなる位置へは動かさない）。
- 画像は描画順のとおりに合成する。白背景の線画を背景の上に重ねる場合は `blend: multiply` または素材の `kind: lineart` を使う。
- `characters` は素材の定義に人物ごと・名前ごとに重ねる。たとえば `characters: { hana: { anchors: { mouth: [1210, 580] } } }` で花の口だけを変え、素材の顔領域は残せる。`who: hana` や `img.hana.mouth` はその人物の点を参照する。

### 5.5.1 解像度の確認

画像の実効解像度（素材の画素数 ÷ 表示寸法 [in]）が、次の値を下回る場合は警告（`ASSET_LOW_RESOLUTION`）を出す。

| 素材の `kind` | しきい値 |
|---|---|
| `lineart` | 出力解像度 × 0.9 |
| その他 | 出力解像度 × 0.5 |

出力解像度は、レンダリング時の解像度（[10.5](10-color-and-output.md#105-解像度とサイズ)）である。プレビューなど低解像度の出力では警告は出にくい。`mangacli validate --profile print-mono` のように、プロファイルを指定して検証できる。

警告には実効 ppi、必要 ppi としきい値の種類（`general` / `line art`）、現在の素材の px 寸法、同じ表示寸法・構図・縦横比で必要な素材全体の最小 px 寸法を表示する。`crop` がある場合は、素材を拡大した比率で `crop`・アンカー・領域の画素座標も更新する。実効 ppi は縦横の低い方を使い、`fit: cover` の切り落としや `zoom` による拡大も反映する。

必要画素数は各辺について **表示寸法 [mm] ÷ 25.4 × 必要 ppi** を切り上げて求める。`print-mono`（600 dpi）なら一般素材は 300 ppi、`kind: lineart` は 540 ppi が目安。例えば 100 × 50 mm の画像には一般素材で 1182 × 591 px、線画で 2126 × 1063 px 以上を用意する（切り落とす部分は別途必要）。足りない場合は高解像度の原画を用意するか、表示寸法を小さくする。単なる補間拡大は警告を解消しても元にない細線を復元しない。印刷用のモノクロ化では灰色の線が網点になることもあるため、最終出力を等倍で確認する。

## 5.6 フィルタ

（P1。モノクロ出力時の自動変換は P0 であり、[10.2](10-color-and-output.md#102-モノクロ化の規則) で定める）

フィルタは、文字列（関数形式）またはオブジェクトで書き、リストの順に適用する。

```yaml
filters:
  - grayscale
  - "levels(0.08, 0.92, 1.1)"
  - { halftone: { lpi: 60, angle: 45deg } }
```

| フィルタ | パラメータ | 説明 |
|---|---|---|
| `grayscale` | - | グレースケール化（輝度は Rec. 709 の係数） |
| `threshold` | `level`（0〜1、既定 0.5） | 2 値化 |
| `levels` | `black`、`white`、`gamma` | レベル補正 |
| `brightness` | 数値（1 で変化なし） | 明るさ |
| `contrast` | 数値（1 で変化なし） | コントラスト |
| `saturate` | 数値（1 で変化なし） | 彩度 |
| `hue` | Angle | 色相の回転 |
| `tint` | `color`、`amount` | 指定色への単色化（回想のセピア調など） |
| `sepia` | `amount` | セピア |
| `invert` | - | 階調の反転 |
| `blur` | `radius`（Length） | ぼかし |
| `motion-blur` | `angle`、`length`（Length） | 方向のあるぼかし（スピード感） |
| `sharpen` | `amount` | 鮮鋭化 |
| `posterize` | `levels` | 階調数の削減 |
| `halftone` | `lpi`、`angle`、`dot` | 網点化（[8.13](08-effects.md#813-トーン) と同じ網点） |
| `dither` | `method`（`floyd-steinberg` \| `ordered`） | 誤差拡散・組織的ディザによる 2 値化 |
| `white-to-alpha` | `threshold` | 白を透明にする |

- 長さのパラメータ（`radius` など）は mm で解釈し、出力解像度の画素に換算する。解像度を変えても見た目が一致する。
- フィルタは出力解像度に縮小した後の画素に適用する（[2.8](02-architecture.md#28-画像処理)）。

## 5.7 縁取りと影

### 5.7.1 縁取り（outline）

画像の不透明部分、文字、描き文字、漫符の輪郭の外側に縁を付ける。

```yaml
outline:
  - { width: 0.8mm, color: white }
  - { width: 1.2mm, color: black }
```

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `width` | Length | 必須 | 輪郭からの距離 |
| `color` | Paint | `white` | 縁の塗り |
| `join` | `round` \| `miter` | `round` | 角の形 |
| `threshold` | 0〜1 | 0.5 | 画像の場合、不透明とみなすアルファのしきい値 |

- リストの各項目の `width` は輪郭からの距離（累積ではない）で、幅の大きいものから順に描く。上の例は、内側に白 0.8 mm、その外側に黒 0.4 mm の縁になる。
- 名前で指定できる縁取り（題字向け）:

  | 名前 | 内容 |
  |---|---|
  | `thick-white` | 太い白フチ（1.4 mm）の外側に細い黒フチ（1.9 mm まで）。角は `miter`。黒い題字を絵の上で読ませる |
  | `thick-black` | 太い黒フチ（1.4 mm）の外側に細い白フチ（1.9 mm まで）。白抜きの題字（`color: white`）に使う |

  ```yaml
  # 題字をロゴのように組む:「朝」を大きく、「をひとつ」を小さく詰め、少し傾ける
  - sfx: "朝をひとつ"
    font: title
    lettering: { mode: typeset }
    perChar: { rotate: 0deg }
    distort: { roughen: 0, warp: 0, skew: -6deg }
    letterSpacing: -0.12em
    chars: [{ index: 0, scale: 1.5 }, { index: 1, scale: 0.75 }, { index: 2, scale: 0.85 }, { index: 3, scale: 0.85 }, { index: 4, scale: 0.85 }]
    outline: thick-white
  ```

- 画像の縁取りは、出力解像度でアルファを膨張させて作る。文字・図形の縁取りは、輪郭のオフセットで作る。

### 5.7.2 影（shadow）

（P1）

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `offset` | `[dx, dy]` | `[0.5mm, 0.5mm]` | ずれ |
| `blur` | Length | `0` | ぼかし |
| `color` | Color | `rgba(0,0,0,0.5)` | 色 |

モノクロ出力では、影のぼかしは網点化する。

## 5.8 描画図形（draw）

（P1）

```yaml
- draw: arrow
  points: [[20%, 80%], [45%, 60%], [60%, 62%]]
  stroke: 0.4mm
  head: { end: arrow }

- type: draw
  kind: rect
  at: [10mm, 10mm]
  anchor: top-left
  size: [30mm, 12mm]
  fill: white
  stroke: 0.25mm
  ruler: true
```

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `kind` | `line` \| `polyline` \| `curve` \| `arrow` \| `rect` \| `ellipse` \| `polygon` \| `path` | 必須 | 図形の種類。`curve` は点を滑らかに通る曲線（Catmull-Rom） |
| `points` | Point[] | - | `line`、`polyline`、`curve`、`arrow`、`polygon` の頂点 |
| `d` | 文字列 | - | `path` の SVG パス（単位は基準領域の mm） |
| `radius` | Length | `0` | `rect` の角丸 |
| `closed` | 真偽値 | `polygon` は `true`、他は `false` | 閉じた図形にするか |
| `stroke` | Stroke | `{ width: 0.3mm, pen: g-pen }` | 線 |
| `fill` | Paint | `none` | 塗り |
| `ruler` | 真偽値 | `false` | 定規で引いた線にする |
| `head` | `{ start, end, size }` | `{ end: arrow }`（`arrow` のみ） | 矢じり。`none`、`arrow`（開いた矢じり）、`triangle`（塗りの三角）、`dot`、`bar` |

## 5.9 塗り（fill）

領域を塗る。ベタ塗り、トーン貼り、グラデーションに使う。

```yaml
- tone: 20%                        # コマ全体に 20 % のトーン

- type: fill
  region: { band: { side: top, size: 40% } }
  paint: "tone-gradient(40%, 0%, 90deg)"
  edge: soft

- type: fill                       # 人物の形にだけ影のトーンを貼る
  region: { element: taro1, mode: alpha }
  paint: "tone(30%, 60lpi)"
  mask: { region: { rect: [0, 0, 50%, 100%] } }
```

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `region` | Region | コマ内は `panel`、ページは `bleed` | 塗る範囲 |
| `paint` | Paint | 必須 | 塗り（[3.4.9](03-document-format.md#349-塗りpaint)、[8.13](08-effects.md#813-トーン)） |
| `edge` | `clean` \| `cut` \| `soft` | `clean` | 境界の処理。`cut` は刃物で切ったようなわずかな凹凸（[9.11](09-hand-drawn.md#911-効果線とトーンの手作業感)）、`soft` はぼかし |
| `edgeWidth` | Length | `soft` は 3 mm、`cut` は 0.15 mm | 境界の処理の幅 |
| `erase` | EraseOp[] | - | 削り（[8.13.6](08-effects.md#8136-削りerase)、P1） |

## 5.10 グループ（group）

（P1）

```yaml
- type: group
  at: [70%, 30%]
  size: [30mm, 30mm]
  rotate: -8deg
  children:
    - mark: anger
    - mark: sweat
      at: [80%, 70%]
```

- グループの変換は子のすべてに適用する。
- `size` を指定したグループでは、子の `coords` の既定値はグループの外接矩形になる（子の `%` はグループに対する割合）。
- `opacity` はグループ全体に一度に適用する（子を合成した後に半透明にする）。
- `clip` と `mask` はグループ全体に適用する。

## 5.11 マスク

（P1）

```yaml
mask:
  region: { ellipse: [50%, 50%, 40%, 45%] }
  invert: false
  feather: 4mm
```

- 要素を、指定した領域の内側だけに描く（`invert: true` なら外側だけ）。
- `feather` で境界をぼかす。モノクロ出力では網点化する。
- `mask: { region: { element: <ID>, mode: alpha } }` で、他の要素の形をマスクに使える。
- `mask` には領域（Region）を直接書いてもよい（`mask: { ellipse: [...] }` は `mask: { region: { ellipse: [...] } }` と同じ）。

## 5.12 プレースホルダー

素材がまだない段階（ネーム）や、素材が見つからない場合に、代わりの図形を描く。

```yaml
- type: image
  placeholder: 太郎・驚き・バストアップ
  size: [60%, 80%]
  at: [40%, 100%]
  anchor: bottom
```

- 描画内容は、薄いグレーの矩形、対角線、ラベル文字とする（鉛筆風の線、[9.8](09-hand-drawn.md#98-手描きプリセット) の `sketch`）。
- `src` の素材が見つからない場合、通常はエラー（`ASSET_NOT_FOUND`）とする。ドラフトモード（`--draft`）または設定 `missingAssets: placeholder`（[12.5](12-cli.md#125-設定ファイル)、API の同名のオプション）では、素材名をラベルにしたプレースホルダーを描き、警告にとどめる。
- プレースホルダーは、自動配置で避ける領域として扱わない（`regions` がないため）。必要なら要素に `regions` を書く。
