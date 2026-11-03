// Output profiles (spec 10.7).
import type { OutputFormat } from "./encode.js";

export interface Profile {
  format: OutputFormat | OutputFormat[];
  colorMode: "color" | "gray" | "mono" | "intent";
  dpi?: number;
  longSide?: number;
  width?: number;
  height?: number;
  scale?: number;
  crop: "trim" | "bleed" | "marks";
  marks?: { margin?: number; length?: number; width?: number };
  spread?: "joined" | "split";
  finish?: import("./finish.js").Finish;
  toneRendering: "dots" | "flat" | "auto";
  print: boolean;
  draft?: boolean;
  quality?: number;
  lossless?: boolean;
  name?: string;
  dir?: string;
  monoLpi?: number;
  toneCurve?: "linear" | "perceptual";
  transparent?: boolean;
  separate?: string[] | Record<string, string[]> | "all" | false;
  imageLpi?: number;
  monoImages?: "screen" | "dither";
  compression?: number;
  chroma?: "4:4:4" | "4:2:2" | "4:2:0";
  tiffCompression?: "lzw" | "deflate" | "ccitt4" | "none" | "jpeg";
  metadata?: boolean;
}

/** apply `output` settings (config, then document) over a profile (spec 10.7) */
export function applyOutput(prof: Profile, o: Record<string, unknown> | undefined): Profile {
  if (!o) return prof;
  const out: Profile = { ...prof };
  const keys = ["format", "colorMode", "crop", "marks", "spread", "finish", "toneRendering", "quality", "lossless", "compression", "chroma", "tiffCompression", "name", "transparent", "separate", "metadata"] as const;
  for (const k of keys) if (o[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = o[k];
  // an explicit resolution replaces the profile's long-side sizing
  for (const k of ["dpi", "scale", "width", "height"] as const)
    if (o[k] !== undefined) {
      out[k] = Number(o[k]);
      delete out.longSide;
    }
  if (o.background === "transparent") out.transparent = true;
  const mono = (o.mono ?? {}) as Record<string, unknown>;
  if (mono.toneCurve !== undefined) out.toneCurve = mono.toneCurve as Profile["toneCurve"];
  if (o.toneCurve !== undefined) out.toneCurve = o.toneCurve as Profile["toneCurve"];
  if (mono.lpi !== undefined) out.monoLpi = Number(mono.lpi);
  if (mono.imageLpi !== undefined) out.imageLpi = Number(mono.imageLpi);
  if (mono.images !== undefined) out.monoImages = mono.images as Profile["monoImages"];
  return out;
}

export const PROFILES: Record<string, Profile> = {
  "print-mono": { format: "png", colorMode: "mono", dpi: 600, crop: "bleed", toneRendering: "dots", print: true },
  "print-gray": { format: "png", colorMode: "gray", dpi: 600, crop: "bleed", toneRendering: "dots", print: true },
  "print-color": { format: "png", colorMode: "color", dpi: 350, crop: "bleed", toneRendering: "dots", print: true },
  web: { format: "png", colorMode: "intent", longSide: 2000, crop: "trim", toneRendering: "auto", print: false },
  sns: { format: "jpeg", colorMode: "intent", longSide: 1600, crop: "trim", toneRendering: "auto", print: false, quality: 90 },
  preview: { format: "png", colorMode: "intent", dpi: 96, crop: "trim", toneRendering: "auto", print: false },
  draft: { format: "png", colorMode: "gray", dpi: 150, crop: "trim", toneRendering: "flat", print: false, draft: true },
};

export function resolveProfile(name: string, custom: Record<string, Record<string, unknown>> = {}): Profile {
  const c = custom[name];
  if (c) {
    const base = resolveProfile((c.extends as string) ?? "web", { ...custom, [name]: undefined as never });
    return applyOutput(base, c);
  }
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown profile "${name}"`);
  return { ...p };
}
