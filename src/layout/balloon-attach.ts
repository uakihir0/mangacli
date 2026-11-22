import type { Rect, Vec } from "../geom/vec.js";

export function attachedBalloonCenter(attach: string | undefined, narration: boolean, frame: Rect, outer: Rect, stroke: number, at?: Vec): Vec | undefined {
  if (attach === "none" || (!attach && !narration)) return undefined;
  const point = at ?? { x: frame.x + frame.w, y: frame.y };
  const side = attach ?? `${point.y <= frame.y + frame.h / 2 ? "top" : "bottom"}-${point.x >= frame.x + frame.w / 2 ? "right" : "left"}`;
  const half = stroke / 2;
  const left = frame.x + half - outer.x;
  const right = frame.x + frame.w - half - outer.x - outer.w;
  const top = frame.y + half - outer.y;
  const bottom = frame.y + frame.h - half - outer.y - outer.h;
  return {
    x: side.includes("left") ? left : side.includes("right") ? right : Math.max(left, Math.min(right, point.x)),
    y: side.includes("top") ? top : side.includes("bottom") ? bottom : Math.max(top, Math.min(bottom, point.y)),
  };
}
