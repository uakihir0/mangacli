export const PDF_X_VERSIONS = ["1a", "4"] as const;

export interface PdfXOptions {
  /** PDF/X-1a:2001 or PDF/X-4 (ISO 15930-7:2010). */
  version: typeof PDF_X_VERSIONS[number];
  /** The printer's CMYK output profile (ICC v2 for PDF/X-1a, v2 or v4 for PDF/X-4). */
  iccProfile: Uint8Array;
  /** Human-readable name of the printer's output condition. */
  outputCondition: string;
}

export function pdfXProfile(options: PdfXOptions): Buffer {
  if (!PDF_X_VERSIONS.includes(options.version)) throw new Error("PDF/X version must be 1a or 4");
  if (typeof options.outputCondition !== "string" || !options.outputCondition.trim()) {
    throw new Error("PDF/X requires an output condition name");
  }
  if (!(options.iccProfile instanceof Uint8Array)) throw new Error("PDF/X requires a CMYK ICC output profile");
  const icc = Buffer.from(options.iccProfile.buffer, options.iccProfile.byteOffset, options.iccProfile.byteLength);
  const field = (offset: number) => icc.toString("latin1", offset, offset + 4);
  if (icc.length < 132 || icc.readUInt32BE(0) !== icc.length || field(36) !== "acsp" ||
      field(12) !== "prtr" || field(16) !== "CMYK" || !["Lab ", "XYZ "].includes(field(20))) {
    throw new Error("PDF/X requires a valid CMYK printer ICC profile");
  }
  if (icc[8] !== 2 && !(options.version === "4" && icc[8] === 4)) {
    throw new Error(options.version === "1a" ? "PDF/X-1a:2001 requires an ICC v2 profile" : "PDF/X-4 requires an ICC v2 or v4 profile");
  }
  const count = icc.readUInt32BE(128);
  const dataStart = 132 + count * 12;
  if (!count || dataStart > icc.length) throw new Error("Invalid ICC tag table");
  for (let i = 132; i < dataStart; i += 12) {
    const offset = icc.readUInt32BE(i + 4);
    const size = icc.readUInt32BE(i + 8);
    if (offset < dataStart || offset % 4 || size < 8 || offset + size > icc.length) throw new Error("Invalid ICC tag data");
  }
  return Buffer.from(icc);
}

function xmlText(s: string): string {
  return s.replace(/[&<>\r]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\r": "&#13;" })[c]!);
}

export function xmpText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, "\ufffd");
}

export function pdfX4Metadata(title: string, producer: string, date: Date, author?: string): Buffer {
  const timestamp = date.toISOString();
  const creator = author ? `<dc:creator><rdf:Seq><rdf:li>${xmlText(author)}</rdf:li></rdf:Seq></dc:creator>` : "";
  return Buffer.from(`<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"
   xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:dc="http://purl.org/dc/elements/1.1/">
   <pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
   <pdf:Trapped>False</pdf:Trapped>
   <pdf:Producer>${xmlText(producer)}</pdf:Producer>
   <xmp:CreateDate>${timestamp}</xmp:CreateDate>
   <xmp:ModifyDate>${timestamp}</xmp:ModifyDate>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(title)}</rdf:li></rdf:Alt></dc:title>
   ${creator}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`);
}
