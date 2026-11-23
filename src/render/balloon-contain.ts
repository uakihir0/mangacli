import polygonClipping from "polygon-clipping";
import { parseAngle, toMm } from "../core/units.js";
import { balloonTailRegions, hasOffscreenTail, type BalloonPlan } from "../elements/balloon.js";
import type { ElemCtx } from "../elements/context.js";
import { distToPolyline, pointInPolygon, polygonArea } from "../geom/path.js";
import { boundsOf, lerp, rectInset, rectOverlapArea, type Rect, type Vec } from "../geom/vec.js";
import type { RElement } from "../model/resolve.js";
import { breakFaults } from "../text/layout.js";

export function containmentOptOut(el: RElement): boolean {
  const p = el.props;
  return p.contain === "none" || p.bridge === true || p.clip === "none" || typeof p.clip === "object";
}

export function containsBalloon(el: RElement, ctx: ElemCtx): boolean {
  return el.type === "balloon" && !!ctx.panel && el.props.contain === "panel" && !containmentOptOut(el);
}

export function warnBalloonInGutter(el: RElement, contour: Vec[], ctx: ElemCtx): void {
  if (ctx.panelPoly && !containsBalloon(el, ctx) && !containmentOptOut(el) && el.props.clip !== "panel" && !polygonFits(contour, ctx.panelPoly)) ctx.bag.warn("BALLOON_IN_GUTTER", `balloon ${el.id} extends into a gutter or another panel`, { path: el.path, elementId: el.id });
}

const convexity = new WeakMap<Vec[], boolean>();

export function bodyPolygon(plan: BalloonPlan, center = plan.center!): Vec[] {
  const a = plan.props.rotate === undefined ? 0 : parseAngle(plan.props.rotate as string);
  return plan.body.contour.pts.map(q => ({ x: center.x + q.x * Math.cos(a) - q.y * Math.sin(a), y: center.y + q.x * Math.sin(a) + q.y * Math.cos(a) }));
}

export function overlapBalloonCenter(a: BalloonPlan, b: BalloonPlan, ctx: ElemCtx, occupied: Rect[], settled: boolean): Vec | undefined {
  if (!a.center || !b.center || a.params.kind === "none" || b.params.kind === "none") return;
  const from = b.center;
  const target = a.center;
  const first = bodyPolygon(a);
  const second = bodyPolygon(b);
  const smaller = Math.min(Math.abs(polygonArea(first)), Math.abs(polygonArea(second)));
  if (smaller <= 1e-8) return;
  const ring = (pts: Vec[]): polygonClipping.Ring => pts.map(p => [p.x, p.y]);
  const fixed = [ring(first)];
  const overlap = (pts: Vec[]) => polygonClipping.intersection(fixed, [ring(pts)])
    .reduce((area, poly) => area + poly.reduce((sum, r, i) => sum + (i === 0 ? 1 : -1) * Math.abs(polygonArea(r.map(([x, y]) => ({ x, y })))), 0), 0) / smaller;
  const start = overlap(second);
  if (start >= 0.15) return from;
  if (settled || b.edgeCut || (ctx.panel && b.props.attach !== "none" && (b.props.attach || b.props.as === "narration"))) return;
  const distance = Math.hypot(target.x - from.x, target.y - from.y);
  if (!distance) return;
  const radius = (p: Vec[], c: Vec) => Math.max(...p.map(q => Math.hypot(q.x - c.x, q.y - c.y)));
  const reach = Math.min(distance, radius(first, target) + radius(second, from));
  const original = boundsOf(second);
  const limits = rectInset(ctx.geom.trim, ctx.u.k);
  const panel = containsBalloon(b.el, ctx) ? ctx.panelPoly : undefined;
  const clearance = panel ? frameClearance(ctx) : 0;
  const candidate = (d: number) => {
    const center = lerp(target, from, d / distance);
    const points = bodyPolygon(b, center);
    return { center, points, ratio: overlap(points) };
  };
  const fits = ({ points }: ReturnType<typeof candidate>) => {
    const box = boundsOf(points);
    return (hasOffscreenTail(b.props) || (box.x >= limits.x - 0.01 && box.y >= limits.y - 0.01 &&
      box.x + box.w <= limits.x + limits.w + 0.01 && box.y + box.h <= limits.y + limits.h + 0.01)) &&
      (!panel || polygonFits(points, panel, clearance)) &&
      occupied.every(r => rectOverlapArea(r, box) <= rectOverlapArea(r, original) + 1e-8);
  };
  let prev = { d: reach, ratio: start };
  for (let i = 0; i <= 48; i++) {
    const d = reach * (1 - i / 48);
    const trial = candidate(d);
    if (trial.ratio >= 0.15 && trial.ratio <= 0.25 && fits(trial)) return trial.center;
    if (trial.ratio > 0.25 && prev.ratio < 0.15) {
      let lo = d, hi = prev.d;
      for (let j = 0; j < 18; j++) {
        const mid = (lo + hi) / 2;
        const refined = candidate(mid);
        if (refined.ratio >= 0.15 && refined.ratio <= 0.25 && fits(refined)) return refined.center;
        if (refined.ratio > 0.2) lo = mid;
        else hi = mid;
      }
    }
    prev = { d, ratio: trial.ratio };
  }
}

export function polygonFits(points: Vec[], panel: Vec[], clearance = 0): boolean {
  if (!points.length) return true;
  for (const p of points) if (!pointInPolygon(p, panel) || (clearance > 0 && distToPolyline(p, panel, true) < clearance - 1e-5)) return false;
  let convex = convexity.get(panel);
  if (convex === undefined) {
    const turns = panel.map((a, i) => {
      const b = panel[(i + 1) % panel.length];
      const c = panel[(i + 2) % panel.length];
      return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    });
    convex = turns.every(t => t >= -1e-8) || turns.every(t => t <= 1e-8);
    convexity.set(panel, convex);
  }
  if (convex) return true;
  // Checking vertices alone misses a contour spanning a concave notch.
  const ring = (p: Vec[]): polygonClipping.Ring => p.map(q => [q.x, q.y]);
  const outside = polygonClipping.difference([ring(points)], [ring(panel)]);
  if (outside.reduce((a, poly) => a + poly.reduce((s, r) => s + Math.abs(polygonArea(r.map(([x, y]) => ({ x, y })))), 0), 0) >= 1e-5) return false;
  if (clearance > 0) for (let i = 0; i < points.length; i++) {
    const segment = [points[i], points[(i + 1) % points.length]];
    for (const p of panel) if (distToPolyline(p, segment, false) < clearance - 1e-5) return false;
  }
  return true;
}

export function frameClearance(ctx: ElemCtx): number {
  const border = ctx.panel?.panel.props.border;
  const width = border && typeof border === "object" ? (border as Record<string, unknown>).width : undefined;
  return (border === "none" ? 0 : toMm((width as string) ?? "0.5bmm", ctx.u) / 2) + 0.3 * ctx.u.k;
}

function nearestTranslation(points: Vec[], panel: Vec[], clearance: number, within?: Vec[], occupied: Rect[] = []): Vec | null {
  const fits = (p: Vec[]) => {
    if (!polygonFits(p, panel, clearance) || (within && !polygonFits(p, within))) return false;
    const b = boundsOf(p);
    return occupied.every(r => b.x + b.w + clearance <= r.x || r.x + r.w + clearance <= b.x || b.y + b.h + clearance <= r.y || r.y + r.h + clearance <= b.y);
  };
  if (fits(points)) return { x: 0, y: 0 };
  const b = boundsOf(points);
  const pb = boundsOf(panel);
  let best: Vec | null = null;
  let distance = Infinity;
  const test = (d: Vec) => {
    const n = d.x * d.x + d.y * d.y;
    if (n >= distance || !fits(points.map(p => ({ x: p.x + d.x, y: p.y + d.y })))) return;
    best = d;
    distance = n;
  };
  const lo = { x: pb.x + clearance - b.x, y: pb.y + clearance - b.y };
  const hi = { x: pb.x + pb.w - clearance - b.x - b.w, y: pb.y + pb.h - clearance - b.y - b.h };
  if (lo.x > hi.x || lo.y > hi.y) return null;
  test({ x: Math.max(lo.x, Math.min(hi.x, 0)), y: Math.max(lo.y, Math.min(hi.y, 0)) });
  if (best) return best;
  if (convexity.get(panel) && !within && !occupied.length) {
    let feasible = [{ x: lo.x, y: lo.y }, { x: hi.x, y: lo.y }, { x: hi.x, y: hi.y }, { x: lo.x, y: hi.y }];
    const sign = polygonArea(panel) >= 0 ? 1 : -1;
    for (let i = 0; i < panel.length && feasible.length; i++) {
      const a = panel[i];
      const b = panel[(i + 1) % panel.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-8) continue;
      const n = { x: -(b.y - a.y) / length * sign, y: (b.x - a.x) / length * sign };
      const limit = clearance - Math.min(...points.map(p => (p.x - a.x) * n.x + (p.y - a.y) * n.y));
      const next: Vec[] = [];
      for (let j = 0; j < feasible.length; j++) {
        const p = feasible[j];
        const q = feasible[(j + 1) % feasible.length];
        const dp = p.x * n.x + p.y * n.y - limit;
        const dq = q.x * n.x + q.y * n.y - limit;
        if (dp >= -1e-8) next.push(p);
        if ((dp < 0) !== (dq < 0)) next.push({ x: p.x + (q.x - p.x) * dp / (dp - dq), y: p.y + (q.y - p.y) * dp / (dp - dq) });
      }
      feasible = next;
    }
    for (let i = 0; i < feasible.length; i++) {
      const a = feasible[i];
      const b = feasible[(i + 1) % feasible.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy || 1)));
      test({ x: a.x + t * dx, y: a.y + t * dy });
    }
    return best;
  }
  const step = Math.max(pb.w, pb.h) / 16;
  if (occupied.length) {
    const xs = [lo.x, hi.x, Math.max(lo.x, Math.min(hi.x, 0)), ...occupied.flatMap(r => [r.x - clearance - b.x - b.w, r.x + r.w + clearance - b.x])];
    const ys = [lo.y, hi.y, Math.max(lo.y, Math.min(hi.y, 0)), ...occupied.flatMap(r => [r.y - clearance - b.y - b.h, r.y + r.h + clearance - b.y])];
    for (const x of xs) for (const y of ys) test({ x, y });
  }
  for (let y = lo.y; y <= hi.y + 1e-6; y += step) for (let x = lo.x; x <= hi.x + 1e-6; x += step) test({ x, y });
  if (!best) return null;
  for (let s = step / 2; s > 0.01; s /= 2) {
    const c = best as Vec;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) test({ x: c.x + x * s, y: c.y + y * s });
  }
  return best;
}

function textPolygon(plan: BalloonPlan): Vec[] {
  const x = plan.center!.x + plan.innerCenter.x + plan.textOffset.x - plan.text.width / 2;
  const y = plan.center!.y + plan.innerCenter.y + plan.textOffset.y - plan.text.height / 2;
  const a = plan.props.rotate === undefined ? 0 : parseAngle(plan.props.rotate as string);
  return [{ x, y }, { x: x + plan.text.width, y }, { x: x + plan.text.width, y: y + plan.text.height }, { x, y: y + plan.text.height }].map(q => ({ x: plan.center!.x + (q.x - plan.center!.x) * Math.cos(a) - (q.y - plan.center!.y) * Math.sin(a), y: plan.center!.y + (q.x - plan.center!.x) * Math.sin(a) + (q.y - plan.center!.y) * Math.cos(a) }));
}

export function autoEdgeCutFits(plan: BalloonPlan, ctx: ElemCtx, corner: boolean): boolean {
  if (!ctx.panelPoly || !plan.center || hasOffscreenTail(plan.props) || plan.props.connect) return false;
  if (corner && !["ellipse", "cloud", "round-rect"].includes(plan.params.kind)) return false;
  const body = bodyPolygon(plan);
  const poly = ctx.panelPoly;
  const sign = polygonArea(poly) >= 0 ? 1 : -1;
  let cuts = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-8) continue;
    const distances = body.map(p => ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / length * sign);
    const low = Math.min(...distances);
    if (low >= 0) continue;
    cuts++;
    if (-low > (Math.max(...distances) - low) * (corner ? 0.1 : 0.25) + 1e-6) return false;
  }
  if (cuts === 0 || cuts > (corner ? 2 : 1)) return false;
  if (plan.text.plain && !polygonFits(textPolygon(plan), poly, Math.max(2.5 * ctx.u.k, plan.text.fontSize * 0.8))) return false;
  return balloonTailRegions(plan, ctx).every(tail => polygonFits(tail, poly, frameClearance(ctx)));
}

export function edgeCut(plan: BalloonPlan, ctx: ElemCtx): boolean {
  if (!ctx.panelPoly || !plan.explicit || plan.props.at === undefined) return false;
  const tol = 0.6 * ctx.u.k;
  const body = bodyPolygon(plan);
  if (body.some(p => distToPolyline(p, ctx.panelPoly!, true) <= tol)) return true;
  const ring = (p: Vec[]): polygonClipping.Ring => p.map(q => [q.x, q.y]);
  return !polygonFits(body, ctx.panelPoly) && polygonClipping.intersection([ring(body)], [ring(ctx.panelPoly)]).length > 0;
}

export function containBalloon(plan: BalloonPlan, ctx: ElemCtx, replan: (props: Record<string, unknown>) => BalloonPlan | null, occupied: Rect[] = []): void {
  if (!containsBalloon(plan.el, ctx) || !ctx.panelPoly || !plan.center) return;
  const panel = ctx.panelPoly;
  const cut = plan.edgeCut || edgeCut(plan, ctx);
  plan.edgeCut = cut;
  const clearance = frameClearance(ctx);
  const fit = (p: BalloonPlan): boolean => {
    if (!cut) {
      const d = nearestTranslation(bodyPolygon(p), panel, clearance, undefined, occupied);
      if (!d) return false;
      p.center = { x: p.center!.x + d.x, y: p.center!.y + d.y };
      return true;
    }
    if (!p.text.plain) return true;
    const text = textPolygon(p);
    const margin = Math.max(2.5 * ctx.u.k, p.text.fontSize * 0.8);
    const d = nearestTranslation(text, panel, margin, bodyPolygon(p));
    if (!d) return false;
    const moved = text.map(q => ({ x: q.x + d.x, y: q.y + d.y }));
    if (!polygonFits(moved, bodyPolygon(p), 0.1 * ctx.u.k)) return false;
    const a = p.props.rotate === undefined ? 0 : parseAngle(p.props.rotate as string);
    p.textOffset = { x: p.textOffset.x + d.x * Math.cos(a) + d.y * Math.sin(a), y: p.textOffset.y - d.x * Math.sin(a) + d.y * Math.cos(a) };
    return true;
  };
  if (fit(plan)) return;
  const original = plan.center;
  const chars = Math.max(2, ...plan.text.lines.map(l => Array.from(l.text ?? "").length));
  const keepDialogueSize = plan.dialogueExceedsMaxSize !== undefined;
  const faults = keepDialogueSize ? breakFaults(plan.text, ctx.lang) : Infinity;
  const floor = keepDialogueSize ? 1 : typeof plan.props.minFontScale === "number" ? plan.props.minFontScale : 0.75;
  const scales = [1];
  for (let s = 0.95; s > floor + 1e-6; s -= 0.05) scales.push(s);
  if (floor < 1) scales.push(floor);
  for (const scale of scales) for (const maxChars of [...new Set([chars, Math.max(2, Math.round(chars * 0.6)), Math.round(chars * 1.5), Math.max(2, Math.round(chars * 0.4))])]) {
    const candidate = replan({ ...plan.props, size: undefined, maxChars, fontScale: ((plan.props.fontScale as number) ?? 1) * scale, minFontScale: 1, overflow: "grow" });
    if (!candidate || (keepDialogueSize && breakFaults(candidate.text, ctx.lang) > faults)) continue;
    candidate.center = { ...original };
    if (!fit(candidate)) continue;
    const props = plan.props;
    Object.assign(plan, candidate, {
      props,
      edgeCut: cut,
      fontScaleApplied: candidate.fontScaleApplied * scale,
      dialogueExceedsMaxSize: keepDialogueSize ? candidate.dialogueExceedsMaxSize : undefined,
    });
    if (scale < 1) ctx.bag.info("TEXT_SHRUNK", `balloon ${plan.el.id}: contained font scaled to ${Math.round(scale * 100)}%`, { path: plan.el.path, elementId: plan.el.id });
    return;
  }
  const size = keepDialogueSize ? "the dialogue font size" : "minFontScale";
  ctx.bag.warn("BALLOON_NO_SPACE", `balloon ${plan.el.id} cannot fit inside its panel at ${size}; enlarge the panel or shorten the dialogue`, { path: plan.el.path, elementId: plan.el.id });
}
