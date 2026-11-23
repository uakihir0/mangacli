// @ts-nocheck
// The browser side of `mangacli edit` (spec 12.3.12). This function is sent to the browser as source text
// (`editorClient.toString()`), so it must not use anything from this module's scope.

export function editorClient(cfg) {
  "use strict";
  const T = cfg.T;
  const TOKEN = cfg.token;
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (s) => document.querySelector(s);
  const ta = $("#src");
  const gutter = $("#gutter");
  const pagesEl = $("#pages");
  const diagEl = $("#diags");
  const statusEl = $("#status");
  const banner = $("#banner");
  const insp = $("#inspector");
  let saved = "";
  let hash = "";
  let seq = 0;
  let timer = 0;
  let external = null;
  let marks = {};
  let lineCount = -1;
  /** the last render with pages, and the pages on screen */
  let doc = null;
  let views = [];
  let tool = localStorage.getItem("mangacli-edit-tool") || "select";
  /** { kind: "element" | "panel" | "page", id } */
  let selected = null;
  let busy = false;
  let placing = null;
  let suppressAuto = false;
  let nudge = null;

  const api = (path, init = {}) => fetch(path, { ...init, headers: { ...(init.headers || {}), "x-mangacli-token": TOKEN } });
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const status = (text, kind = "") => {
    statusEl.textContent = text;
    statusEl.className = kind;
  };
  let toastTimer = 0;
  const toast = (text) => {
    const t = $("#toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  };
  const svg = (tag, attrs, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) if (attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (parent) parent.append(e);
    return e;
  };
  const typing = () => {
    const a = document.activeElement;
    return a && (a === ta || a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
  };

  // ---- text editor -----------------------------------------------------------------
  const lineHeight = () => parseFloat(getComputedStyle(ta).lineHeight) || 20;
  const paintGutter = (force = false) => {
    const n = ta.value.split("\n").length;
    if (force || n !== lineCount) {
      lineCount = n;
      let h = "";
      for (let i = 1; i <= n; i++) h += marks[i] ? '<div class="' + marks[i] + '">' + i + "</div>" : "<div>" + i + "</div>";
      gutter.innerHTML = h;
    }
    gutter.scrollTop = ta.scrollTop;
  };
  const dirty = () => ta.value !== saved;
  const showDirty = () => {
    document.body.classList.toggle("dirty", dirty());
    document.title = (dirty() ? "● " : "") + cfg.title + " — mangacli edit";
  };
  /** inserts text at the selection, keeping the browser's undo history */
  const insert = (text) => {
    if (!document.execCommand("insertText", false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input"));
  };
  /** replaces the text by changing only the part that differs (one undo step) */
  const replaceText = (next) => {
    const cur = ta.value;
    if (cur === next) return;
    let p = 0;
    while (p < cur.length && p < next.length && cur[p] === next[p]) p++;
    let s = 0;
    while (s < cur.length - p && s < next.length - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++;
    const top = ta.scrollTop;
    const back = document.activeElement;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(p, cur.length - s);
    insert(next.slice(p, next.length - s));
    ta.scrollTop = top;
    paintGutter();
    if (back && back !== ta && back.focus) back.focus({ preventScroll: true });
  };
  const lineStart = (line) => {
    const ls = ta.value.split("\n");
    let off = 0;
    for (let i = 0; i < line - 1 && i < ls.length; i++) off += ls[i].length + 1;
    return off;
  };
  const jumpTo = (line, column, focus = true) => {
    const start = lineStart(line);
    const text = ta.value.split("\n")[line - 1] ?? "";
    if (focus) ta.focus({ preventScroll: true });
    ta.setSelectionRange(start + Math.min(text.length, Math.max(0, (column || 1) - 1)), start + text.length);
    ta.scrollTop = Math.max(0, (line - 1) * lineHeight() - ta.clientHeight / 3);
    paintGutter();
    const row = gutter.children[line - 1];
    if (row) {
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1200);
    }
  };
  const cursorLine = () => ta.value.slice(0, ta.selectionStart).split("\n").length;
  const indentOf = (s) => s.length - s.trimStart().length;
  /** the innermost element whose YAML block holds the cursor */
  const elementAtCursor = () => {
    if (!doc) return null;
    const cur = cursorLine();
    const ls = ta.value.split("\n");
    const cands = Object.entries(doc.items)
      .filter(([, e]) => e.line && e.line <= cur)
      .map(([id, e]) => ({ id, line: e.line, column: e.column }))
      .sort((a, b) => b.line - a.line || b.column - a.column);
    for (const e of cands) {
      if (e.line === cur) return e.id;
      const head = ls[e.line - 1] ?? "";
      if (/^\s*-?\s*\{.*\}\s*(#.*)?$/.test(head)) continue;
      let inside = true;
      for (let i = e.line; i < cur; i++) {
        const s = ls[i];
        if (s.trim() === "" || s.trimStart().startsWith("#")) continue;
        if (indentOf(s) < e.column - 1) {
          inside = false;
          break;
        }
      }
      if (inside) return e.id;
    }
    return null;
  };
  ta.addEventListener("input", () => {
    paintGutter();
    showDirty();
    if (!suppressAuto && $("#auto").checked) schedule();
  });
  ta.addEventListener("scroll", () => (gutter.scrollTop = ta.scrollTop));
  let cursorTimer = 0;
  const followCursor = () => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      if (document.activeElement !== ta || tool !== "select") return;
      const id = elementAtCursor();
      if (id && (selected?.kind !== "element" || selected.id !== id)) select({ kind: "element", id }, { scroll: "nearest" });
    }, 120);
  };
  ta.addEventListener("click", followCursor);
  ta.addEventListener("keyup", (e) => {
    if (e.key.startsWith("Arrow") || e.key === "PageUp" || e.key === "PageDown" || e.key === "Home" || e.key === "End") followCursor();
  });
  ta.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "s") {
      e.preventDefault();
      save();
      return;
    }
    if (mod && e.key === "Enter") {
      e.preventDefault();
      render();
      return;
    }
    if (e.isComposing) return;
    if (e.key === "Tab") {
      e.preventDefault();
      const v = ta.value;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      if (s === en && !e.shiftKey) {
        insert("  ");
        return;
      }
      const from = v.lastIndexOf("\n", s - 1) + 1;
      const to = en > from && v[en - 1] === "\n" ? en - 1 : en;
      const block = v
        .slice(from, to)
        .split("\n")
        .map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, "") : "  " + l))
        .join("\n");
      ta.setSelectionRange(from, to);
      insert(block);
      ta.setSelectionRange(from, from + block.length);
      return;
    }
    if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const v = ta.value;
      const s = ta.selectionStart;
      const line = v.slice(v.lastIndexOf("\n", s - 1) + 1, s);
      let ind = line.match(/^\s*/)[0];
      const item = line.match(/^(\s*)- /);
      if (/:\s*(#.*)?$/.test(line) || /:\s*[|>][-+]?\s*$/.test(line)) ind = (item ? item[1] + "  " : ind) + "  ";
      else if (item) ind = item[1] + "  ";
      insert("\n" + ind);
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---- layout controls ----------------------------------------------------------------
  const split = $("#split");
  const app = $("#app");
  const left = localStorage.getItem("mangacli-edit-left");
  if (left) app.style.setProperty("--left", left);
  split.addEventListener("pointerdown", (e) => {
    split.setPointerCapture(e.pointerId);
    split.classList.add("drag");
    const move = (ev) => app.style.setProperty("--left", Math.min(Math.max(ev.clientX, 200), window.innerWidth - 400) + "px");
    const up = () => {
      split.classList.remove("drag");
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      split.removeEventListener("pointercancel", up);
      localStorage.setItem("mangacli-edit-left", app.style.getPropertyValue("--left"));
      drawOverlays();
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
    split.addEventListener("pointercancel", up);
  });
  // the problems dock below the pages: drag its edge to resize, click its header to fold it
  const right = $("#right");
  const hsplit = $("#hsplit");
  const dock = localStorage.getItem("mangacli-edit-dock");
  if (dock) right.style.setProperty("--dock", dock);
  right.classList.toggle("collapsed", localStorage.getItem("mangacli-edit-dock-collapsed") === "1");
  const fold = (on) => {
    right.classList.toggle("collapsed", on);
    localStorage.setItem("mangacli-edit-dock-collapsed", on ? "1" : "0");
    requestAnimationFrame(drawOverlays);
  };
  $("#dockToggle").onclick = (e) => {
    e.stopPropagation();
    fold(!right.classList.contains("collapsed"));
  };
  $("#dockhead").addEventListener("dblclick", () => fold(!right.classList.contains("collapsed")));
  hsplit.addEventListener("pointerdown", (e) => {
    hsplit.setPointerCapture(e.pointerId);
    hsplit.classList.add("drag");
    const box = right.getBoundingClientRect();
    const move = (ev) => {
      const h = Math.min(Math.max(box.bottom - ev.clientY, 60), box.height - 160);
      right.classList.remove("collapsed");
      right.style.setProperty("--dock", h + "px");
    };
    const up = () => {
      hsplit.classList.remove("drag");
      hsplit.removeEventListener("pointermove", move);
      hsplit.removeEventListener("pointerup", up);
      hsplit.removeEventListener("pointercancel", up);
      localStorage.setItem("mangacli-edit-dock", right.style.getPropertyValue("--dock"));
      localStorage.setItem("mangacli-edit-dock-collapsed", "0");
      drawOverlays();
    };
    hsplit.addEventListener("pointermove", move);
    hsplit.addEventListener("pointerup", up);
    hsplit.addEventListener("pointercancel", up);
  });
  document.querySelector("button.icon").onclick = () => toast(T.help);
  const zoom = $("#zoom");
  zoom.value = localStorage.getItem("mangacli-edit-zoom") || zoom.value;
  const applyZoom = () => {
    document.body.style.setProperty("--ph", zoom.value + "vh");
    zoom.style.setProperty("--val", ((zoom.value - zoom.min) / (zoom.max - zoom.min)) * 100 + "%");
    $("#zoomValue").textContent = zoom.value + "%";
    localStorage.setItem("mangacli-edit-zoom", zoom.value);
    requestAnimationFrame(drawOverlays);
  };
  zoom.oninput = applyZoom;
  applyZoom();
  const boxes = $("#boxes");
  boxes.checked = localStorage.getItem("mangacli-edit-boxes") === "1";
  const applyBoxes = () => {
    document.body.classList.toggle("boxes", boxes.checked);
    localStorage.setItem("mangacli-edit-boxes", boxes.checked ? "1" : "0");
  };
  boxes.onchange = applyBoxes;
  applyBoxes();
  $("#save").onclick = () => save();
  $("#render").onclick = () => render();
  const setTool = (t) => {
    tool = t;
    placing = null;
    localStorage.setItem("mangacli-edit-tool", t);
    for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === t);
    document.body.classList.toggle("placing", false);
    if (selected && (t === "frame") !== (selected.kind !== "element")) select(null);
    drawOverlays();
  };
  for (const b of document.querySelectorAll("[data-tool]")) b.onclick = () => setTool(b.dataset.tool);
  for (const b of document.querySelectorAll("[data-add]"))
    b.onclick = () => {
      if (tool !== "select") setTool("select");
      placing = placing === b.dataset.add ? null : b.dataset.add;
      document.body.classList.toggle("placing", !!placing);
      if (placing) toast(T.placeHint);
    };
  setTool(tool);
  window.addEventListener("resize", () => requestAnimationFrame(drawOverlays));

  // ---- geometry -------------------------------------------------------------------------
  const rot = (p, c, a) => {
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    return { x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs };
  };
  const inPoly = (p, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const toPx = (v, p) => ({ x: p.x * v.page.transform.scale + v.page.transform.x, y: p.y * v.page.transform.scale + v.page.transform.y });
  const toMm = (v, p) => ({ x: (p.x - v.page.transform.x) / v.page.transform.scale, y: (p.y - v.page.transform.y) / v.page.transform.scale });
  /** image pixels per screen pixel */
  const unit = (v) => v.page.width / (v.svg.getBoundingClientRect().width || 1);
  const pointer = (v, e) => {
    const r = v.svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * v.page.width) / r.width, y: ((e.clientY - r.top) * v.page.height) / r.height };
  };
  const ptsAttr = (pts) => pts.map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ");

  /** a pointer drag on an overlay; a press without movement is a click */
  const drag = (v, e, h) => {
    e.preventDefault();
    e.stopPropagation();
    // keys now go to the page (arrows move the selection), not to the text box
    if (typing()) document.activeElement.blur();
    const start = pointer(v, e);
    const k = unit(v);
    let moved = false;
    const target = v.svg;
    target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const p = pointer(v, ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3 * k) return;
      moved = true;
      h.move?.(p, start, ev);
    };
    const up = (ev) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      if (moved) h.end?.(pointer(v, ev), start, ev);
      else h.click?.(ev);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  // ---- overlays -----------------------------------------------------------------------------
  function drawOverlays() {
    for (const v of views) {
      v.svg.replaceChildren();
      v.svg.setAttribute("viewBox", "0 0 " + v.page.width + " " + v.page.height);
      if (!doc) continue;
      if (tool === "frame") drawFrame(v);
      else drawElements(v);
    }
  }

  function drawElements(v) {
    const k = unit(v);
    const g = svg("g", {}, v.svg);
    // page background: clicking it selects nothing (or places a new element)
    const bg = svg("rect", { x: 0, y: 0, width: v.page.width, height: v.page.height, class: "bg" }, g);
    bg.addEventListener("pointerdown", (e) => {
      if (placing) return place(v, e);
      drag(v, e, { click: () => select(null) });
    });
    const els = [...v.page.elements].sort((a, b) => b.width * b.height - a.width * a.height);
    for (const e of els) {
      const it = doc.items[e.id];
      const r = svg("rect", { x: e.x, y: e.y, width: e.width, height: e.height, class: "hit" + (it && it.editable ? "" : " ro") }, g);
      const title = svg("title", {}, r);
      title.textContent = e.id + (e.line ? " · " + e.line : "");
      r.addEventListener("pointerdown", (ev) => {
        if (placing) return place(v, ev);
        if (!it) return;
        const already = selected?.kind === "element" && selected.id === e.id;
        if (!already) select({ kind: "element", id: e.id }, { jump: true });
        if (it.editable && it.edit) moveDrag(v, ev, e.id, already);
        else drag(v, ev, {});
      });
    }
    if (selected?.kind === "element") drawSelection(v, selected.id, k);
  }

  function selectionBox(it) {
    const b = it.edit.box;
    const c = it.edit.pivot;
    return [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ].map((p) => rot(p, c, it.edit.rotate));
  }

  function drawSelection(v, id, k) {
    const it = doc.items[id];
    const box = v.page.elements.find((e) => e.id === id);
    if (!it || it.page !== v.page.id) return;
    const g = svg("g", { class: "sel" }, v.svg);
    v.selection = g;
    if (!it.edit || !it.editable) {
      if (box) svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, class: "selro" }, g);
      return;
    }
    const corners = selectionBox(it).map((p) => toPx(v, p));
    svg("polygon", { points: ptsAttr(corners), class: "selbox" }, g);
    const hs = 8 * k;
    const theta = it.edit.rotate;
    const handles = [
      [0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5],
    ];
    const b = it.edit.box;
    for (const [hx, hy] of handles) {
      const p = toPx(v, rot({ x: b.x + b.w * hx, y: b.y + b.h * hy }, it.edit.pivot, theta));
      const r = svg("rect", { x: p.x - hs / 2, y: p.y - hs / 2, width: hs, height: hs, class: "handle", style: "cursor:" + resizeCursor(hx, hy, theta) }, g);
      r.addEventListener("pointerdown", (e) => resizeDrag(v, e, id, hx, hy));
    }
    // rotation handle above the top edge
    const top = toPx(v, rot({ x: b.x + b.w / 2, y: b.y }, it.edit.pivot, theta));
    const up = { x: Math.sin(theta), y: -Math.cos(theta) };
    const rp = { x: top.x + up.x * 26 * k, y: top.y + up.y * 26 * k };
    svg("line", { x1: top.x, y1: top.y, x2: rp.x, y2: rp.y, class: "rotline" }, g);
    const rc = svg("circle", { cx: rp.x, cy: rp.y, r: 5 * k, class: "rothandle" }, g);
    rc.addEventListener("pointerdown", (e) => rotateDrag(v, e, id));
    // tails
    (it.edit.tails || []).forEach((t) => {
      const a = toPx(v, t.root);
      const p = toPx(v, t.tip);
      svg("line", { x1: a.x, y1: a.y, x2: p.x, y2: p.y, class: "tailline" }, g);
      const c = svg("circle", { cx: p.x, cy: p.y, r: 6 * k, class: "tailknob" }, g);
      const tt = svg("title", {}, c);
      tt.textContent = T.tailHint;
      c.addEventListener("pointerdown", (e) => tailDrag(v, e, id, t));
    });
    const label = svg("text", { x: corners[0].x, y: corners[0].y - 6 * k, class: "label", "font-size": 11 * k }, g);
    label.textContent = id;
  }

  const resizeCursor = (hx, hy, theta) => {
    if (hx === 0.5 && hy === 0.5) return "move";
    const a = (Math.atan2(hy - 0.5, hx - 0.5) + theta) * (180 / Math.PI);
    const n = ((Math.round(a / 45) % 4) + 4) % 4;
    return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][n];
  };

  function ghost(v, id) {
    const e = v.page.elements.find((x) => x.id === id);
    if (!e) return null;
    const g = svg("g", { class: "ghost" }, v.svg);
    const cid = "clip-" + Math.random().toString(36).slice(2);
    const cp = svg("clipPath", { id: cid }, g);
    svg("rect", { x: e.x, y: e.y, width: e.width, height: e.height }, cp);
    svg("image", { href: v.img.src, x: 0, y: 0, width: v.page.width, height: v.page.height, "clip-path": "url(#" + cid + ")", preserveAspectRatio: "none" }, g);
    return g;
  }

  function moveDrag(v, e, id, wasSelected) {
    const it = doc.items[id];
    let gh = null;
    drag(v, e, {
      move: (p, s, ev) => {
        gh ??= ghost(v, id);
        let dx = p.x - s.x;
        let dy = p.y - s.y;
        if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        const tr = "translate(" + dx + " " + dy + ")";
        gh?.setAttribute("transform", tr);
        v.selection?.setAttribute("transform", tr);
      },
      end: (p, s, ev) => {
        let dx = (p.x - s.x) / v.page.transform.scale;
        let dy = (p.y - s.y) / v.page.transform.scale;
        if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        op({ op: "move", id, dx, dy }, it.page);
      },
      click: () => {
        if (wasSelected) jumpToItem(id);
      },
    });
  }

  function resizeDrag(v, e, id, hx, hy) {
    const it = doc.items[id];
    const b0 = it.edit.box;
    const theta = it.edit.rotate;
    let preview = null;
    const compute = (p, s, ev) => {
      const d = rot({ x: (p.x - s.x) / v.page.transform.scale, y: (p.y - s.y) / v.page.transform.scale }, { x: 0, y: 0 }, -theta);
      let x0 = b0.x;
      let y0 = b0.y;
      let x1 = b0.x + b0.w;
      let y1 = b0.y + b0.h;
      if (hx === 0) x0 += d.x;
      if (hx === 1) x1 += d.x;
      if (hy === 0) y0 += d.y;
      if (hy === 1) y1 += d.y;
      let w = Math.max(2, x1 - x0);
      let h = Math.max(2, y1 - y0);
      if (it.edit.keepAspect !== ev.shiftKey) {
        const f = hx === 0.5 ? h / b0.h : hy === 0.5 ? w / b0.w : Math.max(w / b0.w, h / b0.h);
        w = b0.w * f;
        h = b0.h * f;
      }
      // the opposite side stays where it was
      const x = hx === 0 ? b0.x + b0.w - w : hx === 1 ? b0.x : b0.x + (b0.w - w) / 2;
      const y = hy === 0 ? b0.y + b0.h - h : hy === 1 ? b0.y : b0.y + (b0.h - h) / 2;
      return { x, y, w, h };
    };
    drag(v, e, {
      move: (p, s, ev) => {
        const nb = compute(p, s, ev);
        const pts = [
          { x: nb.x, y: nb.y },
          { x: nb.x + nb.w, y: nb.y },
          { x: nb.x + nb.w, y: nb.y + nb.h },
          { x: nb.x, y: nb.y + nb.h },
        ].map((q) => toPx(v, rot(q, it.edit.pivot, theta)));
        preview ??= svg("polygon", { class: "preview" }, v.svg);
        preview.setAttribute("points", ptsAttr(pts));
      },
      end: (p, s, ev) => op({ op: "resize", id, box: compute(p, s, ev) }, it.page),
    });
  }

  function rotateDrag(v, e, id) {
    const it = doc.items[id];
    const c = toPx(v, it.edit.pivot);
    const angle = (p, s, ev) => {
      let a = it.edit.rotate + Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(s.y - c.y, s.x - c.x);
      let d = (a * 180) / Math.PI;
      if (ev.shiftKey) d = Math.round(d / 15) * 15;
      return d;
    };
    drag(v, e, {
      move: (p, s, ev) => {
        const d = angle(p, s, ev) - (it.edit.rotate * 180) / Math.PI;
        v.selection?.setAttribute("transform", "rotate(" + d + " " + c.x + " " + c.y + ")");
        status(Math.round(angle(p, s, ev)) + "°", "busy");
      },
      end: (p, s, ev) => op({ op: "rotate", id, deg: angle(p, s, ev) }, it.page),
    });
  }

  function tailDrag(v, e, id, tail) {
    const it = doc.items[id];
    const index = tail.index;
    const root = toPx(v, tail.root);
    let line = null;
    drag(v, e, {
      move: (p) => {
        line ??= svg("line", { class: "preview" }, v.svg);
        line.setAttribute("x1", root.x);
        line.setAttribute("y1", root.y);
        line.setAttribute("x2", p.x);
        line.setAttribute("y2", p.y);
      },
      end: (p) => op({ op: "tail", id, index, tip: toMm(v, p) }, it.page),
    });
  }

  function place(v, e) {
    e.preventDefault();
    e.stopPropagation();
    const kind = placing;
    placing = null;
    document.body.classList.remove("placing");
    const at = toMm(v, pointer(v, e));
    const L = doc.layouts[v.page.id];
    const panels = (L?.panels || []).slice().sort((a, b) => Number(b.overlay) - Number(a.overlay));
    const panel = panels.find((p) => p.polygon.length > 2 && inPoly(at, p.polygon));
    op({ op: "add", page: v.page.id, panel: panel?.id, kind, at, text: kind === "balloon" ? T.newBalloon : T.newText }, v.page.id);
  }

  // ---- panels ---------------------------------------------------------------------------------
  function drawFrame(v) {
    const L = doc.layouts[v.page.id];
    const k = unit(v);
    const g = svg("g", { class: "frame" }, v.svg);
    const bg = svg("rect", { x: 0, y: 0, width: v.page.width, height: v.page.height, class: "bg" }, g);
    bg.addEventListener("pointerdown", (e) => drag(v, e, { click: () => select({ kind: "page", id: v.page.id }) }));
    if (!L) return;
    const free = L.mode === "free";
    for (const pn of L.panels) {
      if (pn.polygon.length < 3) continue;
      const pts = pn.polygon.map((p) => toPx(v, p));
      const on = selected?.kind === "panel" && selected.id === pn.id;
      const poly = svg("polygon", { points: ptsAttr(pts), class: "panel" + (on ? " on" : "") + (pn.overlay ? " overlay" : "") }, g);
      const tt = svg("title", {}, poly);
      tt.textContent = pn.id;
      poly.addEventListener("pointerdown", (e) => {
        if (!on) select({ kind: "panel", id: pn.id }, { jump: true });
        if ((free || pn.overlay) && pn.editable && on) panelMoveDrag(v, e, pn);
        else drag(v, e, {});
      });
    }
    if (L.editable) {
      L.dividers.forEach((d, i) => drawDivider(v, g, d, i, k));
      L.lines.forEach((l, i) => {
        for (const end of [0, 1]) {
          const p = toPx(v, end ? l.b : l.a);
          const c = svg("circle", { cx: p.x, cy: p.y, r: 6 * k, class: "knob end" }, g);
          c.addEventListener("pointerdown", (e) => knobDrag(v, e, (q) => ({ op: "line", page: v.page.id, index: i, end, point: toMm(v, q) })));
        }
        const a = toPx(v, l.a);
        const b = toPx(v, l.b);
        svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "divline" }, g);
      });
    }
    const sel = selected?.kind === "panel" ? L.panels.find((p) => p.id === selected.id) : null;
    if (sel && (free || sel.overlay) && sel.editable) {
      shapeOf(sel).forEach((q, i) => {
        const p = toPx(v, q);
        const r = svg("rect", { x: p.x - 4.5 * k, y: p.y - 4.5 * k, width: 9 * k, height: 9 * k, class: "handle" }, g);
        r.addEventListener("pointerdown", (e) => vertexDrag(v, e, sel, i));
      });
    }
  }

  function drawDivider(v, g, d, i, k) {
    const a = toPx(v, d.a);
    const b = toPx(v, d.b);
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const lg = svg("g", { class: "divider" }, g);
    svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "divline" }, lg);
    const hit = svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "divhit", "stroke-width": 14 * k, style: "cursor:" + (d.axis === "y" ? "ns-resize" : "ew-resize") }, lg);
    const tt = svg("title", {}, hit);
    tt.textContent = T.dividerHint;
    const mid = svg("circle", { cx: m.x, cy: m.y, r: 6 * k, class: "knob" }, lg);
    const moveIt = (e) => {
      const s0 = d.axis === "y" ? "y" : "x";
      drag(v, e, {
        move: (p, s) => lg.setAttribute("transform", d.axis === "y" ? "translate(0 " + (p.y - s.y) + ")" : "translate(" + (p.x - s.x) + " 0)"),
        end: (p, s) => op({ op: "divider", page: v.page.id, index: i, delta: (p[s0] - s[s0]) / v.page.transform.scale }, v.page.id),
      });
    };
    hit.addEventListener("pointerdown", moveIt);
    mid.addEventListener("pointerdown", moveIt);
    // the ends tilt the boundary about its middle
    for (const end of [0, 1]) {
      const p = end ? b : a;
      const c = svg("rect", { x: p.x - 5 * k, y: p.y - 5 * k, width: 10 * k, height: 10 * k, class: "knob end" }, lg);
      const tt2 = svg("title", {}, c);
      tt2.textContent = T.slantHint;
      c.addEventListener("pointerdown", (e) => {
        let line = null;
        const slantOf = (q, s) => {
          const dd = d.axis === "y" ? (q.y - s.y) / v.page.transform.scale : (q.x - s.x) / v.page.transform.scale;
          return d.slant + (end ? 2 : -2) * dd;
        };
        drag(v, e, {
          move: (q, s) => {
            const sl = slantOf(q, s) * v.page.transform.scale;
            line ??= svg("line", { class: "preview" }, v.svg);
            const A = d.axis === "y" ? { x: a.x, y: m.y - sl / 2 } : { x: m.x - sl / 2, y: a.y };
            const B = d.axis === "y" ? { x: b.x, y: m.y + sl / 2 } : { x: m.x + sl / 2, y: b.y };
            line.setAttribute("x1", A.x);
            line.setAttribute("y1", A.y);
            line.setAttribute("x2", B.x);
            line.setAttribute("y2", B.y);
          },
          end: (q, s) => op({ op: "slant", page: v.page.id, index: i, slant: slantOf(q, s) }, v.page.id),
        });
      });
    }
  }

  function knobDrag(v, e, make) {
    let mark = null;
    drag(v, e, {
      move: (p) => {
        mark ??= svg("circle", { r: 5 * unit(v), class: "preview" }, v.svg);
        mark.setAttribute("cx", p.x);
        mark.setAttribute("cy", p.y);
      },
      end: (p) => op(make(p), v.page.id),
    });
  }

  const isRect = (pts) => {
    if (pts.length !== 4) return false;
    const xs = new Set(pts.map((p) => p.x.toFixed(2)));
    const ys = new Set(pts.map((p) => p.y.toFixed(2)));
    return xs.size === 2 && ys.size === 2;
  };

  /** a panel's own shape, before bleed extends it: what `box` / `polygon` describe */
  const shapeOf = (pn) => (pn.shape && pn.shape.length > 2 ? pn.shape : pn.polygon);

  function panelMoveDrag(v, e, pn) {
    let preview = null;
    const shifted = (p, s) => shapeOf(pn).map((q) => ({ x: q.x + (p.x - s.x) / v.page.transform.scale, y: q.y + (p.y - s.y) / v.page.transform.scale }));
    drag(v, e, {
      move: (p, s) => {
        preview ??= svg("polygon", { class: "preview" }, v.svg);
        preview.setAttribute("points", ptsAttr(shifted(p, s).map((q) => toPx(v, q))));
      },
      end: (p, s) => {
        const pts = shifted(p, s);
        op({ op: "panelShape", panel: pn.id, points: pts, box: isRect(shapeOf(pn)) }, v.page.id);
      },
    });
  }

  function vertexDrag(v, e, pn, i) {
    let preview = null;
    const rect = isRect(shapeOf(pn));
    const moved = (p, ev) => {
      const q = toMm(v, p);
      const pts = shapeOf(pn).map((x) => ({ ...x }));
      if (rect && !ev.altKey) {
        // a box keeps its right angles: the corners beside the dragged one follow it
        const o = pts[i];
        for (const r of pts) {
          if (Math.abs(r.x - o.x) < 0.01) r.x = q.x;
          if (Math.abs(r.y - o.y) < 0.01) r.y = q.y;
        }
      } else pts[i] = q;
      return pts;
    };
    drag(v, e, {
      move: (p, s, ev) => {
        preview ??= svg("polygon", { class: "preview" }, v.svg);
        preview.setAttribute("points", ptsAttr(moved(p, ev).map((q) => toPx(v, q))));
      },
      end: (p, s, ev) => op({ op: "panelShape", panel: pn.id, points: moved(p, ev), box: rect && !ev.altKey }, v.page.id),
    });
  }

  // ---- selection and the inspector ------------------------------------------------------------
  function jumpToItem(id) {
    const it = doc?.items[id];
    if (it?.line) jumpTo(it.line, it.column, false);
  }

  function select(target, o = {}) {
    selected = target;
    for (const r of diagEl.querySelectorAll(".d")) r.classList.remove("selected");
    drawOverlays();
    if (target && o.jump) {
      const info = target.kind === "element" ? doc?.items[target.id] : target.kind === "panel" ? Object.values(doc?.layouts || {}).flatMap((l) => l.panels).find((p) => p.id === target.id) : { line: doc?.layouts[target.id]?.line };
      if (info?.line) jumpTo(info.line, info.column, false);
    }
    if (target && o.scroll) {
      const v = views.find((x) => x.selection);
      v?.selection?.scrollIntoView?.({ block: o.scroll === "nearest" ? "nearest" : "center", inline: "nearest", behavior: "smooth" });
    }
    inspect();
  }

  let inspectSeq = 0;
  async function inspect() {
    const my = ++inspectSeq;
    if (!selected) {
      insp.innerHTML = '<div class="empty">' + escape(tool === "frame" ? T.inspectFrameHint : T.inspectHint) + "</div>";
      return;
    }
    let j;
    try {
      const res = await post("/api/inspect", { yaml: ta.value, target: selected });
      if (!res.ok) return;
      j = await res.json();
    } catch {
      return;
    }
    if (my !== inspectSeq) return;
    const target = selected;
    const kindLabel = target.kind === "element" ? doc?.items[target.id]?.type || T.element : target.kind === "panel" ? T.panel : T.page;
    const L = target.kind === "page" ? doc?.layouts[target.id] : target.kind === "panel" ? Object.values(doc?.layouts || {}).find((l) => l.panels.some((p) => p.id === target.id)) : null;
    const h = [];
    h.push('<div class="ihead"><span class="kind">' + escape(kindLabel) + '</span> <span class="iid">' + escape(target.id) + "</span></div>");
    const actions = [];
    if (target.kind === "element") actions.push(["jump", T.jump], ["duplicate", T.duplicate], ["remove", T.remove]);
    if (target.kind === "panel") {
      actions.push(["splitV", T.splitV], ["splitH", T.splitH], ["removePanel", T.removePanel], ["page", T.selectPage]);
    }
    if (target.kind === "page") {
      if (L && L.mode !== "free") actions.push(["toFree", T.toFree]);
      if (L && L.mode === "free") actions.push(["addPanel", T.addPanel]);
    }
    if (j.editable) h.push('<div class="iactions">' + actions.map(([a, label]) => '<button data-act="' + a + '">' + escape(label) + "</button>").join("") + "</div>");
    if (L && target.kind === "page") h.push('<div class="inote">' + escape(T.layoutMode) + ": " + escape(L.mode) + "</div>");
    if (!j.editable) {
      h.push('<div class="empty">' + escape(T.notInFile) + "</div>");
      insp.innerHTML = h.join("");
      return;
    }
    const hidden = target.kind === "page" ? ["panels", "layers"] : target.kind === "panel" ? ["layers", "dialogue"] : ["children"];
    h.push('<table class="props">');
    for (const p of j.pairs) {
      if (hidden.includes(p.key)) {
        h.push('<tr><th>' + escape(p.key) + '</th><td class="muted" colspan="2">' + escape(T.list) + "</td></tr>");
        continue;
      }
      const isString = p.string !== undefined;
      const value = isString ? p.string : p.yaml;
      const multi = isString && (value.includes("\n") || value.length > 24);
      const field = multi
        ? '<textarea data-key="' + escape(p.key) + '" data-kind="string" rows="' + Math.min(6, value.split("\n").length + (value.length > 24 ? 1 : 0)) + '">' + escape(value) + "</textarea>"
        : '<input data-key="' + escape(p.key) + '" data-kind="' + (isString ? "string" : "yaml") + '" value="' + escape(value) + '">';
      h.push("<tr><th>" + escape(p.key) + "</th><td>" + field + '</td><td><button class="x" data-unset="' + escape(p.key) + '" title="' + escape(T.unset) + '">×</button></td></tr>');
    }
    h.push("</table>");
    h.push('<div class="iadd"><input id="newKey" placeholder="' + escape(T.key) + '" list="keys"><input id="newValue" placeholder="' + escape(T.value) + '"><button id="addKey">' + escape(T.add) + "</button></div>");
    h.push('<div class="inote">' + escape(T.inspectNote) + "</div>");
    insp.innerHTML = h.join("");
    for (const f of insp.querySelectorAll("[data-key]")) {
      const commit = () => {
        const key = f.dataset.key;
        const o = { op: "set", target, key: [key] };
        if (f.dataset.kind === "string") o.string = f.value;
        else o.yaml = f.value;
        op(o, pageOfTarget(target));
      };
      f.addEventListener("change", commit);
      f.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (f.tagName === "INPUT" || e.metaKey || e.ctrlKey) && !e.isComposing) {
          e.preventDefault();
          f.blur();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          inspect();
        }
      });
    }
    for (const b of insp.querySelectorAll("[data-unset]")) b.onclick = () => op({ op: "unset", target, key: [b.dataset.unset] }, pageOfTarget(target));
    $("#addKey").onclick = () => {
      const key = $("#newKey").value.trim();
      if (!key) return;
      op({ op: "set", target, key: [key], yaml: $("#newValue").value || "null" }, pageOfTarget(target));
    };
    $("#newValue").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) $("#addKey").click();
    });
    for (const b of insp.querySelectorAll("[data-act]")) b.onclick = () => action(b.dataset.act, target);
  }

  const pageOfTarget = (t) => (t.kind === "element" ? doc?.items[t.id]?.page : t.kind === "page" ? t.id : Object.entries(doc?.layouts || {}).find(([, l]) => l.panels.some((p) => p.id === t.id))?.[0]);

  function action(a, t) {
    const page = pageOfTarget(t);
    if (a === "jump") return jumpToItem(t.id);
    if (a === "duplicate") return op({ op: "duplicate", id: t.id }, page);
    if (a === "remove") return removeSelected();
    if (a === "splitV") return op({ op: "splitPanel", panel: t.id, dir: "v" }, page);
    if (a === "splitH") return op({ op: "splitPanel", panel: t.id, dir: "h" }, page);
    if (a === "removePanel") return removeSelected();
    if (a === "page") return select({ kind: "page", id: page });
    if (a === "toFree") return op({ op: "toFree", page }, page);
    if (a === "addPanel") return op({ op: "addPanel", page }, page);
  }

  function removeSelected() {
    if (!selected) return;
    const t = selected;
    if (t.kind === "element") {
      select(null);
      return op({ op: "remove", id: t.id }, doc?.items[t.id]?.page);
    }
    if (t.kind === "panel" && confirm(T.confirmRemovePanel.replace("{id}", t.id))) {
      const page = pageOfTarget(t);
      select(null);
      return op({ op: "removePanel", panel: t.id }, page);
    }
  }

  // ---- operations ------------------------------------------------------------------------------
  /** sends an edit to the server, applies the new text and renders the page it touched */
  async function op(o, page) {
    if (busy) return;
    busy = true;
    document.body.classList.add("busy");
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
          res = await post("/api/op", { yaml: ta.value, op: o });
        } catch {
          status(T.disconnected, "error");
          return;
        }
        if (res.status === 409) {
          // the page on screen is older than the text: draw it again, and let the user aim again
          // (ids and positions from the old picture may now name something else)
          toast((await render()) ? T.redrawn : T.fixErrorsFirst);
          return;
        }
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast(T.cannotEdit + (j.error ? ": " + j.error : ""));
          drawOverlays();
          return;
        }
        suppressAuto = true;
        try {
          replaceText(j.yaml);
        } finally {
          suppressAuto = false;
        }
        showDirty();
        await render(j.pages || (page ? [page] : undefined));
        return;
      }
    } finally {
      busy = false;
      document.body.classList.remove("busy");
      if (nudge) {
        const n = nudge;
        nudge = null;
        if (doc?.items[n.id]) op({ op: "move", id: n.id, dx: n.dx, dy: n.dy }, doc.items[n.id].page);
      }
    }
  }

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      if (placing) {
        placing = null;
        document.body.classList.remove("placing");
        return;
      }
      if (!typing()) select(null);
      return;
    }
    if (typing()) return;
    if (mod && e.key.toLowerCase() === "z") {
      // the text box holds the history of every edit, including the ones made on the page
      e.preventDefault();
      const back = document.activeElement;
      ta.focus({ preventScroll: true });
      document.execCommand(e.shiftKey ? "redo" : "undo");
      if (back && back !== ta && back.focus) back.focus({ preventScroll: true });
      else ta.blur();
      return;
    }
    if (mod && e.key === "s") {
      e.preventDefault();
      save();
      return;
    }
    if (mod && e.key === "d" && selected?.kind === "element") {
      e.preventDefault();
      op({ op: "duplicate", id: selected.id }, doc?.items[selected.id]?.page);
      return;
    }
    if (mod) return;
    if (e.key === "v" || e.key === "V") return setTool("select");
    if (e.key === "f" || e.key === "F") return setTool("frame");
    if ((e.key === "Delete" || e.key === "Backspace") && selected && selected.kind !== "page") {
      e.preventDefault();
      removeSelected();
      return;
    }
    if (e.key.startsWith("Arrow") && selected?.kind === "element" && doc?.items[selected.id]?.edit) {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 0.5;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      if (busy) {
        // presses during a render are added up and sent together
        nudge = nudge && nudge.id === selected.id ? { id: selected.id, dx: nudge.dx + dx, dy: nudge.dy + dy } : { id: selected.id, dx, dy };
        return;
      }
      op({ op: "move", id: selected.id, dx, dy }, doc.items[selected.id].page);
    }
  });

  diagEl.addEventListener("click", (e) => {
    const r = e.target.closest(".d");
    if (!r) return;
    if (r.dataset.el && doc?.items[r.dataset.el]) {
      if (tool !== "select") setTool("select");
      select({ kind: "element", id: r.dataset.el }, { scroll: true });
    }
    for (const x of diagEl.querySelectorAll(".d")) x.classList.toggle("selected", x === r);
    if (r.dataset.line) jumpTo(Number(r.dataset.line), Number(r.dataset.column));
  });

  // ---- rendering --------------------------------------------------------------------------------
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => render(), 500);
  };
  async function render(pages) {
    clearTimeout(timer);
    const my = ++seq;
    status(T.rendering, "busy");
    let r;
    try {
      const res = await api("/api/render" + (pages ? "?pages=" + encodeURIComponent(pages.join(",")) : ""), { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: ta.value });
      if (!res.ok) throw new Error(String(res.status));
      r = await res.json();
    } catch {
      if (my === seq) status(T.disconnected, "error");
      return false;
    }
    if (my !== seq || r.superseded) return false;
    return show(r, my);
  }
  const loadImage = (src) =>
    new Promise((ok) => {
      const img = new Image();
      img.onload = img.onerror = () => ok(img);
      img.src = src;
    });
  async function show(r, my) {
    const errors = r.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = r.diagnostics.filter((d) => d.severity === "warning").length;
    marks = {};
    for (const d of r.diagnostics) if (d.line && !d.file && d.severity !== "info" && marks[d.line] !== "error") marks[d.line] = d.severity;
    paintGutter(true);
    const shown = r.diagnostics.filter((d) => d.severity !== "info");
    diagEl.innerHTML = shown.length
      ? shown
          .map((d) => {
            const where = d.file ? d.file + (d.line ? ":" + d.line : "") : d.line ? d.line + ":" + (d.column || 1) : "";
            const attrs = (d.line && !d.file ? ' data-line="' + d.line + '" data-column="' + (d.column || 1) + '"' : "") + (d.elementId ? ' data-el="' + escape(d.elementId) + '"' : "");
            return '<div class="d ' + d.severity + '"' + attrs + '><span class="code">' + escape(d.code) + "</span>" + (where ? '<span class="at">' + escape(where) + "</span>" : "") + '<span class="msg">' + escape(d.message) + (d.hint ? '<span class="hint">' + escape(d.hint) + "</span>" : "") + "</span></div>";
          })
          .join("")
      : '<div class="dnone">' + escape(T.noProblems) + "</div>";
    $("#dcounts").innerHTML = errors || warnings
      ? (errors ? '<span class="badge error">' + escape(T.errors) + " " + errors + "</span> " : "") + (warnings ? '<span class="badge warning">' + escape(T.warnings) + " " + warnings + "</span>" : "")
      : '<span class="badge none">' + escape(T.noProblems) + "</span>";
    // the counts are in the problems dock; the status shows what was drawn and how long it took
    const counts = r.pages.length + " " + T.pages + " · " + (r.ms < 1000 ? r.ms + " ms" : (r.ms / 1000).toFixed(1) + " s");
    if (!r.pages.length && errors) {
      pagesEl.classList.toggle("stale", !!pagesEl.querySelector("figure"));
      status(counts + (pagesEl.querySelector("figure") ? " — " + T.stale : ""), "error");
      return false;
    }
    // load the new images before swapping them in, so the pages do not flicker
    const imgs = await Promise.all(r.pages.map((p) => loadImage(p.src)));
    if (my !== seq) return false;
    doc = r;
    views = [];
    const figs = r.pages.map((p, i) => {
      const fig = document.createElement("figure");
      const sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.style.aspectRatio = p.width + " / " + p.height;
      const overlay = document.createElementNS(SVGNS, "svg");
      overlay.setAttribute("class", "overlay");
      overlay.setAttribute("preserveAspectRatio", "none");
      sheet.append(imgs[i], overlay);
      const cap = document.createElement("figcaption");
      cap.textContent = i + 1 + " · " + p.id + (p.side && p.side !== "single" && p.side !== "document" ? " (" + p.side + ")" : "") + (p.separation ? " [" + p.separation + "]" : "");
      cap.onclick = () => {
        setTool("frame");
        select({ kind: "page", id: p.id }, { jump: true });
      };
      fig.append(sheet, cap);
      views.push({ page: p, svg: overlay, img: imgs[i], fig });
      return fig;
    });
    pagesEl.classList.remove("stale");
    if (figs.length) pagesEl.replaceChildren(...figs);
    else pagesEl.innerHTML = '<div class="empty">' + escape(T.noPages) + "</div>";
    // a selection that no longer exists is dropped
    if (selected) {
      const alive = selected.kind === "element" ? !!r.items[selected.id] : selected.kind === "page" ? !!r.layouts[selected.id] : Object.values(r.layouts).some((l) => l.panels.some((p) => p.id === selected.id));
      if (!alive) selected = null;
    }
    requestAnimationFrame(() => {
      drawOverlays();
      inspect();
    });
    status(counts, errors ? "error" : warnings ? "warn" : "ok");
    return true;
  }

  // ---- saving and outside changes -----------------------------------------------------------------
  async function save(force = false) {
    const text = ta.value;
    let res;
    try {
      res = await api("/api/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml: text, base: hash, force }) });
    } catch {
      status(T.disconnected, "error");
      return;
    }
    if (res.status === 409) {
      if (confirm(T.conflict)) return save(true);
      return;
    }
    if (!res.ok) {
      status(T.saveFailed + ": " + ((await res.json().catch(() => ({}))).error || res.status), "error");
      return;
    }
    hash = (await res.json()).hash;
    saved = text;
    external = null;
    banner.classList.remove("show");
    showDirty();
    toast(T.saved);
  }
  const adopt = (d) => {
    suppressAuto = true;
    try {
      replaceText(d.yaml);
    } finally {
      suppressAuto = false;
    }
    saved = ta.value;
    hash = d.hash;
    external = null;
    banner.classList.remove("show");
    showDirty();
    render();
  };
  $("#reload").onclick = () => external && adopt(external);
  $("#keep").onclick = () => banner.classList.remove("show");
  const events = new EventSource("/events?token=" + encodeURIComponent(TOKEN));
  events.addEventListener("file", (e) => {
    const d = JSON.parse(e.data);
    if (d.hash === hash) return;
    if (!dirty()) adopt(d);
    else {
      external = d;
      banner.classList.add("show");
    }
  });
  events.addEventListener("deps", () => render());

  (async () => {
    const s = await (await api("/api/state")).json();
    ta.value = s.yaml;
    saved = ta.value;
    hash = s.hash;
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
    paintGutter(true);
    showDirty();
    inspect();
    render();
  })();
}
