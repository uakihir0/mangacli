import type { Node } from "./ir.js";

export function resolveOutlineLayers(nodes: Node[], darkness?: number): Node[] {
  const resolved = nodes.map((node) => {
    if (node.kind !== "path" || !node.stroke?.auto) return node;
    const { auto, ...stroke } = node.stroke;
    const width = darkness === undefined || darkness - auto.threshold > 1e-9 ? auto.max : auto.min;
    return { ...node, stroke: { ...stroke, width: width * 2 } };
  });
  const width = (node: Node) => node.kind === "path" ? node.stroke?.width ?? 0 : 0;
  return resolved.sort((a, b) => width(b) - width(a));
}
