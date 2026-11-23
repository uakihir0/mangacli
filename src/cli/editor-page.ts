// The single HTML page of `mangacli edit` (spec 12.3.12). No external scripts or styles: it works offline.

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
  noSource: ["この要素は、このファイルに書かれていません（テンプレート・インクルードなど）", "this element is not written in this file (template, include, ...)"],
  noPages: ["ページがありません", "no pages"],
  help: ["⌘/Ctrl+S 保存 · ⌘/Ctrl+Enter 再描画 · 絵の要素をクリックで該当行へ", "⌘/Ctrl+S save · ⌘/Ctrl+Enter render · click an element in a page to jump to its line"],
} as const;

/** JSON for a <script> block */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function editorPage(o: EditorPageOptions): string {
  const T = Object.fromEntries(Object.entries(MESSAGES).map(([k, v]) => [k, v[o.ja ? 0 : 1]])) as Record<keyof typeof MESSAGES, string>;
  return `<!doctype html><html lang="${o.ja ? "ja" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} — mangacli edit</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:#2b2b2b;color:#ddd;font:13px system-ui,"Hiragino Sans","Noto Sans CJK JP","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:6px 10px;background:#1e1e1e;border-bottom:1px solid #000;flex-wrap:wrap}
header .file{font-weight:600}
header .dirty{color:#ffb454;visibility:hidden}
body.dirty header .dirty{visibility:visible}
header .spacer{flex:1}
header label{display:flex;gap:4px;align-items:center;cursor:pointer}
button{font:inherit;color:#eee;background:#3c3c3c;border:1px solid #555;border-radius:4px;padding:3px 10px;cursor:pointer}
button:hover{background:#4a4a4a}
button.primary{background:#0e639c;border-color:#1177bb}
button.primary:hover{background:#1177bb}
#status{color:#aaa;min-width:14em}
#status.busy{color:#8cc8ff}#status.error{color:#ff8080}#status.ok{color:#9fdf9f}
#banner{display:none;gap:8px;align-items:center;padding:6px 10px;background:#5a4300;color:#ffe9a8}
#banner.show{display:flex}
#app{flex:1;min-height:0;display:grid;grid-template-columns:var(--left,42%) 6px 1fr}
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
#diags{max-height:30%;overflow:auto;background:#252526;border-bottom:1px solid #000}
#diags:empty{display:none}
.d{padding:3px 10px;border-bottom:1px solid #2f2f2f;cursor:default}
.d[data-line],.d[data-el]{cursor:pointer}
.d:hover{background:#2f2f33}
.d.selected{background:#4b3d16}
.d .code{font-weight:600;margin-right:6px}
.d .at{color:#888;margin-right:6px}
.d .hint{color:#999;margin-left:6px}
.d.error .code{color:#ff8080}.d.warning .code{color:#ffd480}.d.info .code{color:#8cc8ff}
#pages{flex:1;overflow:auto;display:flex;flex-wrap:wrap;flex-direction:row-reverse;align-content:flex-start;justify-content:center;gap:16px;padding:16px}
#pages.stale{opacity:.45}
#pages .empty{color:#888;align-self:center;margin:auto}
figure{margin:0}
.sheet{position:relative;height:var(--ph,80vh);box-shadow:0 2px 12px #0008;background:#fff}
.sheet img{display:block;width:100%;height:100%}
figcaption{text-align:center;padding:4px;color:#aaa}
.box{position:absolute;cursor:pointer}
.box:hover,body.boxes .box{outline:1px dashed #0e9cff88}
.box:hover{outline:2px solid #0e9cff;background:#0e9cff14}
.box.selected{outline:3px solid #ff36b1;box-shadow:0 0 0 1px #fff;background:#ff36b114}
.box .tag{display:none;position:absolute;left:0;top:-18px;padding:0 4px;font-size:11px;line-height:16px;white-space:nowrap;color:#fff;background:#0e639c;border-radius:2px;pointer-events:none}
.box:hover .tag,.box.selected .tag{display:block}
.box.selected .tag{background:#c2187a}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);padding:6px 14px;background:#000c;color:#fff;border-radius:4px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
.help{color:#777;font-size:12px}
</style>
<header>
<span class="file">${esc(o.title)}</span><span class="dirty" title="unsaved">●</span>
<button class="primary" id="save">${esc(T.save)}</button>
<button id="render">${esc(T.rerender)}</button>
<label><input type="checkbox" id="auto" checked> ${esc(T.auto)}</label>
<label><input type="checkbox" id="boxes"> ${esc(T.boxes)}</label>
<label>${esc(T.zoom)} <input type="range" id="zoom" min="30" max="200" value="80"></label>
<span id="status"></span>
<span class="spacer"></span>
<span class="help">${esc(T.help)}</span>
</header>
<div id="banner"><span>${esc(T.external)}</span><button id="reload">${esc(T.reload)}</button><button id="keep">${esc(T.keep)}</button></div>
<div id="app">
<div id="editor"><div id="gutter"></div><textarea id="src" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea></div>
<div id="split"></div>
<div id="right"><div id="diags"></div><div id="pages"></div></div>
</div>
<div id="toast"></div>
<script>
"use strict";
const T=${js(T)},TOKEN=${js(o.token)};
const $=(s)=>document.querySelector(s);
const ta=$("#src"),gutter=$("#gutter"),pagesEl=$("#pages"),diagEl=$("#diags"),statusEl=$("#status"),banner=$("#banner");
let saved="",hash="",seq=0,timer=0,selected=null,external=null,marks={},lineCount=-1,elements=[];
const api=(path,init={})=>fetch(path,{...init,headers:{...(init.headers||{}),"x-mangacli-token":TOKEN}});
const escape=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const status=(text,kind="")=>{statusEl.textContent=text;statusEl.className=kind};
let toastTimer=0;
const toast=(text)=>{const t=$("#toast");t.textContent=text;t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),2200)};

// ---- editor -------------------------------------------------------------------
const lineHeight=()=>parseFloat(getComputedStyle(ta).lineHeight)||20;
const paintGutter=(force=false)=>{
  const n=ta.value.split("\\n").length;
  if(force||n!==lineCount){
    lineCount=n;
    let h="";
    for(let i=1;i<=n;i++)h+=marks[i]?'<div class="'+marks[i]+'">'+i+"</div>":"<div>"+i+"</div>";
    gutter.innerHTML=h;
  }
  gutter.scrollTop=ta.scrollTop;
};
const dirty=()=>ta.value!==saved;
const showDirty=()=>{document.body.classList.toggle("dirty",dirty());document.title=(dirty()?"● ":"")+${js(o.title)}+" — mangacli edit"};
/** insert text at the selection, keeping the browser's undo history */
const insert=(text)=>{if(!document.execCommand("insertText",false,text))ta.setRangeText(text,ta.selectionStart,ta.selectionEnd,"end");ta.dispatchEvent(new Event("input"))};
const replaceAll=(text)=>{const top=ta.scrollTop;ta.focus({preventScroll:true});ta.select();insert(text);ta.setSelectionRange(0,0);ta.scrollTop=top;paintGutter()};
const lineStart=(line)=>{const ls=ta.value.split("\\n");let off=0;for(let i=0;i<line-1&&i<ls.length;i++)off+=ls[i].length+1;return off};
const jumpTo=(line,column)=>{
  const start=lineStart(line),text=ta.value.split("\\n")[line-1]??"";
  ta.focus({preventScroll:true});
  ta.setSelectionRange(start+Math.min(text.length,Math.max(0,(column||1)-1)),start+text.length);
  ta.scrollTop=Math.max(0,(line-1)*lineHeight()-ta.clientHeight/3);
  paintGutter();
  const row=gutter.children[line-1];
  if(row){row.classList.add("flash");setTimeout(()=>row.classList.remove("flash"),1200)}
};
const cursorLine=()=>ta.value.slice(0,ta.selectionStart).split("\\n").length;
const indentOf=(s)=>s.length-s.trimStart().length;
/** the innermost element whose YAML block holds the cursor */
const elementAtCursor=()=>{
  const cur=cursorLine(),ls=ta.value.split("\\n");
  const cands=elements.filter((e)=>e.line<=cur).sort((a,b)=>b.line-a.line||b.column-a.column);
  for(const e of cands){
    if(e.line===cur)return e.id;
    const head=ls[e.line-1]??"";
    // a flow mapping on one line ends on that line
    if(/^\\s*-?\\s*\\{.*\\}\\s*(#.*)?$/.test(head))continue;
    let inside=true;
    for(let i=e.line;i<cur;i++){const s=ls[i];if(s.trim()===""||s.trimStart().startsWith("#"))continue;if(indentOf(s)<e.column-1){inside=false;break}}
    if(inside)return e.id;
  }
  return null;
};
ta.addEventListener("input",()=>{paintGutter();showDirty();if($("#auto").checked)schedule()});
ta.addEventListener("scroll",()=>{gutter.scrollTop=ta.scrollTop});
let cursorTimer=0;
const followCursor=()=>{clearTimeout(cursorTimer);cursorTimer=setTimeout(()=>{if(document.activeElement===ta)select(elementAtCursor(),{scroll:"nearest"})},80)};
ta.addEventListener("click",followCursor);
ta.addEventListener("keyup",(e)=>{if(e.key.startsWith("Arrow")||e.key==="PageUp"||e.key==="PageDown"||e.key==="Home"||e.key==="End")followCursor()});
ta.addEventListener("keydown",(e)=>{
  const mod=e.metaKey||e.ctrlKey;
  if(mod&&e.key==="s"){e.preventDefault();save();return}
  if(mod&&e.key==="Enter"){e.preventDefault();render();return}
  if(e.isComposing)return;
  if(e.key==="Tab"){
    e.preventDefault();
    const v=ta.value,s=ta.selectionStart,en=ta.selectionEnd;
    if(s===en&&!e.shiftKey){insert("  ");return}
    // indent or outdent every selected line
    const from=v.lastIndexOf("\\n",s-1)+1,to=en>from&&v[en-1]==="\\n"?en-1:en;
    const block=v.slice(from,to).split("\\n").map((l)=>e.shiftKey?l.replace(/^ {1,2}/,""):"  "+l).join("\\n");
    ta.setSelectionRange(from,to);insert(block);ta.setSelectionRange(from,from+block.length);
    return;
  }
  if(e.key==="Enter"&&!mod&&!e.shiftKey&&!e.altKey){
    // keep the indentation; one step deeper after "key:" or "- key:"
    e.preventDefault();
    const v=ta.value,s=ta.selectionStart,line=v.slice(v.lastIndexOf("\\n",s-1)+1,s);
    let ind=line.match(/^\\s*/)[0];
    const item=line.match(/^(\\s*)- /);
    if(/:\\s*(#.*)?$/.test(line)||/:\\s*[|>][-+]?\\s*$/.test(line))ind=(item?item[1]+"  ":ind)+"  ";
    else if(item)ind=item[1]+"  ";
    insert("\\n"+ind);
  }
});
window.addEventListener("beforeunload",(e)=>{if(dirty()){e.preventDefault();e.returnValue=""}});

// ---- layout controls --------------------------------------------------------------
const split=$("#split"),app=$("#app");
const left=localStorage.getItem("mangacli-edit-left");if(left)app.style.setProperty("--left",left);
split.addEventListener("pointerdown",(e)=>{
  split.setPointerCapture(e.pointerId);
  const move=(ev)=>{const w=Math.min(Math.max(ev.clientX,200),window.innerWidth-200);app.style.setProperty("--left",w+"px")};
  const up=()=>{split.removeEventListener("pointermove",move);split.removeEventListener("pointerup",up);localStorage.setItem("mangacli-edit-left",app.style.getPropertyValue("--left"))};
  split.addEventListener("pointermove",move);split.addEventListener("pointerup",up);
});
const zoom=$("#zoom");zoom.value=localStorage.getItem("mangacli-edit-zoom")||zoom.value;
const applyZoom=()=>{document.body.style.setProperty("--ph",zoom.value+"vh");localStorage.setItem("mangacli-edit-zoom",zoom.value)};
zoom.oninput=applyZoom;applyZoom();
const boxes=$("#boxes");boxes.checked=localStorage.getItem("mangacli-edit-boxes")==="1";
const applyBoxes=()=>{document.body.classList.toggle("boxes",boxes.checked);localStorage.setItem("mangacli-edit-boxes",boxes.checked?"1":"0")};
boxes.onchange=applyBoxes;applyBoxes();
$("#save").onclick=()=>save();
$("#render").onclick=()=>render();

// ---- selection -----------------------------------------------------------------------
function select(id,{scroll=false}={}){
  selected=id;
  let first=null;
  for(const b of document.querySelectorAll(".box")){const on=b.dataset.id===id;b.classList.toggle("selected",on);if(on&&!first)first=b}
  if(first&&scroll)first.scrollIntoView({block:scroll==="nearest"?"nearest":"center",inline:"nearest",behavior:"smooth"});
}
pagesEl.addEventListener("click",(e)=>{
  const b=e.target.closest(".box");
  if(!b)return;
  select(b.dataset.id);
  for(const r of diagEl.querySelectorAll(".d"))r.classList.remove("selected");
  if(b.dataset.line)jumpTo(Number(b.dataset.line),Number(b.dataset.column));
  else toast(T.noSource);
});
diagEl.addEventListener("click",(e)=>{
  const r=e.target.closest(".d");
  if(!r)return;
  for(const x of diagEl.querySelectorAll(".d"))x.classList.toggle("selected",x===r);
  if(r.dataset.el)select(r.dataset.el,{scroll:true});
  if(r.dataset.line)jumpTo(Number(r.dataset.line),Number(r.dataset.column));
});
document.addEventListener("keydown",(e)=>{if(e.key==="Escape"){select(null);for(const x of diagEl.querySelectorAll(".d"))x.classList.remove("selected")}});

// ---- rendering -------------------------------------------------------------------------
const schedule=()=>{clearTimeout(timer);timer=setTimeout(render,500)};
async function render(){
  clearTimeout(timer);
  const my=++seq;
  status(T.rendering,"busy");
  let r;
  try{
    const res=await api("/api/render",{method:"POST",headers:{"content-type":"text/plain; charset=utf-8"},body:ta.value});
    if(!res.ok)throw new Error(String(res.status));
    r=await res.json();
  }catch{if(my===seq)status(T.disconnected,"error");return}
  if(my!==seq||r.superseded)return;
  await show(r,my);
}
const loadImage=(src)=>new Promise((ok)=>{const img=new Image();img.onload=img.onerror=()=>ok(img);img.src=src});
async function show(r,my){
  const errors=r.diagnostics.filter((d)=>d.severity==="error").length,warnings=r.diagnostics.filter((d)=>d.severity==="warning").length;
  marks={};
  for(const d of r.diagnostics)if(d.line&&!d.file&&d.severity!=="info"&&marks[d.line]!=="error")marks[d.line]=d.severity;
  paintGutter(true);
  diagEl.innerHTML=r.diagnostics.filter((d)=>d.severity!=="info").map((d)=>{
    const where=d.file?d.file+(d.line?":"+d.line:""):d.line?d.line+":"+(d.column||1):"";
    const attrs=(d.line&&!d.file?' data-line="'+d.line+'" data-column="'+(d.column||1)+'"':"")+(d.elementId?' data-el="'+escape(d.elementId)+'"':"");
    return '<div class="d '+d.severity+'"'+attrs+'><span class="code">'+escape(d.code)+"</span>"+(where?'<span class="at">'+escape(where)+"</span>":"")+escape(d.message)+(d.hint?'<span class="hint">'+escape(d.hint)+"</span>":"")+"</div>";
  }).join("");
  const counts=[r.pages.length+" "+T.pages,errors?T.errors+" "+errors:"",warnings?T.warnings+" "+warnings:"",r.ms+" ms"].filter(Boolean).join(" · ");
  if(!r.pages.length&&errors){
    pagesEl.classList.toggle("stale",!!pagesEl.querySelector("figure"));
    status(counts+(pagesEl.querySelector("figure")?" — "+T.stale:""),"error");
    return;
  }
  // load the new images before swapping them in, so the pages do not flicker
  const imgs=await Promise.all(r.pages.map((p)=>loadImage(p.src)));
  if(my!==seq)return;
  elements=[];
  const figs=r.pages.map((p,i)=>{
    const fig=document.createElement("figure"),sheet=document.createElement("div");
    sheet.className="sheet";sheet.style.aspectRatio=p.width+" / "+p.height;
    sheet.append(imgs[i]);
    // larger boxes first so that smaller ones (balloons over pictures) stay clickable on top
    for(const e of [...p.elements].sort((a,b)=>b.width*b.height-a.width*a.height)){
      if(e.line)elements.push(e);
      const b=document.createElement("div");
      b.className="box";b.dataset.id=e.id;
      if(e.line){b.dataset.line=e.line;b.dataset.column=e.column}
      Object.assign(b.style,{left:e.x/p.width*100+"%",top:e.y/p.height*100+"%",width:e.width/p.width*100+"%",height:e.height/p.height*100+"%"});
      const tag=document.createElement("span");tag.className="tag";tag.textContent=e.id+(e.line?" · "+e.line:"");
      b.append(tag);sheet.append(b);
    }
    const cap=document.createElement("figcaption");
    cap.textContent=(i+1)+" · "+p.id+(p.side&&p.side!=="single"&&p.side!=="document"?" ("+p.side+")":"")+(p.separation?" ["+p.separation+"]":"");
    fig.append(sheet,cap);
    return fig;
  });
  pagesEl.classList.remove("stale");
  if(figs.length)pagesEl.replaceChildren(...figs);
  else pagesEl.innerHTML='<div class="empty">'+escape(T.noPages)+"</div>";
  select(selected);
  status(counts,errors?"error":warnings?"":"ok");
}

// ---- saving and outside changes ------------------------------------------------------------
async function save(force=false){
  const text=ta.value;
  let res;
  try{res=await api("/api/file",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({yaml:text,base:hash,force})})}
  catch{status(T.disconnected,"error");return}
  if(res.status===409){if(confirm(T.conflict))return save(true);return}
  if(!res.ok){status(T.saveFailed+": "+((await res.json().catch(()=>({}))).error||res.status),"error");return}
  hash=(await res.json()).hash;saved=text;external=null;banner.classList.remove("show");showDirty();toast(T.saved);
}
const adopt=(d)=>{replaceAll(d.yaml);saved=ta.value;hash=d.hash;external=null;banner.classList.remove("show");showDirty();render()};
$("#reload").onclick=()=>{if(external)adopt(external)};
$("#keep").onclick=()=>banner.classList.remove("show");
const events=new EventSource("/events?token="+encodeURIComponent(TOKEN));
events.addEventListener("file",(e)=>{
  const d=JSON.parse(e.data);
  if(d.hash===hash)return;
  if(!dirty())adopt(d);
  else{external=d;banner.classList.add("show")}
});
events.addEventListener("deps",()=>render());

(async()=>{
  const s=await (await api("/api/state")).json();
  ta.value=s.yaml;saved=ta.value;hash=s.hash;
  ta.focus({preventScroll:true});ta.setSelectionRange(0,0);ta.scrollTop=0;paintGutter(true);showDirty();
  render();
})();
</script>
</html>`;
}
