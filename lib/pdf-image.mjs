// Extract the page-1 scanned image from a Harris County ViewEdocs PDF.
// These PDFs wrap a single bitonal CCITT-Group-4 image XObject per page.
// We pull the raw CCITT stream, wrap it in a one-strip Group-4 TIFF, and let
// sharp/libvips decode it to a PNG buffer for OCR. Returns { png, width, height }.
import sharp from 'sharp';

export function findFirstCcittImage(buf) {
  const s = buf.latin1Slice(0, buf.length);
  const imgIdx = s.indexOf('CCITTFaxDecode');
  if (imgIdx < 0) return null;
  const dictStart = s.lastIndexOf('<<', imgIdx);
  const dictEnd = s.indexOf('stream', imgIdx);
  // The dict may reference DecodeParms inline or nearby; scan a generous window.
  const win = s.slice(dictStart, dictEnd + 1);
  const numIn = (txt, re) => { const m = txt.match(re); return m ? parseInt(m[1], 10) : null; };
  const width = numIn(win, /\/Width\s+(\d+)/);
  const height = numIn(win, /\/Height\s+(\d+)/);
  const cols = numIn(win, /\/Columns\s+(\d+)/) || width;
  const blackIs1 = /\/BlackIs1\s+true/.test(win);
  if (!width || !height) return null;

  let p = dictEnd + 'stream'.length;
  if (buf[p] === 0x0d) p++;
  if (buf[p] === 0x0a) p++;
  let end = s.indexOf('endstream', p);
  let dataEnd = end;
  if (buf[dataEnd - 1] === 0x0a) dataEnd--;
  if (buf[dataEnd - 1] === 0x0d) dataEnd--;
  const data = buf.subarray(p, dataEnd);
  return { data, width, height, cols, blackIs1 };
}

function buildG4Tiff(data, w, h, photometric) {
  const entries = [
    [256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, 1], [259, 3, 1, 4],
    [262, 3, 1, photometric], [273, 4, 1, 0], [277, 3, 1, 1],
    [278, 4, 1, h], [279, 4, 1, data.length],
  ];
  const n = entries.length;
  const ifdSize = 2 + n * 12 + 4;
  const dataOffset = 8 + ifdSize;
  const out = Buffer.alloc(dataOffset + data.length);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  let o = 8;
  out.writeUInt16LE(n, o); o += 2;
  for (const [tag, type, count, value] of entries) {
    out.writeUInt16LE(tag, o);
    out.writeUInt16LE(type, o + 2);
    out.writeUInt32LE(count, o + 4);
    out.writeUInt32LE(tag === 273 ? dataOffset : value, o + 8);
    o += 12;
  }
  out.writeUInt32LE(0, o);
  data.copy(out, dataOffset);
  return out;
}

// Returns a sharp instance for the decoded page-1 image (caller can crop/clone).
export async function pdfPage1ToSharp(pdfBuf) {
  const img = findFirstCcittImage(pdfBuf);
  if (!img) throw new Error('no CCITT image found in PDF');
  const tiff = buildG4Tiff(img.data, img.cols, img.height, img.blackIs1 ? 1 : 0);
  // Decode TIFF -> raw; return a sharp wrapping a PNG so downstream ops are stable.
  const png = await sharp(tiff).png().toBuffer();
  const meta = await sharp(png).metadata();
  return { png, width: meta.width, height: meta.height };
}
