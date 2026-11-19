// Minimal PDF writer: one rasterized page image per PDF page, with Trim/Bleed boxes (spec 10.4.3).
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { type PdfXOptions, pdfX4Metadata, xmpText } from "./pdfx.js";

export interface PdfPageImage {
  /** RGBA pixels */
  rgba: Uint8ClampedArray;
  packed?: Uint8Array;
  width: number;
  height: number;
  dpi: number;
  colorMode: "color" | "gray" | "mono";
  /** trim and bleed rectangles in pixels (origin top-left) */
  trim: { x: number; y: number; w: number; h: number };
  bleed: { x: number; y: number; w: number; h: number };
  /** keep transparency as a soft mask (otherwise composite onto white) */
  transparent?: boolean;
}

function pdfString(s: string): string {
  // UTF-16BE with BOM for non-ASCII
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => "\\" + c)})`;
  const b = Buffer.from("﻿" + s, "utf16le").swap16();
  return `<${b.toString("hex")}>`;
}

export class PdfWriter {
  private objects: (Buffer | null)[] = [];
  private pages: number[] = [];

  constructor(private info: { title?: string; author?: string; date?: Date } = {}, private pdfX?: Omit<PdfXOptions, "iccProfile"> & { iccProfile: Buffer }) {
    this.objects.push(null, null); // 1: catalog, 2: pages (filled in build)
  }

  private add(body: Buffer | string): number {
    this.objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return this.objects.length;
  }

  private stream(dict: string, data: Buffer): number {
    return this.add(Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
  }

  addPage(p0: PdfPageImage) {
    const { width: w, height: h } = p0;
    if (this.pdfX && (p0.colorMode !== "mono" || p0.transparent)) throw new Error("PDF/X requires opaque 1-bit monochrome pages");
    // alpha: a soft mask when asked for (gray/color), else composite onto paper white
    let hasAlpha = false;
    for (let i = 3; i < p0.rgba.length; i += 4)
      if (p0.rgba[i] < 255) {
        hasAlpha = true;
        break;
      }
    const keepAlpha = hasAlpha && !!p0.transparent && p0.colorMode !== "mono";
    let rgba = p0.rgba;
    if (hasAlpha && !keepAlpha) {
      rgba = new Uint8ClampedArray(p0.rgba);
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3] / 255;
        rgba[i] = rgba[i] * a + 255 * (1 - a);
        rgba[i + 1] = rgba[i + 1] * a + 255 * (1 - a);
        rgba[i + 2] = rgba[i + 2] * a + 255 * (1 - a);
        rgba[i + 3] = 255;
      }
    }
    const p = { ...p0, rgba };
    let smask = "";
    if (keepAlpha) {
      const a = Buffer.alloc(w * h);
      for (let i = 0; i < w * h; i++) a[i] = p.rgba[i * 4 + 3];
      const sm = this.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(a, { level: 6 }));
      smask = ` /SMask ${sm} 0 R`;
    }
    let img: number;
    if (p.colorMode === "mono") {
      const rowBytes = Math.ceil(w / 8);
      const raw = p.packed ?? Buffer.alloc(rowBytes * h);
      if (!p.packed) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (p.rgba[(y * w + x) * 4] >= 128) raw[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      // PDF/X maps the same bits to explicit process inks: 100% K or no ink.
      const colorSpace = this.pdfX ? "[/Indexed /DeviceCMYK 1 <000000FF00000000>]" : "/DeviceGray";
      img = this.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${colorSpace} /BitsPerComponent 1 /Filter /FlateDecode`, deflateSync(raw, { level: 6 }));
    } else if (p.colorMode === "gray") {
      const raw = Buffer.alloc(w * h);
      for (let i = 0; i < w * h; i++) raw[i] = p.rgba[i * 4];
      img = this.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode${smask}`, deflateSync(raw, { level: 6 }));
    } else {
      const raw = Buffer.alloc(w * h * 3);
      for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
        raw[j] = p.rgba[i];
        raw[j + 1] = p.rgba[i + 1];
        raw[j + 2] = p.rgba[i + 2];
      }
      img = this.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask}`, deflateSync(raw, { level: 6 }));
    }
    const k = 72 / p.dpi;
    const W = w * k;
    const H = h * k;
    const box = (r: { x: number; y: number; w: number; h: number }) => `[${f(r.x * k)} ${f(H - (r.y + r.h) * k)} ${f((r.x + r.w) * k)} ${f(H - r.y * k)}]`;
    const content = this.stream("", Buffer.from(`q ${f(W)} 0 0 ${f(H)} 0 0 cm /Im0 Do Q`, "latin1"));
    let bleed = p.bleed;
    if (this.pdfX) {
      // Independently rounded bleed and trim pixels can overrun the raster by one pixel.
      const x = Math.max(0, bleed.x), y = Math.max(0, bleed.y);
      bleed = { x, y, w: Math.min(w, bleed.x + bleed.w) - x, h: Math.min(h, bleed.y + bleed.h) - y };
      const { trim } = p;
      if (trim.x < bleed.x || trim.y < bleed.y || trim.x + trim.w > bleed.x + bleed.w ||
          trim.y + trim.h > bleed.y + bleed.h || trim.w <= 0 || trim.h <= 0) {
        throw new Error("OUTPUT_MODE_UNSUPPORTED: PDF/X requires a nonempty TrimBox within the BleedBox");
      }
    }
    const page = this.add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /TrimBox ${box(p.trim)} /BleedBox ${box(bleed)} /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    this.pages.push(page);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  build(): Buffer {
    const { pdfX } = this;
    const producer = "mangacli";
    const isX1a = pdfX?.version === "1a";
    const title = pdfX ? xmpText(this.info.title || "Untitled") : this.info.title;
    const author = pdfX && this.info.author ? xmpText(this.info.author) : this.info.author;
    const ms = this.info.date?.getTime() ?? NaN;
    const date = pdfX ? new Date(Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000) * 1000) : this.info.date;
    let catalog = "<< /Type /Catalog /Pages 2 0 R";
    if (pdfX) {
      const profile = this.stream("/N 4 /Filter /FlateDecode", deflateSync(pdfX.iccProfile));
      const condition = pdfX.outputCondition.trim();
      const asciiCondition = /^[\x20-\x7e]+$/.test(condition) ? ` /OutputCondition ${pdfString(condition)}` : "";
      const intent = this.add(`<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (Custom)${asciiCondition} /Info ${pdfString(condition)} /DestOutputProfile ${profile} 0 R >>`);
      catalog += ` /OutputIntents [${intent} 0 R]`;
      if (!isX1a) {
        const metadata = this.stream("/Type /Metadata /Subtype /XML", pdfX4Metadata(title!, producer, date!, author));
        catalog += ` /Metadata ${metadata} 0 R`;
      }
    }
    this.objects[0] = Buffer.from(catalog + " >>", "latin1");
    this.objects[1] = Buffer.from(`<< /Type /Pages /Kids [${this.pages.map((p) => `${p} 0 R`).join(" ")}] /Count ${this.pages.length} >>`, "latin1");
    const infoParts = [`/Producer ${pdfString(producer)}`];
    if (title) infoParts.push(`/Title ${pdfString(title)}`);
    if (author) infoParts.push(`/Author ${pdfString(author)}`);
    const timestamp = date && `(D:${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z)`;
    if (timestamp) infoParts.push(`/CreationDate ${timestamp}`);
    if (pdfX) infoParts.push(`/ModDate ${timestamp}`, "/Trapped /False");
    if (isX1a) infoParts.push("/GTS_PDFXVersion (PDF/X-1:2001)", "/GTS_PDFXConformance (PDF/X-1a:2001)");
    const info = this.add(`<< ${infoParts.join(" ")} >>`);
    const chunks: Buffer[] = [Buffer.from(`%PDF-1.${isX1a ? 3 : 6}\n%\xe2\xe3\xcf\xd3\n`, "latin1")];
    let pos = chunks[0].length;
    const offsets: number[] = [];
    this.objects.forEach((o, i) => {
      offsets.push(pos);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), o!, Buffer.from("\nendobj\n", "latin1")]);
      chunks.push(b);
      pos += b.length;
    });
    let id = "";
    if (pdfX) {
      const hash = createHash("sha256");
      for (const chunk of chunks) hash.update(chunk);
      const digest = hash.digest("hex").slice(0, 32);
      id = ` /ID [<${digest}><${digest}>]`;
    }
    const xref = [`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(xref + `trailer\n<< /Size ${this.objects.length + 1} /Root 1 0 R /Info ${info} 0 R${id} >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  }
}

function f(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}
