// The single HTML page of `mangacli edit` (spec 12.3.12). No external scripts or styles: it works offline.

import { editorClient } from "./editor-client.js";

export interface EditorPageOptions {
  title: string;
  token: string;
  ja: boolean;
}

const MESSAGES = {
  save: ["保存", "Save"],
  saved: ["保存しました", "saved"],
  saveFailed: ["保存できませんでした", "could not save"],
  rerender: ["再描画", "Render"],
  auto: ["自動で描画", "Auto render"],
  boxes: ["要素の枠", "Element boxes"],
  zoom: ["拡大", "Zoom"],
  rendering: ["描画しています…", "rendering…"],
  pages: ["ページ", "page(s)"],
  errors: ["エラー", "error(s)"],
  warnings: ["警告", "warning(s)"],
  disconnected: ["サーバーに接続できません", "cannot reach the server"],
  stale: ["エラーのため、前回の描画結果を表示しています", "showing the previous render because of errors"],
  external: ["ファイルがエディターの外で変更されました。", "The file was changed outside the editor."],
  reload: ["ディスクの内容を読み込む", "Load from disk"],
  keep: ["編集を続ける", "Keep editing"],
  conflict: ["ディスク上のファイルが、読み込んだ後に変更されています。上書きしますか？", "The file on disk changed after it was loaded. Overwrite it?"],
  noPages: ["ページがありません", "no pages"],
  toolSelect: ["要素", "Elements"],
  toolSelectTitle: ["吹き出し・文字・絵を選んで動かす（V）", "Select and move balloons, text and art (V)"],
  toolFrame: ["コマ", "Panels"],
  toolFrameTitle: ["コマ割りを直す（F）", "Edit the panel layout (F)"],
  addBalloon: ["＋吹き出し", "+ Balloon"],
  addText: ["＋文字", "+ Text"],
  placeHint: ["置く場所をクリックしてください（Esc で取り消し）", "click where to put it (Esc to cancel)"],
  newBalloon: ["セリフ", "Line"],
  newText: ["文字", "Text"],
  help: ["⌘/Ctrl+S 保存 · ⌘/Ctrl+Z 取り消し · 矢印で 0.5 mm（Shift で 5 mm）移動 · Delete で削除", "⌘/Ctrl+S save · ⌘/Ctrl+Z undo · arrows move 0.5 mm (Shift: 5 mm) · Delete removes"],
  tailHint: ["ドラッグでしっぽの先を動かす", "drag to move the tail tip"],
  dividerHint: ["ドラッグでコマの大きさを変える", "drag to resize the panels"],
  slantHint: ["ドラッグで境界を傾ける", "drag to tilt the boundary"],
  inspectHint: ["ページ上の吹き出し・文字・絵をクリックすると、ここで値を直せます。ドラッグで移動、枠の四角で大きさ、上の丸で回転、しっぽの丸で向きを変えます。", "Click a balloon, text or art on a page to edit its values here. Drag to move it, the squares resize, the top circle rotates and the tail circle aims the tail."],
  inspectFrameHint: ["コマをクリックすると分割・削除ができます。間白の線をドラッグで大きさ、線の端で傾きを変えます。ページの余白をクリックするとページを選びます。", "Click a panel to split or remove it. Drag a gutter line to resize the panels and its ends to tilt it. Click the page margin to select the page."],
  element: ["要素", "element"],
  panel: ["コマ", "panel"],
  page: ["ページ", "page"],
  jump: ["行へ移動", "Go to line"],
  duplicate: ["複製", "Duplicate"],
  remove: ["削除", "Remove"],
  splitV: ["左右に分割", "Split left/right"],
  splitH: ["上下に分割", "Split top/bottom"],
  removePanel: ["コマを削除", "Remove panel"],
  selectPage: ["ページを選ぶ", "Select page"],
  toFree: ["自由配置に変換", "Convert to free layout"],
  addPanel: ["コマを追加", "Add panel"],
  layoutMode: ["コマ割りの形式", "layout"],
  notInFile: ["このファイルに書かれていないため、ここでは直せません（テンプレート・インクルードなど）", "this is not written in this file (template, include, …), so it cannot be edited here"],
  list: ["（リスト。テキストで編集してください）", "(a list; edit it in the text)"],
  unset: ["このキーを消す", "remove this key"],
  key: ["キー", "key"],
  value: ["値（YAML）", "value (YAML)"],
  add: ["追加", "Add"],
  inspectNote: ["文字列はそのまま、それ以外は YAML で書きます（例: [30%, 20mm]）。Enter で反映します。", "Strings as they are, other values in YAML (e.g. [30%, 20mm]). Enter applies."],
  confirmRemovePanel: ["コマ {id} を、その中の要素ごと削除しますか？（⌘/Ctrl+Z で戻せます）", "Remove panel {id} with everything in it? (⌘/Ctrl+Z undoes)"],
  cannotEdit: ["この操作はできません", "cannot do this"],
  fixErrorsFirst: ["エラーを直してから操作してください", "fix the errors first"],
} as const;

/** JSON for a <script> block */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** keys offered when adding a property in the inspector */
const KEYS = ["at", "anchor", "place", "offset", "size", "rotate", "scale", "z", "as", "who", "text", "fontSize", "font", "writing", "tail", "shape", "fill", "color", "stroke", "opacity", "clip", "contain", "id", "style", "box", "polygon", "bleed", "border", "gutter", "layout"];

export function editorPage(o: EditorPageOptions): string {
  const T = Object.fromEntries(Object.entries(MESSAGES).map(([k, v]) => [k, v[o.ja ? 0 : 1]])) as Record<keyof typeof MESSAGES, string>;
  return `<!doctype html><html lang="${o.ja ? "ja" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} — mangacli edit</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:#2b2b2b;color:#ddd;font:13px system-ui,"Hiragino Sans","Noto Sans CJK JP","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif}
body.busy,body.busy *{cursor:progress!important}
header{display:flex;gap:10px;align-items:center;padding:6px 10px;background:#1e1e1e;border-bottom:1px solid #000;flex-wrap:wrap}
header .file{font-weight:600}
header .dirty{color:#ffb454;visibility:hidden}
body.dirty header .dirty{visibility:visible}
header .spacer{flex:1}
header label{display:flex;gap:4px;align-items:center;cursor:pointer}
header .group{display:flex}
header .group button{border-radius:0}
header .group button:first-child{border-radius:4px 0 0 4px}
header .group button:last-child{border-radius:0 4px 4px 0}
button{font:inherit;color:#eee;background:#3c3c3c;border:1px solid #555;border-radius:4px;padding:3px 10px;cursor:pointer}
button:hover{background:#4a4a4a}
button.primary{background:#0e639c;border-color:#1177bb}
button.primary:hover,button.on{background:#1177bb;border-color:#3399dd}
#status{color:#aaa;min-width:12em}
#status.busy{color:#8cc8ff}#status.error{color:#ff8080}#status.ok{color:#9fdf9f}
#banner{display:none;gap:8px;align-items:center;padding:6px 10px;background:#5a4300;color:#ffe9a8}
#banner.show{display:flex}
#app{flex:1;min-height:0;display:grid;grid-template-columns:var(--left,36%) 6px 1fr}
#editor{display:flex;min-width:0;min-height:0;background:#1e1e1e}
#gutter{overflow:hidden;padding:8px 0 200px;min-width:3.5em;text-align:right;color:#6e7681;background:#1e1e1e;border-right:1px solid #333;user-select:none}
#gutter div{padding:0 8px 0 4px}
#gutter .error{color:#fff;background:#8b1e1e}
#gutter .warning{color:#000;background:#c9a227}
#gutter .flash{outline:1px solid #ff36b1}
#gutter,#src{font:13px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,"Osaka-Mono","Noto Sans Mono CJK JP",monospace}
#src{flex:1;min-width:0;resize:none;border:0;outline:0;margin:0;padding:8px 10px;background:#1e1e1e;color:#d4d4d4;white-space:pre;overflow:auto;tab-size:2;caret-color:#fff}
#split{cursor:col-resize;background:#111}
#split:hover{background:#0e639c}
#right{display:flex;flex-direction:column;min-width:0;min-height:0}
#diags{max-height:24%;overflow:auto;background:#252526;border-bottom:1px solid #000}
#diags:empty{display:none}
.d{padding:3px 10px;border-bottom:1px solid #2f2f2f;cursor:default}
.d[data-line],.d[data-el]{cursor:pointer}
.d:hover{background:#2f2f33}
.d.selected{background:#4b3d16}
.d .code{font-weight:600;margin-right:6px}
.d .at{color:#888;margin-right:6px}
.d .hint{color:#999;margin-left:6px}
.d.error .code{color:#ff8080}.d.warning .code{color:#ffd480}.d.info .code{color:#8cc8ff}
#work{flex:1;min-height:0;display:grid;grid-template-columns:1fr 300px}
#pages{overflow:auto;display:flex;flex-wrap:wrap;flex-direction:row-reverse;align-content:flex-start;justify-content:center;gap:16px;padding:24px 16px;outline:0}
#pages.stale{opacity:.45}
#pages .empty{color:#888;align-self:center;margin:auto}
figure{margin:0}
.sheet{position:relative;height:var(--ph,80vh);box-shadow:0 2px 12px #0008;background:#fff}
.sheet img{display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none}
.overlay{position:absolute;inset:0;width:100%;height:100%;overflow:visible;touch-action:none}
figcaption{text-align:center;padding:4px;color:#aaa;cursor:pointer}
figcaption:hover{color:#fff}
.overlay .bg{fill:transparent}
.overlay .hit{fill:transparent;cursor:pointer;stroke:transparent;vector-effect:non-scaling-stroke}
.overlay .hit:hover{stroke:#0e9cff;stroke-width:2px;fill:#0e9cff10}
body.boxes .overlay .hit{stroke:#0e9cff66;stroke-width:1px;stroke-dasharray:4 3}
.overlay .hit.ro{cursor:default}
body.placing .overlay *{cursor:crosshair!important}
.overlay .sel{pointer-events:none}
.overlay .sel .handle,.overlay .sel .rothandle,.overlay .sel .tailknob{pointer-events:all}
.overlay .selbox{fill:none;stroke:#ff36b1;stroke-width:2px;vector-effect:non-scaling-stroke}
.overlay .selro{fill:none;stroke:#ff36b1;stroke-width:2px;stroke-dasharray:5 3;vector-effect:non-scaling-stroke}
.overlay .handle{fill:#fff;stroke:#ff36b1;stroke-width:1.5px;vector-effect:non-scaling-stroke}
.overlay .rotline{stroke:#ff36b1;stroke-width:1px;vector-effect:non-scaling-stroke}
.overlay .rothandle{fill:#ff36b1;stroke:#fff;stroke-width:1.5px;cursor:grab;vector-effect:non-scaling-stroke}
.overlay .tailline{stroke:#00b37e;stroke-width:1.5px;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}
.overlay .tailknob{fill:#00d18f;stroke:#fff;stroke-width:1.5px;cursor:move;vector-effect:non-scaling-stroke}
.overlay .label{fill:#ff36b1;paint-order:stroke;stroke:#fff;stroke-width:3px;font-family:system-ui,sans-serif}
.overlay .ghost{opacity:.85;pointer-events:none}
.overlay .preview{fill:#0e9cff18;stroke:#0e9cff;stroke-width:2px;stroke-dasharray:6 4;vector-effect:non-scaling-stroke;pointer-events:none}
.overlay line.preview{fill:none}
.overlay .panel{fill:transparent;stroke:#0e9cff88;stroke-width:1.5px;vector-effect:non-scaling-stroke;cursor:pointer}
.overlay .panel:hover{fill:#0e9cff14;stroke:#0e9cff}
.overlay .panel.on{fill:#ff36b114;stroke:#ff36b1;stroke-width:3px;cursor:move}
.overlay .panel.overlay{stroke-dasharray:6 3}
.overlay .divline{stroke:#ff9d00;stroke-width:2px;stroke-dasharray:6 4;vector-effect:non-scaling-stroke;pointer-events:none}
.overlay .divhit{stroke:transparent}
.overlay .divider:hover .divline{stroke:#ffbf40;stroke-dasharray:none}
.overlay .knob{fill:#ff9d00;stroke:#fff;stroke-width:1.5px;vector-effect:non-scaling-stroke;cursor:move}
.overlay .knob.end{fill:#fff;stroke:#ff9d00;cursor:crosshair}
#inspector{overflow:auto;background:#252526;border-left:1px solid #000;padding:10px}
#inspector .empty{color:#999;line-height:1.6}
#inspector .ihead{font-size:14px;margin-bottom:8px}
#inspector .kind{color:#8cc8ff}
#inspector .iid{font-weight:600;word-break:break-all}
#inspector .iactions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
#inspector .inote{color:#888;font-size:12px;margin:6px 0;line-height:1.5}
#inspector table{width:100%;border-collapse:collapse}
#inspector th{text-align:left;font-weight:normal;color:#9cdcfe;padding:3px 6px 3px 0;vertical-align:top;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:12px}
#inspector td{padding:2px 0}
#inspector td.muted{color:#777;font-size:12px}
#inspector input,#inspector textarea{width:100%;font:12px ui-monospace,Menlo,monospace;color:#ddd;background:#1e1e1e;border:1px solid #444;border-radius:3px;padding:3px 5px;resize:vertical}
#inspector input:focus,#inspector textarea:focus{border-color:#0e9cff;outline:0}
#inspector button.x{padding:0 6px;margin-left:4px;color:#aaa;background:none;border:0}
#inspector button.x:hover{color:#ff8080}
#inspector .iadd{display:grid;grid-template-columns:5em 1fr auto;gap:4px;margin-top:8px}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);padding:6px 14px;background:#000c;color:#fff;border-radius:4px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9}
#toast.show{opacity:1}
.help{flex:1;min-width:0;text-align:right;color:#777;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>
<header>
<span class="file">${esc(o.title)}</span><span class="dirty" title="unsaved">●</span>
<button class="primary" id="save">${esc(T.save)}</button>
<span class="group"><button data-tool="select" title="${esc(T.toolSelectTitle)}">${esc(T.toolSelect)}</button><button data-tool="frame" title="${esc(T.toolFrameTitle)}">${esc(T.toolFrame)}</button></span>
<span class="group"><button data-add="balloon">${esc(T.addBalloon)}</button><button data-add="text">${esc(T.addText)}</button></span>
<button id="render">${esc(T.rerender)}</button>
<label><input type="checkbox" id="auto" checked> ${esc(T.auto)}</label>
<label><input type="checkbox" id="boxes"> ${esc(T.boxes)}</label>
<label>${esc(T.zoom)} <input type="range" id="zoom" min="30" max="200" value="80"></label>
<span id="status"></span>
<span class="help" title="${esc(T.help)}">${esc(T.help)}</span>
</header>
<div id="banner"><span>${esc(T.external)}</span><button id="reload">${esc(T.reload)}</button><button id="keep">${esc(T.keep)}</button></div>
<div id="app">
<div id="editor"><div id="gutter"></div><textarea id="src" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea></div>
<div id="split"></div>
<div id="right"><div id="diags"></div><div id="work"><div id="pages" tabindex="-1"></div><aside id="inspector"></aside></div></div>
</div>
<datalist id="keys">${KEYS.map((k) => `<option value="${k}">`).join("")}</datalist>
<div id="toast"></div>
<script>
"use strict";
// a helper a TypeScript loader may add to the function's source
var __name = function (f) { return f; };
(${editorClient.toString()})(${js({ T, token: o.token, title: o.title })});
</script>
</html>`;
}
