import { applyMat, invertMat, type Vec } from "../geom/vec.js";
import { distanceSquared } from "../render/edt.js";
import type { ElemCtx } from "./context.js";

type ImagePx = NonNullable<ReturnType<ElemCtx["refs"]["all"]>[number]["imagePx"]>;
const samples = new WeakMap<ElemCtx["assets"], Map<string, { distance: Float64Array; w: number; h: number; opaque: boolean }>>();

export async function prepareEffectAlpha(ctx: ElemCtx, image: ImagePx): Promise<void> {
  let cache = samples.get(ctx.assets);
  if (!cache) samples.set(ctx.assets, cache = new Map());
  if (cache.has(image.assetKey)) return;
  const scale = Math.min(1, 1024 / Math.max(image.w, image.h));
  const px = await ctx.assets.pixels(image.assetKey, image.w * scale, image.h * scale, { x: 0, y: 0, w: image.w, h: image.h });
  if (!px) return;
  const mask = new Uint8Array(px.width * px.height);
  let solid = 0;
  for (let i = 0; i < mask.length; i++) {
    mask[i] = px.data[4 * i + 3] > 16 ? 1 : 0;
    if (px.data[4 * i + 3] >= 250) solid++;
  }
  cache.set(image.assetKey, { distance: distanceSquared(mask, px.width, px.height), w: px.width, h: px.height, opaque: solid / mask.length > 0.995 });
}

export function effectSilhouette(ctx: ElemCtx, image: ImagePx, margin: number): { contains: (p: Vec, extra?: number) => boolean; opaque: boolean } | undefined {
  const sample = samples.get(ctx.assets)?.get(image.assetKey);
  if (!sample) return;
  const inv = invertMat(image.matrix);
  const sx = Math.hypot(image.matrix[0], image.matrix[1]) * image.w / sample.w;
  const sy = Math.hypot(image.matrix[2], image.matrix[3]) * image.h / sample.h;
  const unit = Math.min(sx, sy);
  return {
    opaque: sample.opaque,
    contains(p, extra = 0) {
      const q = applyMat(inv, p);
      const x = q.x / image.w * sample.w - 0.5;
      const y = q.y / image.h * sample.h - 0.5;
      const ix = Math.max(0, Math.min(sample.w - 1, Math.round(x)));
      const iy = Math.max(0, Math.min(sample.h - 1, Math.round(y)));
      const delta = Math.hypot(x - ix, y - iy);
      const outside = Math.hypot(Math.max(0, -x, x - sample.w + 1), Math.max(0, -y, y - sample.h + 1));
      const distance = Math.max(outside, Math.sqrt(sample.distance[iy * sample.w + ix]) - delta);
      return distance * unit <= margin + extra + Math.hypot(sx, sy);
    },
  };
}

/** Sample before inking, so every exposed endpoint receives a fresh pen taper. */
export function splitClearLine(points: Vec[], contains: (p: Vec) => boolean, step: number, minimum: number): Vec[][] {
  const runs: Vec[][] = [];
  let run: Vec[] = [];
  let length = 0;
  const finish = () => {
    if (length >= minimum && run.length > 1) runs.push(run);
    run = [];
    length = 0;
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = i === 1 ? 0 : 1; j <= n; j++) {
      const p = { x: a.x + (b.x - a.x) * j / n, y: a.y + (b.y - a.y) * j / n };
      if (contains(p)) finish();
      else {
        const prev = run.at(-1);
        if (prev) length += Math.hypot(p.x - prev.x, p.y - prev.y);
        run.push(p);
      }
    }
  }
  finish();
  return runs;
}
