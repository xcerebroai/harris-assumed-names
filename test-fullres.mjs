// Controlled resolution test: run the anchor extractor on each full-res page (2550px)
// vs the SAME page downscaled to 1500px, to see if zip/state recover at full-res.
// Uses the 5 full-res 2026 PDFs on disk (the only ones available; the 8 ground-truthed
// rows have no PDF on disk). Local only, no server, no DB writes.
import fs from 'node:fs';
import sharp from 'sharp';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';
import { extractAddresses, closeWorker } from './lib/ocr.mjs';

const GT = {
  'ASN-2026-14401': { type: 'standard', b: ['3934 FUQUA ST', 'HOUSTON', 'TX', '77047'], r: ['3934 FUQUA ST B', 'HOUSTON', 'TX', '77047'] },
  'ASN-2026-14431': { type: 'standard', b: ['1919 TAYLOR STREET STE F', 'HOUSTON', 'TX', '77007'], r: ['2124 LIMRICK DR', 'PEARLAND', 'TX', '77581'] },
  'ASN-2026-14436': { type: 'standard', b: ['6113 WILLOW DALE ST', 'HOUSTON', 'TX', '77087'], r: ['6113 WILLOW DALE ST', 'HOUSTON', 'TX', '77087'] },
  'ASN-2026-14470': { type: 'standard', b: ['30010 FM 2920', 'WALLER', 'TX', '77484'], r: ['31623 WALLER TOMBALL RD APT 1101', 'WALLER', 'TX', '77484'] },
  'ASN-2026-14467': { type: 'withdrawal', b: ['30010 FARM TO MARKET 2920', 'WALLER', 'TX', '77484'], r: ['2030 COVENTRY BAY DR', 'HOUSTON', 'TX', '77089'] },
};

function lev(a, b) { a = a || ''; b = b || ''; const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 0; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
const up = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const SUFFIX = /\b(STREET|ST|LANE|LN|DRIVE|DR|COURT|CT|CIRCLE|CIR|ROAD|RD|AVENUE|AVE|BLVD|PKWY|PARKWAY|WAY|PLACE|PL|TRAIL|TRL|APT|STE|UNIT|#|FM|FARM|MARKET)\b/g;
const leadNum = (s) => (up(s).match(/^\d+/) || [''])[0];
const nameOnly = (s) => up(s).replace(/^\d+/, '').replace(SUFFIX, '').replace(/\s+/g, ' ').trim();
const eqStreet = (gt, o) => !!o && leadNum(gt) === leadNum(o) && lev(nameOnly(gt), nameOnly(o)) <= 2;
const eqCity = (gt, o) => !!o && lev(up(gt), up(o)) <= 2;
const eqExact = (gt, o) => !!o && up(gt) === up(o);
const score = (gt, v) => [eqStreet(gt[0], v[0]), eqCity(gt[1], v[1]), eqExact(gt[2], v[2]), eqExact(gt[3], v[3])];
const mark = (a) => a.map((x) => (x ? '✓' : '✗')).join(' ');

const tally = { fullB: [0, 0, 0, 0], lowB: [0, 0, 0, 0], fullR: [0, 0, 0, 0], lowR: [0, 0, 0, 0] };
const tallyStd = JSON.parse(JSON.stringify(tally));
const F = ['street', 'city', 'state', 'zip'];

for (const film of Object.keys(GT)) {
  const pdf = fs.readFileSync(`./recon-out/sample-${film}.pdf`);
  const { png } = await pdfPage1ToSharp(pdf);                       // full-res 2550px page
  const low = await sharp(png).resize({ width: 1500 }).png().toBuffer(); // downscaled
  const aFull = await extractAddresses(png);
  const aLow = await extractAddresses(low);
  const fB = [aFull.business_street, aFull.business_city, aFull.business_state, aFull.business_zip];
  const fR = [aFull.residence_street, aFull.residence_city, aFull.residence_state, aFull.residence_zip];
  const lB = [aLow.business_street, aLow.business_city, aLow.business_state, aLow.business_zip];
  const lR = [aLow.residence_street, aLow.residence_city, aLow.residence_state, aLow.residence_zip];
  const sFB = score(GT[film].b, fB), sFR = score(GT[film].r, fR), sLB = score(GT[film].b, lB), sLR = score(GT[film].r, lR);
  for (let i = 0; i < 4; i++) { tally.fullB[i] += sFB[i]; tally.fullR[i] += sFR[i]; tally.lowB[i] += sLB[i]; tally.lowR[i] += sLR[i]; if (GT[film].type === 'standard') { tallyStd.fullB[i] += sFB[i]; tallyStd.fullR[i] += sFR[i]; tallyStd.lowB[i] += sLB[i]; tallyStd.lowR[i] += sLR[i]; } }
  console.log(`\n${film} [${GT[film].type}]`);
  console.log(`  FULL B: ${fB.join(' | ')}  [${mark(sFB)}]`);
  console.log(`  LOW  B: ${lB.join(' | ')}  [${mark(sLB)}]`);
  console.log(`  FULL R: ${fR.join(' | ')}  [${mark(sFR)}]`);
  console.log(`  LOW  R: ${lR.join(' | ')}  [${mark(sLR)}]`);
}
await closeWorker();

const comb = (t) => F.map((_, i) => t.fullB[i] + t.fullR[i]);
const combL = (t) => F.map((_, i) => t.lowB[i] + t.lowR[i]);
console.log('\n==== ALL 5 rows (biz+res, correct / 10) ====');
console.log('field    | FULL-res | LOW-1500');
F.forEach((f, i) => console.log(`${f.padEnd(8)} |   ${comb(tally)[i]}/10   |   ${combL(tally)[i]}/10`));
console.log('\n==== 4 STANDARD rows only (biz+res, correct / 8) ====');
console.log('field    | FULL-res | LOW-1500');
F.forEach((f, i) => console.log(`${f.padEnd(8)} |   ${comb(tallyStd)[i]}/8   |   ${combL(tallyStd)[i]}/8`));
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(`\nTOTAL all5  : FULL ${sum(comb(tally))}/40  LOW ${sum(combL(tally))}/40`);
console.log(`TOTAL std4  : FULL ${sum(comb(tallyStd))}/32  LOW ${sum(combL(tallyStd))}/32`);
