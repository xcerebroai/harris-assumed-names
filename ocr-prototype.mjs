import fs from 'node:fs';
import sharp from 'sharp';
import { extractAddresses, closeWorker } from './lib/ocr.mjs';

const files = fs.readdirSync('./recon-out').filter((f) => /^sample-ASN.*\.png$/.test(f));
for (const f of files) {
  const png = fs.readFileSync('./recon-out/' + f);
  const meta = await sharp(png).metadata();
  const r = await extractAddresses(png, meta.width, meta.height);
  console.log('\n===', f, '===');
  console.log('BUSINESS :', r.business_street, '|', r.business_city, '|', r.business_state, '|', r.business_zip);
  console.log('RESIDENCE:', r.residence_street, '|', r.residence_city, '|', r.residence_state, '|', r.residence_zip);
  console.log('raw bs/bc:', r._raw.biz_street, '||', r._raw.biz_csz);
  console.log('raw rs/rc:', r._raw.res_street, '||', r._raw.res_csz);
}
await closeWorker();
