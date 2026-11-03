// Minimal PDF writer: one rasterized page image per PDF page, with Trim/Bleed boxes (spec 10.4.3).
import { deflateSync } from "node:zlib";

export interface PdfPageImage {
  /** RGBA pixels */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  dpi: number;
  colorMode: "color" | "gray" | "mono";
  /** trim and bleed rectangles in pixels (origin top-left) */
  trim: { x: number; y: number; w: number; h: number };
  bleed: { x: number; y: number; w: number; h: number };
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

  constructor(private info: { title?: string; author?: string; date?: Date } = {}) {
    this.objects.push(null, null); // 1: catalog, 2: pages (filled in build)
  }

  private add(body: Buffer | string): number {
    this.objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return this.objects.length;
  }

  private stream(dict: string, data: Buffer): number {
    return this.add(Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
  }

  addPage(p: PdfPageImage) {
    const { width: w, height: h } = p;
    let img: number;
    if (p.colorMode === "mono") {
      const rowBytes = Math.ceil(w / 8);
      const raw = Buffer.alloc(rowBytes * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (p.rgba[(y * w + x) * 4] >= 128) raw[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      img = this.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode`, deflateSync(raw, { level: 6 }));
    } else if (p.colorMode === "gray") {
      const raw = Buffer.alloc(w * h);
      for (let i = 0; i < w * h; i++) raw[i] = p.rgba[i * 4];
      img = this.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(raw, { level: 6 }));
    } else {
      const raw = Buffer.alloc(w * h * 3);
      for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
        raw[j] = p.rgba[i];
        raw[j + 1] = p.rgba[i + 1];
        raw[j + 2] = p.rgba[i + 2];
      }
      img = this.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(raw, { level: 6 }));
    }
    const k = 72 / p.dpi;
    const W = w * k;
    const H = h * k;
    const box = (r: { x: number; y: number; w: number; h: number }) => `[${f(r.x * k)} ${f(H - (r.y + r.h) * k)} ${f((r.x + r.w) * k)} ${f(H - r.y * k)}]`;
    const content = this.stream("", Buffer.from(`q ${f(W)} 0 0 ${f(H)} 0 0 cm /Im0 Do Q`, "latin1"));
    const page = this.add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /TrimBox ${box(p.trim)} /BleedBox ${box(p.bleed)} /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    this.pages.push(page);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  build(): Buffer {
    this.objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1");
    this.objects[1] = Buffer.from(`<< /Type /Pages /Kids [${this.pages.map((p) => `${p} 0 R`).join(" ")}] /Count ${this.pages.length} >>`, "latin1");
    const infoParts = [`/Producer ${pdfString("mangacli")}`];
    if (this.info.title) infoParts.push(`/Title ${pdfString(this.info.title)}`);
    if (this.info.author) infoParts.push(`/Author ${pdfString(this.info.author)}`);
    if (this.info.date) infoParts.push(`/CreationDate (D:${this.info.date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z)`);
    const info = this.add(`<< ${infoParts.join(" ")} >>`);
    const chunks: Buffer[] = [Buffer.from("%PDF-1.6\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let pos = chunks[0].length;
    const offsets: number[] = [];
    this.objects.forEach((o, i) => {
      offsets.push(pos);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), o!, Buffer.from("\nendobj\n", "latin1")]);
      chunks.push(b);
      pos += b.length;
    });
    const xref = [`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(xref + `trailer\n<< /Size ${this.objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  }
}

function f(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}
