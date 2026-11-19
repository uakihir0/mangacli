import type { Vec } from "../geom/vec.js";
import { applyMat } from "../geom/vec.js";
import type { RElement } from "../model/resolve.js";
import type { ElemCtx } from "./context.js";

export const signedArea = (p: Vec[]): number => p.reduce((a, q, i) => {
  const r = p[(i + 1) % p.length];
  return a + q.x * r.y - r.x * q.y;
}, 0) / 2;

/** Marching squares on a padded binary alpha grid. */
export function traceAlpha(mask: Uint8Array, w: number, h: number): Vec[][] {
  const cases: number[][][] = [[], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]], [[2, 3]], [[2, 0]], [[0, 1], [2, 3]], [[2, 1]], [[1, 3]], [[1, 0]], [[0, 3]], []];
  const edges = new Map<string, Vec>();
  const key = (p: Vec) => `${p.x},${p.y}`;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const c = mask[y * w + x] + mask[y * w + x + 1] * 2 + mask[(y + 1) * w + x + 1] * 4 + mask[(y + 1) * w + x] * 8;
    const points = [{ x: x + 0.5, y }, { x: x + 1, y: y + 0.5 }, { x: x + 0.5, y: y + 1 }, { x, y: y + 0.5 }];
    for (const [a, b] of cases[c]) edges.set(key(points[a]), points[b]);
  }
  const loops: Vec[][] = [];
  while (edges.size) {
    const start = edges.keys().next().value!;
    let k = start;
    const pts: Vec[] = [];
    do {
      const next = edges.get(k);
      if (!next) break;
      edges.delete(k);
      pts.push(next);
      k = key(next);
    } while (k !== start);
    if (k !== start || pts.length < 3 || signedArea(pts) >= 0) continue;
    loops.push(pts.filter((p, i) => {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
      return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
    }));
  }
  return loops;
}

export async function prepareAlphaContours(els: RElement[], ctx: ElemCtx): Promise<Map<string, Vec[][]>> {
  const out = new Map<string, Vec[][]>();
  for (const el of els) {
    if (el.children) for (const [id, loops] of await prepareAlphaContours(el.children, ctx)) out.set(id, loops);
    if (el.type !== "effect" || !["aura", "arcs"].includes(String(el.props.kind))) continue;
    const target = typeof el.props.target === "string" ? ctx.refs.target(el.props.target, ctx.panel?.panel.id) : undefined;
    if (!target?.imagePx || out.has(target.id)) continue;
    const { w, h, matrix, assetKey } = target.imagePx;
    const scale = 256 / Math.max(w, h);
    const gw = Math.max(1, Math.round(w * scale)), gh = Math.max(1, Math.round(h * scale));
    const px = await ctx.assets.pixels(assetKey, gw, gh, { x: 0, y: 0, w, h });
    if (!px) continue;
    const pad = 4, W = gw + pad * 2, H = gh + pad * 2;
    const mask = new Uint8Array(W * H);
    // A conservative guard keeps antialiased source edges outside the effect, too.
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (px.data[(y * gw + x) * 4 + 3] > 0) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mask[(y + pad + dy) * W + x + pad + dx] = 1;
    }
    out.set(target.id, traceAlpha(mask, W, H).map(loop => loop.map(p => applyMat(matrix, { x: (p.x - pad + 0.5) * w / gw, y: (p.y - pad + 0.5) * h / gh }))));
  }
  return out;
}
