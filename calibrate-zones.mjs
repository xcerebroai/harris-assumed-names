import sharp from 'sharp';
const f = process.argv[2] || './recon-out/sample-ASN-2026-14470.png';
const meta = await sharp(f).metadata();
const W = meta.width, H = meta.height;
console.log('image', W, H);
// Candidate zones as fractions of H (full width).
const zones = {
  business: [0.135, 0.245], // business name + address + city/state/zip band
  residence: [0.40, 0.50],  // first owner residence address + city/state/zip
};
for (const [name, [y0, y1]] of Object.entries(zones)) {
  const top = Math.round(y0 * H), height = Math.round((y1 - y0) * H);
  await sharp(f).extract({ left: 0, top, width: W, height })
    .resize({ width: 1200 }).png().toFile(`./recon-out/zone-${name}.png`);
  console.log(name, 'top', top, 'h', height);
}
