import sharp from 'sharp';
const f = process.argv[2] || './recon-out/sample-ASN-2026-14470.png';
const { width: W, height: H } = await sharp(f).metadata();
const lines = {
  biz_street: [0.176, 0.198],
  biz_csz:    [0.199, 0.223],
  res_street: [0.400, 0.420],
  res_csz:    [0.421, 0.444],
};
for (const [name, [y0, y1]] of Object.entries(lines)) {
  await sharp(f).extract({ left: 0, top: Math.round(y0 * H), width: W, height: Math.round((y1 - y0) * H) })
    .resize({ width: 1400 }).png().toFile(`./recon-out/line-${name}.png`);
}
console.log('done', W, H);
