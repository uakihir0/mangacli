# 16. 付録: 文字列の構文

ドキュメントの中で文字列として書く値（長さ、塗り、線の省略記法、フィルタ、マークアップなど）の構文を、拡張 BNF（EBNF）で定める。実装はこの構文に従って解析し、受理・拒否の境界を適合テストで確かめる（[14.2.1](14-quality.md#1421-単体テストの主な対象)）。

## 16.1 記法

| 記法 | 意味 |
|---|---|
| `a b` | a の後に b |
| `a \| b` | a または b |
| `[ a ]` | a は省略できる |
| `{ a }` | a の 0 回以上の繰り返し |
| `"x"` | 文字列 x そのもの |
| `ws` | 0 個以上の空白（U+0020、U+0009） |
| `ws1` | 1 個以上の空白 |

- キーワード・単位・関数名は、特記がない限り小文字で、大文字と小文字を区別する（`Q` と `H` は大文字）。
- 文字列の前後の空白は無視する。

## 16.2 数値・長さ・角度・割合

```ebnf
digits    = digit { digit } ;
number    = [ "-" | "+" ] ( digits [ "." digits ] | "." digits ) ;
length    = number ws length-unit | number ;            (* 単位なしは page.units *)
length-unit = "mm" | "cm" | "in" | "pt" | "px" | "Q" | "H" | "em" ;
percent   = number ws "%" ;
length-or-percent = length | percent ;
angle     = number ws angle-unit | number ;             (* 単位なしは度 *)
angle-unit = "deg" | "rad" | "turn" ;
angle-u   = number ws angle-unit ;                      (* 単位が必須の角度 *)
lpi       = number ws "lpi" ;
```

- 指数表記（`1e3`）は使えない。
- 負の値を許すかどうかはキーごとに定める（[3.4.1](03-document-format.md#341-長さlength)）。

## 16.3 色

```ebnf
color     = css-color | "ink" | "paper" | "transparent" ;
css-color = named-color
          | "#" hex hex hex [ hex ]
          | "#" hex hex hex hex hex hex [ hex hex ]
          | ( "rgb" | "rgba" ) "(" ws rgb-args ws ")"
          | ( "hsl" | "hsla" ) "(" ws hsl-args ws ")" ;
rgb-args  = channel ws "," ws channel ws "," ws channel [ ws "," ws alpha ]      (* 従来の書き方 *)
          | channel ws1 channel ws1 channel [ ws "/" ws alpha ] ;               (* 空白区切り *)
channel   = number | percent ;
alpha     = number | percent ;
hsl-args  = hue ws "," ws percent ws "," ws percent [ ws "," ws alpha ]
          | hue ws1 percent ws1 percent [ ws "/" ws alpha ] ;
hue       = number | angle-u ;
```

`named-color` は CSS Color Level 4 の名前付き色（148 色）とし、大文字と小文字を区別しない（CSS と同じ）。

## 16.4 塗り

```ebnf
paint     = "none" | color | tone | tone-gradient | linear-gradient | radial-gradient ;

tone      = "tone(" ws percent { ws "," ws tone-arg } ws ")" ;
tone-arg  = lpi | angle-u | dot-shape ;
dot-shape = "round" | "square" | "ellipse" | "line" | "cross" | "noise" ;

tone-gradient = "tone-gradient(" ws percent ws "," ws percent { ws "," ws tg-arg } ws ")" ;
tg-arg    = angle-u | "radial" | lpi | dot-shape ;

linear-gradient = "linear-gradient(" ws [ ( angle-u | "to" ws1 side-or-corner ) ws "," ws ] stops ws ")" ;
side-or-corner  = side [ ws1 side ] ;
side      = "top" | "bottom" | "left" | "right" ;

radial-gradient = "radial-gradient(" ws [ "at" ws1 position ws "," ws ] stops ws ")" ;
position  = length-or-percent ws1 length-or-percent ;

stops     = stop ws "," ws stop { ws "," ws stop } ;
stop      = color [ ws1 length-or-percent ] ;
```

- `tone-arg`・`tg-arg` は、種類ごとに 1 回まで書ける（`tone(30%, 60lpi, 65lpi)` はエラー）。
- `tone()`・`tone-gradient()` の角度は単位が必須である（数値だけでは線数と区別できないため）。
- `side-or-corner` の 2 つの値は、縦（`top` / `bottom`）と横（`left` / `right`）を 1 つずつとする。
- グラデーションの角度の意味は CSS と同じ（[8.14.1](08-effects.md#8141-グラデーション)）。`radial-gradient` の形は、中心から最も遠い角までを半径とする楕円（CSS の既定）に固定する。
- 位置を省略した色の停止点は、CSS と同じ規則で等間隔に補う。

## 16.5 線・枠線・縁取りの省略記法

```ebnf
stroke-short  = "none" | stroke-token { ws1 stroke-token } ;
stroke-token  = length | stroke-style | color ;
stroke-style  = "solid" | "dashed" | "dotted" | "double" ;

outline-short = "none" | outline-token { ws1 outline-token } ;
outline-token = length | color ;

halo-short = "none" | length [ ws1 color ] ;
```

- 長さ・スタイル・色は、それぞれ 1 回まで、任意の順で書ける。
- `none` は単独でのみ書ける。
- 線のスタイルの名前は CSS の色の名前と重ならないため、トークンの種類は一意に決まる。
- 縁取りの省略記法は、長さを必須とする。
- `halo` は長さを先に書く。YAML の `false` でも無効にできる。正規形は `{ width: <length>, color?: <color> }`（幅は非負、色を省略したときは本体の不透明な単色、または `paper`）。
- `outline` / `textOutline` の正規形は `{ width, color?, join?, miterLimit?, fillHoles?, threshold? }` の配列。`join` は `round` または `miter`、`miterLimit` は 1 以上（既定 2）、`fillHoles` は非負の長さ（既定 0）。この 3 項目は省略記法ではなくオブジェクトで指定する。文字の縁は単色のみ。`threshold` は画像用の 0〜1 の数値。

## 16.6 フィルタ

```ebnf
filter    = filter-name [ "(" ws [ arg { ws "," ws arg } ] ws ")" ] ;
filter-name = "grayscale" | "threshold" | "levels" | "brightness" | "contrast" | "saturate"
            | "hue" | "tint" | "sepia" | "invert" | "blur" | "motion-blur" | "sharpen"
            | "posterize" | "halftone" | "dither" | "white-to-alpha" ;
arg       = length | percent | angle | lpi | color | ident ;
ident     = letter { letter | digit | "-" } ;
```

関数形式の引数は、次の順の位置引数とする。省略した引数は既定値を使う（[5.6](05-elements-and-images.md#56-フィルタ)）。

| フィルタ | 位置引数 |
|---|---|
| `threshold` | `level` |
| `levels` | `black`, `white`, `gamma` |
| `brightness`、`contrast`、`saturate`、`sharpen` | 量 |
| `hue` | 角度 |
| `tint` | `color`, `amount` |
| `sepia` | `amount` |
| `blur` | `radius` |
| `motion-blur` | `angle`, `length` |
| `posterize` | `levels` |
| `halftone` | `lpi`, `angle`, `dot` |
| `dither` | `method` |
| `white-to-alpha` | `threshold` |

## 16.7 参照

```ebnf
ref       = id [ "." name ] ;
id        = id-start { id-char } ;
id-start  = letter | "_" ;                    (* letter は Unicode の文字（一般カテゴリ L） *)
id-char   = letter | digit | "_" | "-" ;      (* digit は Unicode の数字（一般カテゴリ Nd） *)
name      = id ;                              (* アンカー名・領域名・位置キーワード *)
```

点を書く場所で文字列が位置キーワード（`center` など）と一致する場合は、位置キーワードとして扱う（キーワードは ID に使えない、[3.7.1](03-document-format.md#371-id)）。

### 16.7.1 カタログのフォントの参照

`fonts` の値に書くカタログのフォントの省略記法（[7.3.10](07-text.md#7310-フォントのカタログと取得)）。

```ebnf
catalog-ref = "catalog:" catalog-id [ "@" digits ] ;
catalog-id  = lower { lower | digit | "-" } ;     (* lower は ASCII の小文字 *)
```

- `@` の後の数値は太さ（例: `@700`）。省略するとカタログの既定の太さ（多くは 400）。
- `catalog:` で始まる文字列は、拡張子の有無にかかわらずカタログの参照として扱い、別名（`alias`）やパスとは解釈しない。

## 16.8 ページの範囲

CLI の `--pages` と API の `pages`（文字列）で使う。

```ebnf
page-range = range-item { ws "," ws range-item } ;
range-item = index [ ws "-" ws [ index ] ] | id ;
index      = digits ;                         (* pages のリストでの 1 始まりの順番 *)
```

- `3-` は 3 番目から最後まで。`2-5` は 2〜5 番目（両端を含む）。
- 範囲の重なりは許し、結果は重複を除いてリストの順に並べる。
- 存在しない番号・ID はエラー（`REF_NOT_FOUND`）。

## 16.9 ファイル名のテンプレート

```ebnf
template    = { literal | placeholder | "{{" | "}}" } ;
placeholder = "{" ph-name [ ":" digits ] "}" ;
ph-name     = "name" | "title" | "page" | "index" | "id" | "side" | "profile" | "lang" | "sep" ;
literal     = 任意の文字（"{" と "}" を除く） ;
```

- `:` の後の数値は、0 で埋める桁数である（数値の置換子のみ）。
- `{{`、`}}` はそれぞれ `{`、`}` そのものを表す。
- 未知の置換子はエラー（`SCHEMA_ENUM`）。

## 16.10 インラインマークアップ

[7.7](07-text.md#77-インラインマークアップ) の構文を定める。改行（LF）は行の区切りであり、CR は取り除く。

```ebnf
markup    = { item } ;
item      = escape | emphasis | ruby | tag | char ;

escape    = "\" ( "《" | "》" | "｜" | "|" | "<" | ">" | "\" ) ;

emphasis  = "《《" { item - "》》" } "》》" ;

ruby      = explicit-ruby | implicit-ruby ;
explicit-ruby = bar base "《" ruby-text "》" ;
bar       = "｜" | "|" ;
base      = base-char { base-char } ;              (* 1〜20 文字 *)
base-char = 任意の文字（"《"、"》"、"｜"、"|"、LF を除く） ;
implicit-ruby = kanji { kanji } "《" ruby-text "》" ;   (* 直前の漢字の最長の連続を親文字とする *)
kanji     = 範囲名 kanji（7.3.4）に含まれる文字 ;
ruby-text = ruby-char { ruby-char } ;              (* 半角の空白で区切るとモノルビ *)
ruby-char = 任意の文字（"》"、LF を除く） ;

tag       = open-tag | close-tag | void-tag ;
open-tag  = "<" tag-name [ "=" value ] { ws1 attr-name "=" value } ws ">" ;
close-tag = "</" tag-name ws ">" ;
void-tag  = "<" ( "br" | "wbr" | "space" [ "=" value ] ) ws [ "/" ] ">" ;
tag-name  = "ruby" | "em" | "tcy" | "upright" | "sideways" | "b" | "size" | "big" | "small"
          | "font" | "color" | "shake" | "hand" | "nobr" | "scale" ;
attr-name = ident ;
value     = unquoted | '"' { 任意の文字 - '"' } '"' | "'" { 任意の文字 - "'" } "'" ;
unquoted  = 1 文字以上（空白、">"、'"'、"'" を除く） ;

char      = 任意の 1 文字 ;
```

解釈の規則:

1. 左から右へ、最も長く一致するものを優先して解析する。`《《` は常に傍点の始まりとして扱う。
2. `<` の直後が ASCII の英字または `/` の場合だけタグとして解析する。それ以外の `<`（`<3`、`< ` など）は通常の文字とする。タグとして解析を始めて構文に合わない場合、または未知のタグ名の場合はエラー（`TEXT_UNKNOWN_TAG`）。
3. タグの外の `>` は通常の文字とする。
4. `implicit-ruby` は、`《` の直前の文字が漢字の場合だけ成立する。成立しない `《…》` は通常の文字として扱い、情報（`TEXT_RUBY_NO_BASE`）を出す。
5. `explicit-ruby` の `bar` の後に `《` が現れない場合、`bar` は通常の文字とする。
6. ルビ・傍点の中に、ルビ・傍点を入れ子にできない（エラー `TEXT_MARKUP_UNBALANCED`）。タグは入れ子にできるが、正しく閉じなければならない。
7. `markup: false` の要素では、この構文を使わず、すべてを通常の文字とする（改行のみ有効）。
