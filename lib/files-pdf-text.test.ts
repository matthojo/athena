// Run: npx tsx --test lib/files-pdf-text.test.ts
// A PDF's words are read page by page, up to a page limit and a time limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfText } from "./files";

/** A small, valid PDF with one line of text per page. */
function makePdf(pages: number): Uint8Array {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 12 Tf 72 720 Td (Page ${i + 1} text) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("every page's words, in order", async () => {
  const text = await pdfText(makePdf(3));
  assert.match(text, /Page 1 text[\s\S]*Page 2 text[\s\S]*Page 3 text/);
});

test("no more than the page limit is read", async () => {
  const text = await pdfText(makePdf(5), { pages: 2, ms: 10_000 });
  assert.match(text, /Page 2 text/);
  assert.doesNotMatch(text, /Page 3 text/);
});

test("out of time: nothing more is read", async () => {
  const text = await pdfText(makePdf(3), { pages: 200, ms: 0 }).catch(() => "");
  assert.equal(text, "");
});

test("not a PDF: it throws, and the caller keeps no words", async () => {
  await assert.rejects(pdfText(new TextEncoder().encode("not a pdf")));
});
