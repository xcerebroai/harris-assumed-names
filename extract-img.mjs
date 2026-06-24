// Extract the CCITT G4 image stream from the scanned PDF, wrap as a TIFF,
// and transcode to PNG with sharp to visually confirm it is a scanned page.
import fs from 'node:fs';
import sharp from 'sharp';

const file = process.argv[2] || './recon-out/doc-243834192.pdf';
const buf = fs.readFileSync(file);
const s = buf.latin1Slice(0, buf.length);

// Find the image XObject dict containing CCITTFaxDecode
const imgIdx = s.indexOf('CCITTFaxDecode');
if (imgIdx < 0) throw new Error('no CCITTFaxDecode');
const dictStart = s.lastIndexOf('<<', imgIdx);
const dictEnd = s.indexOf('stream', imgIdx);
const dict = s.slice(dictStart, dictEnd);
const num = (re) => { const m = dict.match(re); return m ? parseInt(m[1], 10) : null; };
const width = num(/\/Width\s+(\d+)/);
const height = num(/\/Height\s+(\d+)/);
const K = num(/\/K\s+(-?\d+)/);
const cols = num(/\/Columns\s+(\d+)/) || width;
const blackIs1 = /\/BlackIs1\s+true/.test(dict);
const byteAlign = /\/EncodedByteAlign\s+true/.test(dict);
console.log({ width, height, K, cols, blackIs1, byteAlign, dict: dict.slice(0, 200) });

// Stream bytes: after 'stream' + EOL, until 'endstream'
let p = dictEnd + 'stream'.length;
if (buf[p] === 0x0d) p++;
if (buf[p] === 0x0a) p++;
let end = s.indexOf('endstream', p);
// trim trailing EOL before endstream
let dataEnd = end;
if (buf[dataEnd - 1] === 0x0a) dataEnd--;
if (buf[dataEnd - 1] === 0x0d) dataEnd--;
const img = buf.subarray(p, dataEnd);
console.log('ccitt stream bytes:', img.length);

// Build a minimal single-strip Group-4 TIFF (little-endian)
function buildTiff(data, w, h, photometric) {
  const entries = [
    [256, 4, 1, w],          // ImageWidth
    [257, 4, 1, h],          // ImageLength
    [258, 3, 1, 1],          // BitsPerSample
    [259, 3, 1, 4],          // Compression = CCITT Group 4
    [262, 3, 1, photometric],// PhotometricInterpretation (0=WhiteIsZero)
    [273, 4, 1, 0],          // StripOffsets (patched below)
    [277, 3, 1, 1],          // SamplesPerPixel
    [278, 4, 1, h],          // RowsPerStrip
    [279, 4, 1, data.length],// StripByteCounts
  ];
  const numEntries = entries.length;
  const ifdSize = 2 + numEntries * 12 + 4;
  const headerSize = 8;
  const dataOffset = headerSize + ifdSize;
  const total = dataOffset + data.length;
  const out = Buffer.alloc(total);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4); // IFD at offset 8
  let o = 8;
  out.writeUInt16LE(numEntries, o); o += 2;
  for (const [tag, type, count, value] of entries) {
    out.writeUInt16LE(tag, o);
    out.writeUInt16LE(type, o + 2);
    out.writeUInt32LE(count, o + 4);
    out.writeUInt32LE(tag === 273 ? dataOffset : value, o + 8);
    o += 12;
  }
  out.writeUInt32LE(0, o); // next IFD = 0
  data.copy(out, dataOffset);
  return out;
}

const photometric = blackIs1 ? 1 : 0;
const tiff = buildTiff(img, cols, height, photometric);
fs.writeFileSync('./recon-out/extracted.tif', tiff);
console.log('wrote extracted.tif', tiff.length);

try {
  await sharp('./recon-out/extracted.tif')
    .resize({ width: 900 })
    .png()
    .toFile('./recon-out/extracted.png');
  console.log('wrote extracted.png');
} catch (e) {
  console.log('sharp error:', e.message);
}
