import fs from 'node:fs';
import Database from 'better-sqlite3';
import { extractAddresses, closeWorker } from './lib/ocr.mjs';

// Ground truth from the rendered forms (street/city/state/zip), business + residence.
const GT = {
  'ASN-2026-104': { b: ['11900 CITY PARK CENTRAL LANE 1301', 'HOUSTON', 'TX', '77047'], r: ['11900 CITY PARK CENTRAL LANE 1301', 'HOUSTON', 'TX', '77047'] },
  'ASN-2026-58':  { b: ['11211 HALL TERRACE COURT', 'HOUSTON', 'TX', '77075'], r: ['11211 HALL TERRACE CT', 'HOUSTON', 'TX', '77075'] },
  'ASN-2026-45':  { b: ['14423 ROSEHEDGE CT', 'HOUSTON', 'TX', '77047'], r: ['14423 ROSEHEDGE CT', 'HOUSTON', 'TX', '77047'] },
  'ASN-2026-34':  { b: ['4410 HATTERAS POINT DR', 'FRIENDSWOOD', 'TX', '77546'], r: ['4410 HATTERAS POINT DR', 'FRIENDSWOOD', 'TX', '77546'] },
  'ASN-2026-25':  { b: ['3202 LONGHORN CIRCLE', 'MANVEL', 'TX', '77578'], r: ['3202 LONGHORN CIRCLE', 'MANVEL', 'TX', '77578'] },
  'ASN-2026-78':  { b: ['5207 DUNLEITH LANE', 'SPRING', 'TX', '77379'], r: ['5207 DUNLEITH LANE', 'SPRING', 'TX', '77379'] },
  'ASN-2026-96':  { b: ['12537 MANOR DR', 'PEARLAND', 'TX', '77581'], r: ['12537 MANOR DR', 'PEARLAND', 'TX', '77581'] },
  'ASN-2026-98':  { b: ['6207 CRAIGWAY RD', 'SPRING', 'TX', '77389'], r: ['6207 CRAIGWAY RD', 'SPRING', 'TX', '77389'] },
};

function lev(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const up = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const SUFFIX = /\b(STREET|ST|LANE|LN|DRIVE|DR|COURT|CT|CIRCLE|CIR|ROAD|RD|AVENUE|AVE|BLVD|PKWY|PARKWAY|WAY|PLACE|PL|TRAIL|TRL|APT|STE|UNIT|#)\b/g;
const leadNum = (s) => (up(s).match(/^\d+/) || [''])[0];
const nameOnly = (s) => up(s).replace(/^\d+/, '').replace(SUFFIX, '').replace(/\s+/g, ' ').trim();

function eqStreet(gt, ocr) {
  if (!ocr) return false;
  if (leadNum(gt) !== leadNum(ocr)) return false;       // house number must match exactly
  return lev(nameOnly(gt), nameOnly(ocr)) <= 2;          // street name, suffix-insensitive
}
const eqCity = (gt, ocr) => !!ocr && lev(up(gt), up(ocr)) <= 2;
const eqExact = (gt, ocr) => !!ocr && up(gt) === up(ocr);

function score(gt, vals) { // vals = [street,city,state,zip]
  return [eqStreet(gt[0], vals[0]), eqCity(gt[1], vals[1]), eqExact(gt[2], vals[2]), eqExact(gt[3], vals[3])];
}

const db = new Database('./data/assumed_names.db', { readonly: true });
const films = Object.keys(GT);
const tally = { newB: [0, 0, 0, 0], newR: [0, 0, 0, 0], oldB: [0, 0, 0, 0], oldR: [0, 0, 0, 0] };
const F = ['street', 'city', 'state', 'zip'];
const mark = (a) => a.map((x) => (x ? '✓' : '✗')).join(' ');

for (const film of films) {
  const png = fs.readFileSync(`./recon-out/spot-${film}.png`);
  const a = await extractAddresses(png);
  const old = db.prepare('SELECT business_street,business_city,business_state,business_zip,residence_street,residence_city,residence_state,residence_zip FROM filings WHERE film_code=?').get(film);
  const newB = [a.business_street, a.business_city, a.business_state, a.business_zip];
  const newR = [a.residence_street, a.residence_city, a.residence_state, a.residence_zip];
  const oldB = [old.business_street, old.business_city, old.business_state, old.business_zip];
  const oldR = [old.residence_street, old.residence_city, old.residence_state, old.residence_zip];
  const sNB = score(GT[film].b, newB), sNR = score(GT[film].r, newR), sOB = score(GT[film].b, oldB), sOR = score(GT[film].r, oldR);
  for (let i = 0; i < 4; i++) { tally.newB[i] += sNB[i]; tally.newR[i] += sNR[i]; tally.oldB[i] += sOB[i]; tally.oldR[i] += sOR[i]; }
  console.log(`\n${film}`);
  console.log(`  GT  B: ${GT[film].b.join(' | ')}`);
  console.log(`  NEW B: ${newB.join(' | ')}   [${mark(sNB)}]`);
  console.log(`  OLD B: ${oldB.join(' | ')}   [${mark(sOB)}]`);
  console.log(`  NEW R: ${newR.join(' | ')}   [${mark(sNR)}]`);
  console.log(`  OLD R: ${oldR.join(' | ')}   [${mark(sOR)}]`);
}
db.close();
await closeWorker();

console.log('\n==== PER-FIELD TALLY over 8 rows (correct/8) ====');
console.log('field    | NEW biz | OLD biz | NEW res | OLD res');
for (let i = 0; i < 4; i++)
  console.log(`${F[i].padEnd(8)} |    ${tally.newB[i]}    |    ${tally.oldB[i]}    |    ${tally.newR[i]}    |    ${tally.oldR[i]}`);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
console.log('\n==== COMBINED biz+res (correct/16) ====');
for (let i = 0; i < 4; i++)
  console.log(`${F[i].padEnd(8)} | NEW ${tally.newB[i] + tally.newR[i]}/16 | OLD ${tally.oldB[i] + tally.oldR[i]}/16`);
console.log(`TOTAL fields | NEW ${sum(tally.newB) + sum(tally.newR)}/64 | OLD ${sum(tally.oldB) + sum(tally.oldR)}/64`);
