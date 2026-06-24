import fs from 'node:fs';
import { extractAddresses, closeWorker } from './lib/ocr.mjs';
for (const film of ['ASN-2026-45','ASN-2026-58']) {
  const a = await extractAddresses(fs.readFileSync(`./recon-out/spot-${film}.png`));
  console.log(`\n===== ${film} =====`);
  a._lines.forEach((l,i)=>console.log(String(i).padStart(2),JSON.stringify(l)));
  console.log('GOT biz:',[a.business_street,a.business_city,a.business_state,a.business_zip]);
  console.log('GOT res:',[a.residence_street,a.residence_city,a.residence_state,a.residence_zip]);
}
await closeWorker();
