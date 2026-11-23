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
  diagnostics: ["診断", "Problems"],
  redrawn: ["ページが古かったので描き直しました。もう一度操作してください", "the page was out of date and has been redrawn; please try again"],
  noProblems: ["問題はありません", "no problems"],
  collapse: ["たたむ・広げる", "collapse / expand"],
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
:root{
  --bg:#121316;--panel:#191a1e;--panel2:#1f2025;--raised:#26272d;--line:#2a2c32;--line2:#363840;
  --text:#dcdde1;--muted:#8d9099;--faint:#5f626b;
  --accent:#8fa8ff;--accent-strong:#6f8cff;--accent-weak:rgba(143,168,255,.14);
  --sel:#f27fb8;--tail:#4fd1a5;--div:#f2c063;--ok:#7fd49a;--warn:#e8c07a;--err:#f38b82;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Osaka-Mono","Noto Sans Mono CJK JP",monospace;
  --radius:7px;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:13px/1.45 system-ui,-apple-system,"Hiragino Sans","Noto Sans CJK JP","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif;-webkit-font-smoothing:antialiased}
body.busy,body.busy *{cursor:progress!important}
::selection{background:rgba(143,168,255,.3)}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-thumb{background:#2e3036;border-radius:10px;border:3px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-thumb:hover{background:#3d4048;background-clip:content-box;border:3px solid transparent}
*::-webkit-scrollbar-corner,*::-webkit-scrollbar-track{background:transparent}

/* ---- header ---- */
header{display:flex;align-items:center;gap:14px;height:48px;padding:0 14px;background:var(--panel);border-bottom:1px solid var(--line);flex-shrink:0}
.brand{display:flex;align-items:baseline;gap:10px;min-width:0}
.brand .logo{font-weight:650;letter-spacing:.02em;color:var(--muted);font-size:12px;text-transform:lowercase}
.brand .file{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand .dirty{width:7px;height:7px;border-radius:50%;background:var(--warn);align-self:center;opacity:0;transition:opacity .2s}
body.dirty .brand .dirty{opacity:1}
.sep{width:1px;height:22px;background:var(--line)}
.tools{display:flex;gap:10px;align-items:center}
.spacer{flex:1}
.actions{display:flex;gap:12px;align-items:center}
button{font:inherit;font-size:12.5px;color:var(--text);background:transparent;border:1px solid var(--line2);border-radius:var(--radius);padding:5px 12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
button:hover{background:var(--raised);border-color:#44474f}
button:active{transform:translateY(.5px)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button.primary{background:var(--accent-strong);border-color:var(--accent-strong);color:#fff;font-weight:600}
button.primary:hover{background:var(--accent);border-color:var(--accent)}
button.icon{width:28px;height:28px;padding:0;display:grid;place-items:center;border-radius:50%;color:var(--muted)}
.seg{display:inline-flex;padding:2px;background:var(--bg);border:1px solid var(--line);border-radius:calc(var(--radius) + 2px)}
.seg button{border:0;border-radius:var(--radius);padding:4px 12px;color:var(--muted)}
.seg button:hover{background:var(--raised);color:var(--text)}
.seg button.on{background:var(--raised);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.4),inset 0 0 0 1px var(--line2)}
.seg button .k{margin-left:6px;font-size:10.5px;color:var(--faint);font-family:var(--mono)}
/* switches */
label.switch{display:flex;align-items:center;gap:7px;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap}
label.switch:hover{color:var(--text)}
label.switch input{appearance:none;-webkit-appearance:none;margin:0;width:28px;height:16px;border-radius:16px;background:var(--line2);position:relative;cursor:pointer;transition:background .2s}
label.switch input::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#c9cbd1;transition:transform .2s,background .2s}
label.switch input:checked{background:var(--accent-strong)}
label.switch input:checked::after{transform:translateX(12px);background:#fff}
label.switch input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* zoom slider */
label.zoom{display:flex;align-items:center;gap:8px;color:var(--muted)}
label.zoom output{font-family:var(--mono);font-size:11px;min-width:2.8em;color:var(--faint)}
input[type=range]{appearance:none;-webkit-appearance:none;width:120px;height:16px;background:transparent;margin:0;cursor:pointer;--val:50%}
input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:4px;background:linear-gradient(to right,var(--accent-strong) 0 var(--val),var(--line2) var(--val) 100%)}
input[type=range]::-moz-range-track{height:4px;border-radius:4px;background:var(--line2)}
input[type=range]::-moz-range-progress{height:4px;border-radius:4px;background:var(--accent-strong)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 0 3px var(--accent-weak),0 1px 3px rgba(0,0,0,.5);transition:box-shadow .15s}
input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 0 3px var(--accent-weak),0 1px 3px rgba(0,0,0,.5)}
input[type=range]:hover::-webkit-slider-thumb,input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 5px var(--accent-weak),0 1px 3px rgba(0,0,0,.5)}
input[type=range]:focus{outline:0}
/* status */
#status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);white-space:nowrap;padding:3px 10px;border-radius:20px;background:var(--bg);border:1px solid var(--line);min-width:9em}
#status::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--faint)}
#status.busy::before{background:var(--accent);animation:pulse 1s infinite ease-in-out}
#status.ok::before{background:var(--ok)}
#status.warn::before{background:var(--warn)}
#status.error{color:var(--err)}
#status.error::before{background:var(--err)}
@keyframes pulse{50%{opacity:.3}}
#banner{display:none;gap:10px;align-items:center;padding:7px 14px;background:rgba(232,192,122,.1);border-bottom:1px solid rgba(232,192,122,.25);color:var(--warn)}
#banner.show{display:flex}
#banner button{padding:3px 10px}

/* ---- main layout ---- */
#app{flex:1;min-height:0;display:grid;grid-template-columns:var(--left,36%) 1px 1fr}
#editor{display:flex;min-width:0;min-height:0;background:var(--panel)}
#gutter{overflow:hidden;padding:10px 0 200px;min-width:3.6em;text-align:right;color:var(--faint);user-select:none}
#gutter div{padding:0 10px 0 6px;border-left:2px solid transparent}
#gutter .error{color:var(--err);border-left-color:var(--err);background:rgba(243,139,130,.08)}
#gutter .warning{color:var(--warn);border-left-color:var(--warn);background:rgba(232,192,122,.07)}
#gutter .flash{color:var(--text);background:rgba(242,127,184,.18)}
#gutter,#src{font:12.5px/20px var(--mono)}
#src{flex:1;min-width:0;resize:none;border:0;outline:0;margin:0;padding:10px 12px;background:transparent;color:#cfd1d6;white-space:pre;overflow:auto;tab-size:2;caret-color:var(--accent)}
#split,#hsplit{position:relative;background:var(--line);z-index:3}
#split::after{content:"";position:absolute;inset:0 -3px;cursor:col-resize}
#hsplit{height:1px}
#hsplit::after{content:"";position:absolute;inset:-3px 0;cursor:row-resize}
#split:hover,#hsplit:hover,#split.drag,#hsplit.drag{background:var(--accent-strong)}
#right{display:grid;grid-template-rows:minmax(0,1fr) 1px min(var(--dock,180px),calc(100% - 160px));min-width:0;min-height:0}
#right.collapsed{grid-template-rows:1fr 1px 32px}
#work{min-height:0;display:grid;grid-template-columns:1fr 300px}
#pages{overflow:auto;display:flex;flex-wrap:wrap;flex-direction:row-reverse;align-content:flex-start;justify-content:center;gap:28px;padding:32px 24px;outline:0;background:var(--bg) radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px) 0 0/18px 18px}
#pages.stale{opacity:.4;filter:grayscale(.4)}
#pages .empty{color:var(--faint);align-self:center;margin:auto}
figure{margin:0}
.sheet{position:relative;height:var(--ph,80vh);background:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.05),0 10px 30px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.35)}
.sheet img{display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none}
figcaption{text-align:center;padding:8px 0 0;color:var(--faint);font-size:12px;cursor:pointer;letter-spacing:.02em}
figcaption:hover{color:var(--text)}

/* ---- overlays ---- */
.overlay{position:absolute;inset:0;width:100%;height:100%;overflow:visible;touch-action:none}
.overlay .bg{fill:transparent}
.overlay .hit{fill:transparent;cursor:pointer;stroke:transparent;vector-effect:non-scaling-stroke}
.overlay .hit:hover{stroke:var(--accent);stroke-width:1.5px;fill:rgba(143,168,255,.08)}
body.boxes .overlay .hit{stroke:rgba(143,168,255,.45);stroke-width:1px;stroke-dasharray:3 3}
.overlay .hit.ro{cursor:default}
body.placing .overlay *{cursor:crosshair!important}
.overlay .sel{pointer-events:none}
.overlay .sel .handle,.overlay .sel .rothandle,.overlay .sel .tailknob{pointer-events:all}
.overlay .selbox{fill:none;stroke:var(--sel);stroke-width:1.5px;vector-effect:non-scaling-stroke}
.overlay .selro{fill:none;stroke:var(--sel);stroke-width:1.5px;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}
.overlay .handle{fill:#fff;stroke:var(--sel);stroke-width:1.5px;vector-effect:non-scaling-stroke;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))}
.overlay .rotline{stroke:var(--sel);stroke-width:1px;vector-effect:non-scaling-stroke}
.overlay .rothandle{fill:var(--sel);stroke:#fff;stroke-width:1.5px;cursor:grab;vector-effect:non-scaling-stroke}
.overlay .tailline{stroke:var(--tail);stroke-width:1.5px;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.overlay .tailknob{fill:var(--tail);stroke:#fff;stroke-width:1.5px;cursor:move;vector-effect:non-scaling-stroke}
.overlay .label{fill:#fff;paint-order:stroke;stroke:var(--sel);stroke-width:3px;stroke-linejoin:round;font-family:system-ui,sans-serif;font-weight:600}
.overlay .ghost{opacity:.85;pointer-events:none}
.overlay .preview{fill:rgba(143,168,255,.12);stroke:var(--accent);stroke-width:1.5px;stroke-dasharray:5 4;vector-effect:non-scaling-stroke;pointer-events:none}
.overlay line.preview{fill:none}
.overlay .panel{fill:transparent;stroke:rgba(143,168,255,.5);stroke-width:1.2px;vector-effect:non-scaling-stroke;cursor:pointer}
.overlay .panel:hover{fill:rgba(143,168,255,.08);stroke:var(--accent)}
.overlay .panel.on{fill:rgba(242,127,184,.08);stroke:var(--sel);stroke-width:2.5px;cursor:move}
.overlay .panel.overlay{stroke-dasharray:6 3}
.overlay .divline{stroke:var(--div);stroke-width:1.5px;stroke-dasharray:5 4;vector-effect:non-scaling-stroke;pointer-events:none}
.overlay .divhit{stroke:transparent}
.overlay .divider:hover .divline{stroke-dasharray:none;stroke-width:2px}
.overlay .knob{fill:var(--div);stroke:#fff;stroke-width:1.5px;vector-effect:non-scaling-stroke;cursor:move}
.overlay .knob.end{fill:#fff;stroke:var(--div);cursor:crosshair}

/* ---- inspector ---- */
#inspector{overflow:auto;background:var(--panel);border-left:1px solid var(--line);padding:16px 14px}
#inspector .empty{color:var(--muted);line-height:1.7;font-size:12.5px}
#inspector .ihead{display:flex;flex-direction:column;gap:2px;margin-bottom:12px}
#inspector .kind{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
#inspector .iid{font-weight:600;font-size:14px;word-break:break-all}
#inspector .iactions{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
#inspector .iactions button{padding:4px 10px;font-size:12px}
#inspector .iactions button[data-act=remove],#inspector .iactions button[data-act=removePanel]{color:var(--err);border-color:rgba(243,139,130,.35)}
#inspector .iactions button[data-act=remove]:hover,#inspector .iactions button[data-act=removePanel]:hover{background:rgba(243,139,130,.1)}
#inspector .inote{color:var(--faint);font-size:11.5px;margin:10px 0 0;line-height:1.6}
#inspector table{width:100%;border-collapse:separate;border-spacing:0 4px}
#inspector th{text-align:left;font-weight:500;color:var(--muted);padding:5px 8px 0 0;vertical-align:top;white-space:nowrap;font-family:var(--mono);font-size:11.5px}
#inspector td{padding:0}
#inspector td.muted{color:var(--faint);font-size:11.5px;padding-top:5px}
#inspector input,#inspector textarea{width:100%;font:12px/1.5 var(--mono);color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 7px;resize:vertical;transition:border-color .15s,box-shadow .15s}
#inspector input:hover,#inspector textarea:hover{border-color:var(--line2)}
#inspector input:focus,#inspector textarea:focus{border-color:var(--accent-strong);box-shadow:0 0 0 3px var(--accent-weak);outline:0}
#inspector button.x{border:0;padding:3px 6px;margin-left:2px;color:var(--faint);border-radius:5px}
#inspector button.x:hover{color:var(--err);background:rgba(243,139,130,.1)}
#inspector .iadd{display:grid;grid-template-columns:5.5em 1fr auto;gap:6px;margin-top:10px;padding-top:12px;border-top:1px solid var(--line)}
#inspector .iadd button{padding:4px 10px}

/* ---- diagnostics dock ---- */
#dock{display:flex;flex-direction:column;min-height:0;background:var(--panel)}
#dockhead{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px 0 14px;flex-shrink:0;border-bottom:1px solid var(--line);user-select:none;cursor:default}
#right.collapsed #dockhead{border-bottom:0}
#dockhead .title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
#dcounts{display:flex;gap:14px}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted)}
.badge::before{content:"";width:7px;height:7px;border-radius:50%}
.badge.error::before{background:var(--err)}.badge.warning::before{background:var(--warn)}.badge.info::before{background:var(--accent)}
.badge.none{color:var(--faint)}.badge.none::before{background:var(--ok)}
#dockToggle{width:24px;height:24px;padding:0;border:0;color:var(--muted);font-size:14px;transition:transform .2s}
#right.collapsed #dockToggle{transform:rotate(180deg)}
#diags{flex:1;overflow:auto;padding:4px 0}
#right.collapsed #diags{display:none}
.d{display:flex;gap:10px;align-items:baseline;padding:5px 14px;cursor:default;border-left:2px solid transparent}
.d[data-line],.d[data-el]{cursor:pointer}
.d:hover{background:var(--panel2)}
.d.selected{background:rgba(242,127,184,.08);border-left-color:var(--sel)}
.d::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;transform:translateY(-1px)}
.d.error::before{background:var(--err)}.d.warning::before{background:var(--warn)}.d.info::before{background:var(--accent)}
.d .code{flex:none;font:600 11.5px var(--mono)}
.d.error .code{color:var(--err)}.d.warning .code{color:var(--warn)}.d.info .code{color:var(--accent)}
.d .at{flex:none;font:11.5px var(--mono);color:var(--faint)}
.d .msg{color:var(--text)}
.d .hint{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.dnone{padding:12px 14px;color:var(--faint)}

#toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,8px);padding:8px 16px;background:rgba(30,31,36,.92);backdrop-filter:blur(8px);border:1px solid var(--line2);color:var(--text);border-radius:20px;box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;z-index:9}
#toast.show{opacity:1;transform:translate(-50%,0)}
</style>
<header>
<div class="brand"><span class="logo">mangacli</span><span class="file">${esc(o.title)}</span><span class="dirty" title="unsaved"></span></div>
<div class="sep"></div>
<div class="tools">
<div class="seg"><button data-tool="select" title="${esc(T.toolSelectTitle)}">${esc(T.toolSelect)}<span class="k">V</span></button><button data-tool="frame" title="${esc(T.toolFrameTitle)}">${esc(T.toolFrame)}<span class="k">F</span></button></div>
<div class="seg"><button data-add="balloon">${esc(T.addBalloon)}</button><button data-add="text">${esc(T.addText)}</button></div>
</div>
<span class="spacer"></span>
<div class="actions">
<label class="switch"><input type="checkbox" id="auto" checked>${esc(T.auto)}</label>
<label class="switch"><input type="checkbox" id="boxes">${esc(T.boxes)}</label>
<label class="zoom">${esc(T.zoom)}<input type="range" id="zoom" min="30" max="200" value="80"><output id="zoomValue"></output></label>
<span id="status"></span>
<button id="render">${esc(T.rerender)}</button>
<button class="icon" title="${esc(T.help)}" aria-label="help">?</button>
<button class="primary" id="save">${esc(T.save)}</button>
</div>
</header>
<div id="banner"><span>${esc(T.external)}</span><button id="reload">${esc(T.reload)}</button><button id="keep">${esc(T.keep)}</button></div>
<div id="app">
<div id="editor"><div id="gutter"></div><textarea id="src" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea></div>
<div id="split"></div>
<div id="right">
<div id="work"><div id="pages" tabindex="-1"></div><aside id="inspector"></aside></div>
<div id="hsplit"></div>
<section id="dock"><div id="dockhead"><span class="title">${esc(T.diagnostics)}</span><span id="dcounts"></span><span class="spacer"></span><button id="dockToggle" title="${esc(T.collapse)}">▾</button></div><div id="diags"></div></section>
</div>
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
