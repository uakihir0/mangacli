# 13. 検証と診断

## 13.1 検証の段階

| 段階 | 内容 | `validate` | `render` |
|---|---|---|---|
| 1. 構文 | YAML の構文、重複キー、タグ、エイリアスの上限 | ○ | ○ |
| 2. スキーマ | キー、型、値の範囲、必須、排他、省略記法の展開 | ○ | ○ |
| 3. 意味 | ID の重複・形式、参照、スタイル、インポート・インクルード、循環 | ○ | ○ |
| 4. リソース | フォント・素材の存在と読み込み、字形の欠落 | ○ | ○ |
| 5. レイアウト | 本文のあふれ、コマの形、断ち切り、安全領域、見開き、自動配置 | ○ | ○ |
| 6. 出力 | 解像度不足、形式とカラーモードの組み合わせ、上限 | ○（プロファイル指定時） | ○ |

- 各段階でエラーがあれば、その段階の検証を最後まで行ってから処理を止める。1 つ目のエラーで止めず、可能な限り多くの誤りを一度に報告する。
- 診断の数の上限は 200 とし、超えた場合は残りの件数だけを報告する。
- 警告と情報は処理を止めない。`strict` の場合は警告をエラーとして扱う。

## 13.2 位置情報

- YAML から読み込んだ値には、ファイル・行・列（開始と終了）を付ける。
- カスケードで他の場所から来た値（スタイル、`defaults`）に起因する診断には、値が書かれた場所を `related` に含める。例: 「この吹き出しの本文があふれる。文字サイズはスタイル `big`（styles.yaml:12）で 18 Q に設定されている」。
- 省略記法から展開した値の診断は、省略記法を書いた位置を指す。
- TypeScript オブジェクトから読み込んだ場合は、ドキュメント内の位置（`path`）だけを付ける。

## 13.3 診断の形式

- 診断の型は [11.7](11-api.md#117-結果の型) の `Diagnostic` とする。
- メッセージは日本語と英語のカタログを持ち、`locale` で切り替える。メッセージの差し込み値（`params`）は機械可読な形でも提供する。
- 未知のキー・参照先が見つからない・未知の種類（`kind`）の診断には、編集距離が 2 以下の候補を「もしかして」として `hint` に含める。

```text
✖ SCHEMA_UNKNOWN_KEY  manga.yaml:31:9
  吹き出しに未知のキー "tial" があります。
  ヒント: "tail" のことですか？
```

- CLI のテキスト表示では、該当行の前後 2 行と、該当範囲の下線を表示する（[12.7](12-cli.md#127-表示の例)）。

## 13.4 重大度の変更

設定ファイル・API の `diagnostics` で、診断の重大度を変更、または無効化（`off`）できる。

```yaml
# mangacli.config.yaml
diagnostics:
  TEXT_NEAR_FOLD: off
  ASSET_LOW_RESOLUTION: error
  BALLOON_ORDER_MISMATCH: warning
```

下表で「変更」が × の診断（処理を続けられないエラー）は変更できない。変更しようとした場合は警告（`DIAGNOSTIC_NOT_CONFIGURABLE`）を出し、無視する。

## 13.5 診断コード一覧

重大度: E = エラー、W = 警告、I = 情報。

### 13.5.1 構文・スキーマ

| コード | 重大度 | 条件 | 変更 |
|---|---|---|---|
| `YAML_SYNTAX` | E | YAML の構文の誤り | × |
| `YAML_DUPLICATE_KEY` | E | 同じマップに同じキーがある | × |
| `YAML_UNKNOWN_TAG` | E | カスタムタグを使った | × |
| `YAML_ALIAS_LIMIT` | E | エイリアスの展開数が上限を超えた | × |
| `SCHEMA_UNSUPPORTED_VERSION` | E | `mangacli` のバージョンに対応しない、または指定がない | × |
| `SCHEMA_UNKNOWN_KEY` | E | 未知のキー（`x-` で始まるものを除く） | × |
| `SCHEMA_TYPE` | E | 値の型が違う | × |
| `SCHEMA_REQUIRED` | E | 必須のキーがない | × |
| `SCHEMA_ENUM` | E | 選択肢にない値 | × |
| `SCHEMA_RANGE` | E | 値が範囲外 | × |
| `SCHEMA_EXCLUSIVE` | E | 同時に指定できないキーを指定した（`at` と `place`、`tail` と `tails` など） | × |
| `SCHEMA_SHORTHAND_CONFLICT` | E | 省略記法の種類名のキーと主要なプロパティを同時に書いた | × |
| `SCHEMA_DEPRECATED` | W | 非推奨のキー・値を使った | ○ |
| `TEXT_FOLDED_SCALAR` | W | 本文に折り畳みブロックスカラー（`>`）を使った | ○ |
| `UNIT_INVALID` | E | 長さ・角度や印刷用 lpi の書式が不正。指定値と、その項目で使える単位をメッセージに表示する | × |
| `UNIT_NOT_ALLOWED` | E | その場所で使えない単位（`em` など） | × |
| `COLOR_INVALID` | E | 色の書式が不正 | × |
| `PAINT_INVALID` | E | 塗り（トーン・グラデーション）の書式が不正 | × |
| `REGION_INVALID` | E | 領域の指定が不正 | × |

たとえば `bleed: 12bmm` は `invalid length: "12bmm"; accepted units: mm, cm, in, pt, px, Q, H, em, %` と表示する。`bmm` / `bQ` は既定値の拡縮に使う内部単位で、文書の長さには `mm` / `Q` などを使う。長さは単位なしの数値や `@print` 接尾辞にも対応する。角度で使える単位は `deg, rad, turn`、印刷用 lpi の接尾辞は `@print`。

### 13.5.2 意味

| コード | 重大度 | 条件 | 変更 |
|---|---|---|---|
| `ID_DUPLICATE` | E | ID が重複する | × |
| `ID_INVALID` | E | ID の形式が不正 | × |
| `ID_RESERVED` | E | 予約語を ID に使った | × |
| `REF_NOT_FOUND` | E | 参照先（要素、キャラクター、素材、フォント、スタイル、アンカー）がない | × |
| `REF_CROSS_PAGE` | E | 別のページの要素を参照した | × |
| `REF_CYCLE` | E | 参照が循環する | × |
| `STYLE_CYCLE` | E | スタイルの `extends` が循環する | × |
| `STYLE_TYPE_MISMATCH` | E | `for` の対象外の要素にスタイルを適用した | × |
| `STYLE_KEY_NOT_APPLICABLE` | I | スタイルのキーが適用先の種類に存在しない | ○ |
| `IMPORT_NOT_FOUND` | E | インポート・インクルードのファイルがない | × |
| `IMPORT_INVALID_KEY` | E | インポートするファイルに許可されないキーがある | × |
| `IMPORT_CYCLE` | E | インポート・インクルードが循環する | × |
| `IMPORT_OVERRIDE` | I | インポートした定義を上書きした | ○ |
| `PLUGIN_NAME_CONFLICT` | E | プラグインの名前が衝突した | × |
| `PLUGIN_ERROR` | E | プラグインの関数が例外を投げた | × |
| `PLUGIN_LOAD_FAILED` | E | 設定ファイルで指定したプラグインのモジュールを読み込めない | × |
| `CONFIG_NOT_FOUND` | E | 指定した設定ファイルがない | × |
| `CONFIG_INVALID` | E | 設定ファイルを読み込めない、またはオブジェクトを返さない | × |
| `DIAGNOSTIC_NOT_CONFIGURABLE` | W | 変更できない診断の重大度を変更しようとした | ○ |

### 13.5.3 リソース

| コード | 重大度 | 条件 | 変更 |
|---|---|---|---|
| `ASSET_NOT_FOUND` | E（ドラフトでは W） | 素材が見つからない | × |
| `ASSET_UNSUPPORTED_FORMAT` | E | 対応しない画像形式 | × |
| `ASSET_DECODE_FAILED` | E | 画像を読み込めない | × |
| `ASSET_TOO_LARGE` | E | 画素数・ファイルサイズが上限を超える | × |
| `ASSET_LOW_RESOLUTION` | W | 実効解像度が不足する（[5.5.1](05-elements-and-images.md#551-解像度の確認)） | ○ |
| `ART_LEAVES_VOID` | W | 画像のあるコマで画像・塗り・明示的な背景が覆わない内側の面積が 5% を超える。`size` を外し `fit: cover` と `focus` で枠を満たす（欠落素材・プレースホルダーは除外） | ○ |
| `FONT_NOT_CONFIGURED` | E | 日本語の文字があるのに使えるフォントがない | × |
| `FONT_NOT_FOUND` | E | フォントのファイル・システムフォントが見つからない | × |
| `FONT_LOAD_FAILED` | E | フォントを読み込めない | × |
| `FONT_UNSUPPORTED_FORMAT` | E | 対応しないフォント形式 | × |
| `FONT_MISSING_GLYPH` | W | 字形のない文字がある | ○ |
| `FONT_NO_VERTICAL_FORMS` | I | 縦組み用字形のないフォントを縦書きで使った | ○ |
| `FONT_COLOR_GLYPH_FLATTENED` | I | カラーフォントの字形を輪郭のみで描いた | ○ |
| `FONT_SYSTEM_USED` | I | システムフォントを使った | ○ |
| `FONT_CATALOG_UNKNOWN` | E | カタログにない ID・太さ・フォントセットを指定した | × |
| `FONT_DOWNLOADING` | I | カタログのフォントをダウンロードしている | ○ |
| `FONT_DOWNLOAD_FAILED` | E | カタログのフォントを取得できない（ネットワーク、取得元の応答） | × |
| `FONT_INTEGRITY_FAILED` | E | 取得したフォントのハッシュがカタログと一致しない | × |
| `FONT_DOWNLOAD_DISABLED` | E | `fontDownload: never` で、必要なカタログのフォントが手元にない | × |
| `IO_NOT_FOUND` | E | 入力のファイルがない（CLI） | × |
| `SECURITY_PATH_OUTSIDE_ROOT` | E | ルートの外側のファイルを参照した | × |
| `SECURITY_NETWORK_DENIED` | E | 許可されていない URL を参照した | × |
| `SECURITY_LIMIT_EXCEEDED` | E | 入力・処理量の上限（ページ数、要素数、解像度など）を超えた | × |
| `SECURITY_TIMEOUT` | E | 1 ページの処理時間が `pageTimeoutMs` を超えた | × |

### 13.5.4 レイアウト・文字

| コード | 重大度 | 条件 | 変更 |
|---|---|---|---|
| `PAGE_BASEFRAME_OUTSIDE_SAFE` | W | 基本枠が安全領域からはみ出す | ○ |
| `HASHIRA_NO_SPACE` | W | 小口の安全な余白にノンブルをよけて柱が収まらず、描画されない | ○ |
| `HASHIRA_PANEL_OVERLAP` | W | 柱がコマと重なる | ○ |
| `LAYOUT_TOO_MANY_PANELS` | E | `panels` がレイアウトの葉より多い | × |
| `LAYOUT_FREE_MIXED` | E | `layout` を省略し、一部のコマだけが `box` / `polygon` を持つ | × |
| `BOOK_PAGE_COUNT` | I | 物理的なページ数が `book.signature` の倍数でない（印刷用のプロファイル） | ○ |
| `LAYOUT_EMPTY_SLOT` | W | 割り当てのないレイアウトの葉がある | ○ |
| `LAYOUT_DEGENERATE_PANEL` | E | コマが細すぎる・自己交差する | × |
| `LAYOUT_PANELS_OVERLAP` | W | 自由配置のコマが重なる | ○ |
| `LAYOUT_BLEED_NOT_ON_EDGE` | W | 外周に接しない辺を断ち切りに指定した | ○ |
| `LAYOUT_DOMINANT_MULTIPLE` | W | 1 ページに複数の大ゴマを指定した | ○ |
| `LAYOUT_DOMINANT_SPLIT` | W | 大ゴマで隣のコマが分断され、最大の部分だけを残した | ○ |
| `LAYOUT_DOMINANT_HOLE` | W | 大ゴマの拡張で穴ができるため、重なりを適用しなかった | ○ |
| `LAYOUT_ORDER_DUPLICATE` | E | コマの `order` が重複する | × |
| `LAYOUT_SPREAD_PARITY` | W | 見開きの位置が左右の規則に合わない | ○ |
| `LAYOUT_MONOTONE` | W | 矩形だけのページが 3 ページ以上続き、区間内に描き文字または線の演出がある（空白・コマなしページは区切り）。区間の最初のページにページ範囲を示す | ○ |
| `TEXT_OVERFLOW` | W（`overflow: error` では E） | 本文が収まらない | ○ |
| `TEXT_SHRUNK` | I | 本文を収めるために文字サイズを縮めた | ○ |
| `TEXT_CLIPPED` | W | 本文がクリップで切れる | ○ |
| `TEXT_OCCLUDED_BY_PANEL` | W | 吹き出し・本文・描き文字が後から描くコマ（挿入コマなど）の領域と 1 平方単位を超えて重なる。コマ内のクリップと描画順を考慮し、そのコマ自身の要素や枠より上の層は対象外 | ○ |
| `TEXT_OUTSIDE_SAFE_AREA` | W | 本文が安全領域の外にある | ○ |
| `TEXT_NEAR_FOLD` | W | 見開きの中央付近に文字がある | ○ |
| `TEXT_MARKUP_UNBALANCED` | E | マークアップのタグが対応しない | × |
| `TEXT_UNKNOWN_TAG` | E | 未知のマークアップのタグ | × |
| `TEXT_RUBY_NO_BASE` | I | `《》` の前に親文字がない | ○ |
| `TEXT_RUBY_MISMATCH` | E | モノルビの区切りの数と親文字の数が合わない | × |
| `TEXT_TCY_TOO_LONG` | W | 縦中横が 1 em に収まらない | ○ |
| `TEXT_MISSING_TRANSLATION` | W | 指定した言語の本文がない | ○ |
| `BALLOON_TOO_LARGE` | W | 吹き出しが `maxSize` を超えた | ○ |
| `BALLOON_NO_SPACE` | W | 自動配置で適切な位置がない | ○ |
| `BALLOON_NEAR_FACE` | W | 吹き出しの本体が顔（`face` 領域）から `faceMargin`（既定 `max(3 bmm, 顔の幅の 20 %)`）未満の距離にある | ○ |
| `BALLOON_SHIFTED` | I | 位置を指定した吹き出しが仕上がりの外にはみ出すため、内側へ移動した | ○ |
| `BALLOON_TAIL_TARGET_INSIDE` | W | しっぽの向き先が本体の内側にある | ○ |
| `BALLOON_TAIL_SHORT` | W | 吹き出しが話者から遠く、しっぽの先端が話者（向き先の止まる点）まで 20 bmm 以上届かない | ○ |
| `BALLOON_TAIL_CROSSES` | W | 付け根・曲がり・長さの自動調整で同じコマ（またはページレイヤー群）の他の吹き出し本体との重なりを解消できず、元のしっぽを保つ。線幅・泡の大きさを含む実際の形で判定し、相手の ID を通知。明示した `root`・`length`・`bend` は保つ | ○ |
| `BALLOON_TAIL_UNSUPPORTED` | W | 形状が対応しないしっぽの種類 | ○ |
| `BALLOON_CONNECT_DISJOINT` | I/W | `overlap` で合体できずに別々に描いた（I）、または `neck` の輪郭がつながらない（W） | ○ |
| `BALLOON_TEXT_HIDDEN` | W | 他の吹き出しで本文が隠れる | ○ |
| `BALLOON_OVERLAP` | W | 連結していない吹き出しの本体の外接矩形が重なる | ○ |
| `BALLOON_READING_ORDER` | W | 後の吹き出しが位置から明らかに先に読まれる | ○ |
| `BALLOON_ORDER_MISMATCH` | I | リストの順と位置から推定した読み順が違う | ○ |
| `DIALOGUE_SPEAKER_NOT_IN_PANEL` | I | 話者の画像が同じコマにない | ○ |
| `EFFECT_TOO_MANY_LINES` | E | 効果の線の本数が上限を超える | × |
| `TONE_DOTS_TOO_SMALL` | I | 出力解像度で描けない小さな網点を省いた | ○ |
| `TONE_MOIRE_RISK` | I | 線数・角度の異なるトーンが重なる（P2） | ○ |

### 13.5.5 描画・出力

| コード | 重大度 | 条件 | 変更 |
|---|---|---|---|
| `RENDER_FEATURE_APPROXIMATED` | W | バックエンドが対応しない機能を近似した | ○ |
| `RENDER_LINE_TOO_THIN` | I | 線幅を最小値に引き上げた、または出力解像度で細すぎる | ○ |
| `RENDER_FAILED` | E | 描画に失敗した | × |
| `RENDER_SINGLE_THREAD` | I | モジュール指定子のないプラグインがあるため、生成・描画をメインスレッドで行った | ○ |
| `OUTPUT_MODE_UNSUPPORTED` | E | 形式が対応しないカラーモード・透過を指定した | × |
| `OUTPUT_TONE_FORCED_DOTS` | W | 2 値出力で `toneRendering: flat` を指定した | ○ |
| `OUTPUT_TOO_LARGE` | E | 出力の画素数が上限を超える | × |
| `OUTPUT_WRITE_FAILED` | E | ファイルを書き込めない | × |
| `OUTPUT_NAME_COLLISION` | E | 異なる出力が同じファイル名になる | × |
| `OUTPUT_FINISH_IGNORED` | W | 出力のカラーモードで使えない仕上げを指定した | ○ |
| `INTERNAL_ERROR` | E | 内部エラー（不具合） | × |
