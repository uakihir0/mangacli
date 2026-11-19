// JSON Schema export for editors (spec 3.2, 12.3.6).
// The zod schema validates the normalized document. For editors the exported schema also
// accepts the shorthand forms (element shorthands such as `- balloon: text`, scalar shorthands
// such as `stroke: 0.3mm`), so it never reports errors on valid documents.
import { z } from "zod";
import { Document } from "./schema.js";

type J = Record<string, unknown>;

const SHORTHAND_KEYS = ["image", "balloon", "aside", "sfx", "text", "effect", "mark", "draw", "tone", "group", "scatter"];

export function jsonSchema(): J {
  const s = z.toJSONSchema(Document, { unrepresentable: "any", io: "input", reused: "ref" }) as J;
  const defs = (s.$defs ?? {}) as Record<string, J>;
  // the element union is what `layers` items refer to
  const layersRef = findLayersRef(s);
  // dialogue items accept `<character>: text`
  const relaxDialogue = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(relaxDialogue);
    const o = n as J;
    const items = ((o.properties as J | undefined)?.dialogue as J | undefined)?.items as J | undefined;
    if (items && items.type === "object") items.additionalProperties = { type: "string" };
    Object.values(o).forEach(relaxDialogue);
  };
  relaxDialogue(s);
  const lenient = (node: unknown, root: boolean): unknown => {
    if (Array.isArray(node)) return node.map((n) => lenient(n, false));
    if (!node || typeof node !== "object") return node;
    const o: J = {};
    for (const [k, v] of Object.entries(node as J)) o[k] = k === "properties" ? Object.fromEntries(Object.entries(v as J).map(([pk, pv]) => [pk, lenient(pv, false)])) : lenient(v, false);
    if (!root && o.type === "object") return { anyOf: [o, { type: ["string", "number", "boolean", "array"] }] };
    return o;
  };
  const out = lenient({ ...s, $defs: undefined }, true) as J;
  const newDefs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defs)) newDefs[k] = lenient(v, true);
  if (layersRef && newDefs[layersRef]) {
    newDefs[layersRef] = {
      anyOf: [
        newDefs[layersRef],
        { type: "object", not: { required: ["type"] }, anyOf: SHORTHAND_KEYS.map((k) => ({ required: [k] })), additionalProperties: true },
      ],
    };
  }
  out.$defs = newDefs;
  out.$id = "https://unpkg.com/mangacli/schema.json";
  out.title = "mangacli document";
  return out;
}

function findLayersRef(s: unknown): string | null {
  let found: string | null = null;
  const walk = (n: unknown) => {
    if (found || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const o = n as J;
    const props = o.properties as J | undefined;
    const layers = props?.layers as J | undefined;
    const ref = (layers?.items as J | undefined)?.$ref;
    if (typeof ref === "string") {
      found = ref.replace("#/$defs/", "");
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(s);
  return found;
}
