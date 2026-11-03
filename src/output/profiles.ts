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
    const out = { ...base, ...(c as Partial<Profile>) } as Profile & { extends?: string };
    delete out.extends;
    return out;
  }
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown profile "${name}"`);
  return { ...p };
}
