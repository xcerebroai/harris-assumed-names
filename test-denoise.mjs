// Score preprocessing variants on the 5 on-disk full-res PDFs. Local only, no DB writes.
import fs from 'node:fs';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';
import { extractAddresses, closeWorker } from './lib/ocr.mjs';

const GT = {
  'ASN-2026-14401': { b: ['3934 FUQUA ST', 'HOUSTON', 'TX', '77047'], r: ['3934 FUQUA ST B', 'HOUSTON', 'TX', '77047'] },
  'ASN-2026-14431': { b: ['1919 TAYLOR STREET STE F', 'HOUSTON', 'TX', '77007'], r: ['2124 LIMRICK DR', 'PEARLAND', 'TX', '77581'] },
  'ASN-2026-14436': { b: ['6113 WILLOW DALE ST', 'HOUSTON', 'TX', '77087'], r: ['6113 WILLOW DALE ST', 'HOUSTON', 'TX', '77087'] },
  'ASN-2026-14470': { b: ['30010 FM 2920', 'WALLER', 'TX', '77484'], r: ['31623 WALLER TOMBALL RD APT 1101', 'WALLER', 'TX', '77484'] },
  'ASN-2026-14467': { b: ['30010 FARM TO MARKET 2920', 'WALLER', 'TX', '77484'], r: ['2030 COVENTRY BAY DR', 'HOUSTON', 'TX', '77089'] },
};
function lev(a, b) { a = a || ''; b = b || ''; const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 0; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
const up = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const SUF = /\b(STREET|ST|LANE|LN|DRIVE|DR|COURT|CT|CIRCLE|CIR|ROAD|RD|AVENUE|AVE|BLVD|PKWY|PARKWAY|WAY|PLACE|PL|TRAIL|TRL|APT|STE|UNIT|#|FM|FARM|MARKET)\b/g;
const leadNum = (s) => (up(s).match(/^\d+/) || [''])[0];
const nameOnly = (s) => up(s).replace(/^\d+/, '').replace(SUF, '').replace(/\s+/g, ' ').trim();
const eqStreet = (g, o) => !!o && leadNum(g) === leadNum(o) && lev(nameOnly(g), nameOnly(o)) <= 2;
const eqCity = (g, o) => !!o && lev(up(g), up(o)) <= 2;
const eqExact = (g, o) => !!o && up(g) === up(o);
const score = (g, v) => [eqStreet(g[0], v[0]), eqCity(g[1], v[1]), eqExact(g[2], v[2]), eqExact(g[3], v[3])];

const VARIANTS = ['full', 'low', 'med3', 'med5', 'med3n', 'med5n', 'despeckle', 'blurthresh', 'blurthresh2'];
const pages = {};
for (const film of Object.keys(GT)) pages[film] = (await pdfPage1ToSharp(fs.readFileSync(`./recon-out/sample-${film}.pdf`))).png;

const F = ['street', 'city', 'state', 'zip'];
const results = {};
for (const pre of VARIANTS) {
  const t = [0, 0, 0, 0];
  for (const film of Object.keys(GT)) {
    const a = await extractAddresses(pages[film], { pre });
    const b = [a.business_street, a.business_city, a.business_state, a.business_zip];
    const r = [a.residence_street, a.residence_city, a.residence_state, a.residence_zip];
    const sb = score(GT[film].b, b), sr = score(GT[film].r, r);
    for (let i = 0; i < 4; i++) t[i] += sb[i] + sr[i];
  }
  results[pre] = t;
  console.log(`${pre.padEnd(11)} street ${t[0]}/10  city ${t[1]}/10  state ${t[2]}/10  zip ${t[3]}/10  | TOTAL ${t.reduce((a, b) => a + b, 0)}/40`);
}
await closeWorker();

console.log('\n==== summary (total /40, baselines: FULL 15, LOW 19) ====');
const ranked = Object.entries(results).map(([k, t]) => [k, t.reduce((a, b) => a + b, 0), t]).sort((a, b) => b[1] - a[1]);
for (const [k, tot, t] of ranked) console.log(`${String(tot).padStart(2)}/40  ${k.padEnd(11)} (zip ${t[3]}/10, state ${t[2]}/10)`);
