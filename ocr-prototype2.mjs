import fs from 'node:fs';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const W = 2550, H = 3300;
const crop = (png, y0, y1) => sharp(png).extract({ left: 0, top: Math.round(y0 * H), width: W, height: Math.round((y1 - y0) * H) });
const variants = {
  A_plain: (c) => c.resize({ width: W * 2 }).grayscale().normalize().png().toBuffer(),
  B_thr180: (c) => c.resize({ width: W * 2 }).grayscale().normalize().threshold(180).png().toBuffer(),
};
function flattenWords(data) {
  const out = [];
  for (const b of data.blocks || [])
    for (const p of b.paragraphs || [])
      for (const l of p.lines || [])
        for (const w of l.words || []) out.push({ text: w.text, ...w.bbox, conf: Math.round(w.confidence) });
  return out;
}
const worker = await createWorker('eng');
const png = fs.readFileSync('./recon-out/sample-ASN-2026-14470.png');
for (const [name, fn] of Object.entries(variants)) {
  const buf = await fn(crop(png, 0.135, 0.245));
  const { data } = await worker.recognize(buf, {}, { blocks: true });
  console.log(`\n===== ${name} =====`);
  console.log('TEXT:', data.text.replace(/\n/g, ' | '));
  const words = flattenWords(data);
  console.log('words:', words.length);
  console.log(words.map((w) => `${w.text}@${w.x0}-${w.x1}`).join('  '));
}
await worker.terminate();
