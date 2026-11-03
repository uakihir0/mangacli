// Canonical document schema (spec 3-10). Validated after shorthand normalization.
import { z } from "zod";

const LEN_RE = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|in|pt|px|Q|H|em|%)?$/;
const ANG_RE = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*(deg|rad|turn)?$/;

export const Length = z.union([z.number(), z.string().regex(LEN_RE, "invalid length")]).describe("Length: number or '<n><unit>' (mm, cm, in, pt, px, Q, H, em, %)");
export const LengthAuto = z.union([Length, z.literal("auto")]);
export const Angle = z.union([z.number(), z.string().regex(ANG_RE, "invalid angle")]).describe("Angle in degrees or '<n>deg|rad|turn'");
export const Num = z.number();
const RangeOf = <T extends z.ZodTypeAny>(t: T) =>
  z.union([t, z.tuple([t, t]), z.object({ min: t, max: t, dist: z.enum(["uniform", "normal", "low", "high"]).optional() }).strict()]);
export const PointKeyword = z.enum(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]);
export const Point = z.union([z.tuple([Length, Length]), z.string()]).describe("Point: [x, y], position keyword, or reference (id, id.anchor)");
export const Size = z.tuple([LengthAuto, LengthAuto]);
export const Rect = z.tuple([Length, Length, Length, Length]);
export const ColorStr = z.string();

const ToneObj = z
  .object({
    density: z.union([z.number(), z.string()]).optional(),
    lpi: z.number().positive().max(200).optional(),
    angle: Angle.optional(),
    dot: z.enum(["round", "square", "ellipse", "line", "cross", "noise"]).optional(),
    grain: Length.optional(),
    invert: z.boolean().optional(),
    offset: z.tuple([Length, Length]).optional(),
    color: ColorStr.optional(),
    gradient: z
      .object({
        type: z.enum(["linear", "radial"]).optional(),
        angle: Angle.optional(),
        center: z.tuple([Length, Length]).optional(),
        radius: Length.optional(),
        stops: z.array(z.tuple([z.union([z.number(), z.string()]), z.union([z.number(), z.string()])])),
        easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const Paint = z.union([
  z.string(),
  z.object({ tone: ToneObj }).strict(),
  z
    .object({
      gradient: z
        .object({
          type: z.enum(["linear", "radial"]).optional(),
          angle: Angle.optional(),
          at: z.tuple([Length, Length]).optional(),
          stops: z.array(z.union([z.tuple([ColorStr, z.union([z.number(), z.string()])]), ColorStr])),
        })
        .strict(),
    })
    .strict(),
  z.object({ pattern: z.object({ asset: z.string(), scale: z.number().optional(), rotate: Angle.optional(), offset: z.tuple([Length, Length]).optional() }).strict() }).strict(),
]);

const Hand = z
  .object({
    preset: z.string().optional(),
    roughness: z.number().min(0).max(1).optional(),
    wobble: z.object({ amplitude: Length.optional(), wavelength: Length.optional() }).strict().optional(),
    tremor: z.object({ amplitude: Length.optional(), wavelength: Length.optional() }).strict().optional(),
    irregularity: z.number().optional(),
    pressure: z.number().optional(),
    taper: z.number().optional(),
    overshoot: RangeOf(Length).optional(),
    closure: z
      .object({ overlap: RangeOf(Length).optional(), gap: RangeOf(Length).optional(), gapChance: z.number().optional(), misalign: Length.optional() })
      .strict()
      .optional(),
    split: z.object({ cornerAngle: Angle.optional(), maxLength: Length.optional() }).strict().optional(),
    ruler: z.object({ angleError: Angle.optional() }).strict().optional(),
    handedness: z.enum(["right", "left"]).optional(),
    resolution: Length.optional(),
  })
  .strict();

const Pen = z
  .object({
    preset: z.string().optional(),
    pressure: z.number().optional(),
    taper: z.object({ in: Length.optional(), out: Length.optional() }).strict().optional(),
    curvature: z.number().optional(),
    pull: z.number().optional(),
    tremor: z.number().optional(),
    inkPool: z.number().optional(),
    dryBrush: z.object({ amount: z.number(), start: z.number().optional() }).strict().optional(),
    cap: z.enum(["round", "flat"]).optional(),
    minWidth: Length.optional(),
    tipWidth: Length.optional(),
    texture: z.enum(["none", "graphite"]).optional(),
  })
  .strict();

export const Stroke = z
  .object({
    width: Length.optional(),
    color: ColorStr.optional(),
    pen: Pen.optional(),
    style: z.enum(["solid", "dashed", "dotted", "double", "none", "wavy", "blur"]).optional(),
    dash: z.tuple([Length, Length]).optional(),
    dot: z.object({ size: Length, gap: Length }).strict().optional(),
    double: z.object({ gap: Length, inner: Length }).strict().optional(),
    hand: Hand.optional(),
    ruler: z.boolean().optional(),
    join: z.enum(["clean", "overshoot", "gap"]).optional(),
    overshoot: RangeOf(Length).optional(),
    wave: z.object({ amplitude: Length, wavelength: Length }).strict().optional(),
    blur: z.object({ width: Length.optional(), color: ColorStr.optional() }).strict().optional(),
    sides: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const Outline = z.array(z.object({ width: Length, color: z.union([ColorStr, Paint]).optional(), join: z.enum(["round", "miter"]).optional(), threshold: z.number().optional() }).strict());

const RegionBase: z.ZodType = z.lazy(() =>
  z.union([
    z.enum(["panel", "page", "trim", "bleed", "baseFrame"]),
    z.object({ rect: Rect, feather: Length.optional() }).strict(),
    z.object({ ellipse: Rect, feather: Length.optional() }).strict(),
    z.object({ polygon: z.array(z.tuple([Length, Length])), feather: Length.optional() }).strict(),
    z.object({ path: z.string(), feather: Length.optional() }).strict(),
    z.object({ band: z.object({ side: z.enum(["top", "right", "bottom", "left"]), size: Length }).strict(), feather: Length.optional() }).strict(),
    z.object({ element: z.string(), mode: z.enum(["bbox", "shape", "alpha"]).optional(), feather: Length.optional() }).strict(),
    z.object({ union: z.array(RegionBase) }).strict(),
    z.object({ subtract: z.tuple([RegionBase, RegionBase]) }).strict(),
    z.object({ invert: RegionBase }).strict(),
  ]),
);
export const Region = RegionBase;

const Mask = z.union([z.object({ region: Region, invert: z.boolean().optional(), feather: Length.optional() }).strict(), Region]);

const Clip = z.union([z.enum(["panel", "none", "trim"]), z.object({ to: z.literal("panel"), open: z.array(z.enum(["top", "right", "bottom", "left"])) }).strict()]);

const common = {
  id: z.string().optional(),
  at: Point.optional(),
  anchor: z.union([PointKeyword, z.tuple([z.number(), z.number()])]).optional(),
  place: PointKeyword.optional(),
  inset: Length.optional(),
  offset: z.tuple([Length, Length]).optional(),
  size: Size.optional(),
  rotate: Angle.optional(),
  scale: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
  flip: z.enum(["none", "x", "y", "xy"]).optional(),
  coords: z.string().optional(),
  opacity: z.number().min(0).max(1).optional(),
  blend: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion"]).optional(),
  z: z.number().optional(),
  clip: Clip.optional(),
  mask: Mask.optional(),
  visible: z.boolean().optional(),
  style: z.union([z.string(), z.array(z.string())]).optional(),
  hand: Hand.optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  separation: z.string().optional(),
  note: z.string().optional(),
  stack: z.enum(["over", "under"]).optional(),
};

const TextValue = z.union([z.string(), z.record(z.string(), z.string())]);

const typo = {
  font: z.string().optional(),
  fontSize: Length.optional(),
  fontScale: z.number().positive().optional(),
  glyphScale: z.tuple([z.number(), z.number()]).optional(),
  weight: z.number().optional(),
  color: z.union([ColorStr, Paint]).optional(),
  writing: z.enum(["vertical", "horizontal"]).optional(),
  lineHeight: z.union([z.number(), Length]).optional(),
  letterSpacing: Length.optional(),
  align: z.enum(["start", "center", "end", "justify"]).optional(),
  blockAlign: z.enum(["start", "center", "end"]).optional(),
  wrap: z.enum(["auto", "none", "char", "phrase", "balanced"]).optional(),
  maxChars: z.number().positive().optional(),
  maxExtent: Length.optional(),
  kinsoku: z.enum(["strict", "normal", "loose", "none"]).optional(),
  hanging: z.boolean().optional(),
  punctCompress: z.enum(["none", "halfwidth"]).optional(),
  tcy: z.union([z.enum(["auto", "none"]), z.object({ digits: z.number().optional(), marks: z.boolean().optional(), latin: z.number().optional() }).strict()]).optional(),
  latin: z.enum(["auto", "rotate", "upright"]).optional(),
  ruby: z.object({ size: z.number().optional(), font: z.string().optional(), position: z.enum(["auto", "right", "left", "over", "under"]).optional(), align: z.enum(["center", "start"]).optional(), overhang: z.number().optional(), reserve: z.enum(["auto", "none"]).optional() }).strict().optional(),
  emphasis: z.object({ mark: z.string().optional(), position: z.string().optional(), size: z.number().optional(), color: ColorStr.optional() }).strict().optional(),
  lettering: z
    .object({ mode: z.enum(["typeset", "hand"]).optional(), rotate: Angle.optional(), offset: Length.optional(), scale: z.number().optional(), baseline: z.object({ amplitude: Length, wavelength: Length }).strict().optional(), wobble: Length.optional(), spacing: Length.optional() })
    .strict()
    .optional(),
  markup: z.boolean().optional(),
  normalize: z
    .object({ ellipsis: z.boolean().optional(), ellipsisPair: z.boolean().optional(), dash: z.boolean().optional(), fullwidthMarks: z.boolean().optional(), waveDash: z.boolean().optional(), spaceAfterMarks: z.boolean().optional(), dropTrailingPeriod: z.boolean().optional(), spaces: z.boolean().optional() })
    .strict()
    .optional(),
  features: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  lang: z.string().optional(),
};

const ShapeObj = z
  .object({
    kind: z.string(),
    irregularity: z.number().min(0).optional(),
    tilt: RangeOf(Angle).optional(),
    squareness: z.number().optional(),
    egg: z.number().optional(),
    radius: Length.optional(),
    ruler: z.boolean().optional(),
    join: z.enum(["clean", "overshoot", "gap"]).optional(),
    lobes: z.union([z.number(), z.literal("auto")]).optional(),
    lobeSize: z.tuple([z.number(), z.number()]).optional(),
    depth: RangeOf(z.number()).optional(),
    count: z.union([z.number(), z.literal("auto")]).optional(),
    angleJitter: z.number().optional(),
    curve: z.number().optional(),
    inner: z.enum(["ellipse", "cloud"]).optional(),
    waves: z.union([z.number(), z.literal("auto")]).optional(),
    amplitude: Length.optional(),
    waveform: z.enum(["sine", "zigzag", "irregular"]).optional(),
    secondary: z.boolean().optional(),
    corners: z.number().optional(),
    jag: z.number().optional(),
    points: z.array(z.tuple([z.number(), z.number()])).optional(),
    d: z.string().optional(),
    textArea: Rect.optional(),
    lineLength: RangeOf(Length).optional(),
    thickness: RangeOf(Length).optional(),
    strokes: z.union([z.number(), z.literal("auto")]).optional(),
  })
  .strict();

export const Tail = z
  .object({
    kind: z.enum(["wedge", "bubbles", "line", "zigzag", "none"]).optional(),
    to: Point.optional(),
    direction: Angle.optional(),
    length: Length.optional(),
    maxLength: Length.optional(),
    gap: Length.optional(),
    width: Length.optional(),
    widthScale: z.number().optional(),
    bend: z.number().min(-1).max(1).optional(),
    sideCurve: z.number().min(0).max(1).optional(),
    root: z.union([z.literal("auto"), Angle]).optional(),
    offscreen: z.enum(["top", "right", "bottom", "left"]).optional(),
    count: z.number().int().optional(),
    bubbleSize: Length.optional(),
    shrink: z.number().optional(),
    segments: z.number().int().optional(),
  })
  .strict();

const balloonProps = {
  ...common,
  ...typo,
  text: TextValue.optional(),
  who: z.string().optional(),
  as: z.string().optional(),
  shape: ShapeObj.optional(),
  stroke: Stroke.optional(),
  fill: Paint.optional(),
  fillOpacity: z.number().optional(),
  tail: Tail.optional(),
  tails: z.array(Tail).optional(),
  minSize: Size.optional(),
  maxSize: Size.optional(),
  aspect: z.union([z.number(), z.literal("auto")]).optional(),
  aspectRange: z.tuple([z.number(), z.number()]).optional(),
  padding: z.tuple([Length, Length]).optional(),
  textOffset: z.tuple([Length, Length]).optional(),
  textOutline: Outline.optional(),
  overflow: z.enum(["shrink", "grow", "clip", "error"]).optional(),
  minFontScale: z.number().min(0).max(1).optional(),
  connect: z.union([z.object({ to: z.string(), style: z.enum(["neck", "overlap", "line"]).optional(), width: Length.optional() }).strict(), z.array(z.object({ to: z.string(), style: z.enum(["neck", "overlap", "line"]).optional(), width: Length.optional() }).strict())]).optional(),
  autoPlace: z.union([z.enum(["auto", "flow"]), z.object({ mode: z.enum(["auto", "flow"]).optional(), inset: Length.optional(), weights: z.record(z.string(), z.number()).optional(), threshold: z.number().optional() }).strict()]).optional(),
  from: z.enum(["top", "right", "bottom", "left"]).optional(),
};

const Filter = z.union([z.string(), z.record(z.string(), z.unknown())]);

const imageProps = {
  ...common,
  src: z.string().optional(),
  fit: z.enum(["cover", "contain", "fill", "none", "width", "height"]).optional(),
  focus: z.union([z.tuple([z.number(), z.number()]), z.string()]).optional(),
  zoom: z.number().positive().optional(),
  crop: Rect.optional(),
  character: z.string().optional(),
  anchors: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
  regions: z.record(z.string(), Rect).optional(),
  filters: z.array(Filter).optional(),
  outline: Outline.optional(),
  shadow: z.object({ offset: z.tuple([Length, Length]).optional(), blur: Length.optional(), color: ColorStr.optional() }).strict().optional(),
  smoothing: z.enum(["high", "medium", "none"]).optional(),
  placeholder: z.string().optional(),
};

const textProps = {
  ...common,
  ...typo,
  text: TextValue.optional(),
  who: z.string().optional(),
  background: Paint.optional(),
  padding: z.tuple([Length, Length]).optional(),
  stroke: Stroke.optional(),
  outline: Outline.optional(),
  shadow: z.object({ offset: z.tuple([Length, Length]).optional(), blur: Length.optional(), color: ColorStr.optional() }).strict().optional(),
  overflow: z.enum(["shrink", "clip", "error"]).optional(),
};

const sfxProps = {
  ...textProps,
  path: z.object({ kind: z.enum(["line", "arc", "wave", "points"]), angle: Angle.optional(), radius: Length.optional(), amplitude: Length.optional(), wavelength: Length.optional(), points: z.array(z.tuple([Length, Length])).optional() }).strict().optional(),
  grow: z.number().optional(),
  perChar: z.object({ rotate: RangeOf(Angle).optional(), scale: RangeOf(z.number()).optional(), jitter: Length.optional() }).strict().optional(),
  chars: z.array(z.object({ index: z.number().int(), rotate: Angle.optional(), scale: z.number().optional(), offset: z.tuple([Length, Length]).optional(), color: ColorStr.optional() }).strict()).optional(),
  distort: z.object({ roughen: z.number().optional(), warp: z.number().optional(), skew: Angle.optional(), perspective: z.tuple([z.number(), z.number()]).optional(), bulge: z.number().optional() }).strict().optional(),
  edge: Stroke.optional(),
  hollow: z.boolean().optional(),
  motion: z.unknown().optional(),
};

const effectProps = z
  .object({ ...common, type: z.literal("effect"), kind: z.string() })
  .catchall(z.unknown());

const fillProps = {
  ...common,
  region: Region.optional(),
  paint: Paint.optional(),
  edge: z.enum(["clean", "cut", "soft"]).optional(),
  edgeWidth: Length.optional(),
  erase: z.array(z.record(z.string(), z.unknown())).optional(),
};

const markProps = z.object({ ...common, type: z.literal("mark"), kind: z.string() }).catchall(z.unknown());

const drawProps = {
  ...common,
  kind: z.enum(["line", "polyline", "curve", "arrow", "rect", "ellipse", "polygon", "path"]),
  points: z.array(Point).optional(),
  d: z.string().optional(),
  radius: Length.optional(),
  closed: z.boolean().optional(),
  stroke: Stroke.optional(),
  fill: Paint.optional(),
  ruler: z.boolean().optional(),
  head: z.object({ start: z.string().optional(), end: z.string().optional(), size: Length.optional() }).strict().optional(),
};

export const Element: z.ZodType = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("image"), ...imageProps }).strict(),
    z.object({ type: z.literal("balloon"), ...balloonProps }).strict(),
    z.object({ type: z.literal("text"), ...textProps }).strict(),
    z.object({ type: z.literal("sfx"), ...sfxProps }).strict(),
    effectProps,
    z.object({ type: z.literal("fill"), ...fillProps }).strict(),
    markProps,
    z.object({ type: z.literal("draw"), ...drawProps }).strict(),
    z.object({ type: z.literal("group"), ...common, children: z.array(Element), defaults: z.record(z.string(), z.unknown()).optional() }).strict(),
    z
      .object({
        type: z.literal("scatter"),
        ...common,
        items: z.array(z.record(z.string(), z.unknown())),
        region: Region.optional(),
        count: z.number().int().optional(),
        rate: z.number().optional(),
        itemScale: RangeOf(z.number()).optional(),
        itemRotate: RangeOf(Angle).optional(),
        orient: z.enum(["random", "radial", "tangent"]).optional(),
        minDistance: Length.optional(),
        avoid: z.array(Region).optional(),
        falloff: z.unknown().optional(),
      })
      .strict(),
  ]),
);

const DialogueLine = z.object({ ...balloonProps, who: z.string().optional(), text: TextValue.optional() }).strict();

const Defaults = z.record(z.string(), z.unknown());

const BorderShape = z.object({ kind: z.enum(["rect", "ellipse", "cloud", "rounded"]), radius: Length.optional() }).catchall(z.unknown());

const Panel = z
  .object({
    id: z.string().optional(),
    box: Rect.optional(),
    polygon: z.array(z.tuple([Length, Length])).optional(),
    coords: z.enum(["baseFrame", "page"]).optional(),
    shape: BorderShape.optional(),
    border: Stroke.optional(),
    bleed: z.union([z.array(z.enum(["top", "right", "bottom", "left"])), z.literal(false)]).optional(),
    background: Paint.optional(),
    layers: z.array(Element).optional(),
    dialogue: z.array(DialogueLine).optional(),
    defaults: Defaults.optional(),
    hand: Hand.optional(),
    seed: z.number().int().min(0).optional(),
    z: z.number().optional(),
    order: z.number().int().positive().optional(),
    overlay: z.boolean().optional(),
    knockout: Length.optional(),
    visible: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict();

const SplitNode: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("panel"),
    z.object({ panel: z.string() }).strict(),
    z
      .object({
        split: z.enum(["rows", "cols"]),
        sizes: z.array(z.union([z.number(), Length])).optional(),
        slant: z.array(Length).optional(),
        gutter: Length.optional(),
        children: z.array(SplitNode),
      })
      .strict(),
  ]),
);

const Layout = z.union([
  z.literal("free"),
  z
    .object({
      rows: z.array(z.object({ cols: z.array(z.number()).optional(), height: z.union([z.number(), Length]).optional(), slant: Length.optional(), colSlant: z.array(Length).optional(), gutter: z.object({ col: Length.optional() }).strict().optional() }).strict()).optional(),
      split: z.enum(["rows", "cols"]).optional(),
      sizes: z.array(z.union([z.number(), Length])).optional(),
      slant: z.array(Length).optional(),
      children: z.array(SplitNode).optional(),
      template: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      free: z.boolean().optional(),
      gutter: z.union([Length, z.object({ col: Length.optional(), row: Length.optional() }).strict()]).optional(),
      area: z.union([z.enum(["baseFrame", "trim", "bleed"]), Rect]).optional(),
    })
    .strict(),
]);

const BaseFrame = z.union([
  z.literal("trim"),
  z.object({ size: z.tuple([Length, Length]).optional(), offset: z.tuple([Length, Length]).optional(), margins: z.object({ top: Length, bottom: Length, inner: Length, outer: Length }).strict().optional() }).strict(),
]);

const pageSettings = {
  size: z.union([z.string(), z.tuple([Length, Length])]).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
  units: z.enum(["mm", "px", "pt", "in", "cm"]).optional(),
  dpi: z.number().positive().max(2400).optional(),
  bleed: Length.optional(),
  baseFrame: BaseFrame.optional(),
  safeArea: z.object({ inset: Length }).strict().optional(),
  gutter: z.union([Length, z.object({ col: Length.optional(), row: Length.optional() }).strict()]).optional(),
  background: Paint.optional(),
  color: z.enum(["mono", "color"]).optional(),
  foldMargin: Length.optional(),
};

const Page = z
  .object({
    ...pageSettings,
    id: z.string().optional(),
    type: z.enum(["page", "spread", "blank", "strip"]).optional(),
    layout: Layout.optional(),
    panels: z.array(Panel).optional(),
    layers: z.array(Element).optional(),
    defaults: Defaults.optional(),
    hand: Hand.optional(),
    seed: z.number().int().min(0).optional(),
    number: z.union([z.boolean(), z.object({ hidden: z.boolean() }).strict()]).optional(),
    title: z.string().optional(),
    include: z.string().optional(),
  })
  .strict();

const FontDef = z.union([
  z.object({ src: z.string(), index: z.number().int().optional(), variations: z.record(z.string(), z.number()).optional(), bold: z.string().optional(), fallback: z.array(z.string()).optional() }).strict(),
  z.object({ alias: z.string() }).strict(),
  z.object({ catalog: z.string(), weight: z.number().optional(), bold: z.string().optional(), fallback: z.array(z.string()).optional() }).strict(),
  z.object({ compose: z.array(z.object({ font: z.string(), ranges: z.array(z.string()).optional(), scale: z.number().optional(), baselineShift: Length.optional() }).strict()), fallback: z.array(z.string()).optional(), bold: z.string().optional() }).strict(),
  z.object({ system: z.string() }).strict(),
]);

const Asset = z
  .object({
    src: z.string(),
    kind: z.enum(["art", "lineart", "background", "photo", "texture"]).optional(),
    ppi: z.number().positive().optional(),
    character: z.string().optional(),
    anchors: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
    regions: z.record(z.string(), Rect).optional(),
    crop: Rect.optional(),
    filters: z.array(Filter).optional(),
    whiteToAlpha: z.union([z.boolean(), z.number()]).optional(),
    blend: z.string().optional(),
  })
  .strict();

const Character = z
  .object({
    name: z.string().optional(),
    color: z.string().optional(),
    anchorPriority: z.array(z.string()).optional(),
    balloon: z.record(z.string(), z.unknown()).optional(),
    text: z.record(z.string(), z.unknown()).optional(),
    voice: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

const PageNumbers = z
  .object({
    enabled: z.boolean().optional(),
    show: z.enum(["print", "always", "never"]).optional(),
    start: z.number().int().optional(),
    position: z.enum(["bottom-outer", "bottom-center", "bottom-inner", "top-outer", "top-center", "outer-middle"]).optional(),
    margin: z.tuple([Length, Length]).optional(),
    font: z.string().optional(),
    fontSize: Length.optional(),
    color: z.string().optional(),
    format: z.string().optional(),
    writing: z.enum(["horizontal", "vertical"]).optional(),
    hidden: z.boolean().optional(),
    countBlank: z.boolean().optional(),
    skip: z.array(z.string()).optional(),
  })
  .strict();

export const Document = z
  .object({
    mangacli: z.literal(1),
    engine: z.number().int().positive().optional(),
    meta: z.object({ title: z.string().optional(), subtitle: z.string().optional(), author: z.union([z.string(), z.array(z.string())]).optional(), lang: z.string().optional(), description: z.string().optional(), copyright: z.string().optional(), keywords: z.array(z.string()).optional() }).strict().optional(),
    book: z.object({ binding: z.enum(["right", "left"]).optional(), readingDirection: z.enum(["rtl", "ltr"]).optional(), firstPageSide: z.enum(["left", "right"]).optional(), pageNumbers: PageNumbers.optional(), signature: z.union([z.number().int(), z.literal(false)]).optional() }).strict().optional(),
    page: z.object(pageSettings).strict().optional(),
    seed: z.number().int().min(0).max(4294967295).optional(),
    hand: Hand.optional(),
    fonts: z.record(z.string(), FontDef).optional(),
    fontSet: z.string().optional(),
    assets: z.record(z.string(), Asset).optional(),
    characters: z.record(z.string(), Character).optional(),
    styles: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    defaults: Defaults.optional(),
    locales: z.record(z.string(), z.object({ defaults: Defaults.optional(), fonts: z.record(z.string(), FontDef).optional(), styles: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict()).optional(),
    output: z.record(z.string(), z.unknown()).optional(),
    imports: z.array(z.string()).optional(),
    pages: z.array(Page).min(1),
  })
  .strict();

export type DocumentInput = z.input<typeof Document>;
