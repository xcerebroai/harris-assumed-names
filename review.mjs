import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import fs from 'node:fs';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const N = parseInt(process.argv[2] || '25', 10);

const db = new Database('./data/assumed_names.db', { readonly: true });
const rows = db.prepare(`SELECT film_code, business_name, business_street, business_city, business_state, business_zip,
  residence_street, residence_city, residence_state, residence_zip
  FROM filings WHERE image_status='extracted' ORDER BY RANDOM() LIMIT ?`).all(N);
db.close();
console.log(`sampled ${rows.length} rows`);

const esc = (s) => (s == null ? '∅' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function headerSVG(w, i, r) {
  const biz = `BIZ:  ${esc(r.business_street)} | ${esc(r.business_city)} | ${esc(r.business_state)} | ${esc(r.business_zip)}`;
  const res = `RES:  ${esc(r.residence_street)} | ${esc(r.residence_city)} | ${esc(r.residence_state)} | ${esc(r.residence_zip)}`;
  return Buffer.from(`<svg width="${w}" height="150" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#fffbe6"/>
    <text x="12" y="36" font-family="monospace" font-size="30" font-weight="bold" fill="#000">#${i + 1}  ${esc(r.film_code)}  (${esc(r.business_name)})</text>
    <text x="12" y="84" font-family="monospace" font-size="30" fill="#0a0">${biz}</text>
    <text x="12" y="130" font-family="monospace" font-size="30" fill="#06c">${res}</text>
  </svg>`);
}

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext(); const page = await ctx.newPage();
let captured = null;
page.on('request', (r) => { if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() }; });
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
fs.mkdirSync('./recon-out/review', { recursive: true });

const htmlRows = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  let labeled = null;
  try {
    await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
    await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', r.film_code);
    await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
    await page.waitForSelector(docSel, { timeout: 8000 }).catch(() => {});
    const href = (await page.$$eval(docSel, (as) => as.map((a) => a.href)))[0];
    captured = null;
    await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1600);
    if (!captured) throw new Error('no capture');
    const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000 });
    const { png, width: W, height: H } = await pdfPage1ToSharp(await resp.body());
    const crop = await sharp(png).extract({ left: 0, top: Math.round(0.13 * H), width: W, height: Math.round(0.37 * H) }).resize({ width: 1400 }).toBuffer();
    const cropMeta = await sharp(crop).metadata();
    const header = headerSVG(1400, i, r);
    labeled = await sharp({ create: { width: 1400, height: 150 + cropMeta.height, channels: 3, background: '#ffffff' } })
      .composite([{ input: header, top: 0, left: 0 }, { input: crop, top: 150, left: 0 }])
      .png().toBuffer();
    const fn = `review/r${String(i + 1).padStart(2, '0')}-${r.film_code}.png`;
    fs.writeFileSync('./recon-out/' + fn, labeled);
    htmlRows.push(`<div class=row><img src="${fn}"></div>`);
    console.log(`#${i + 1} ${r.film_code} ok`);
  } catch (e) {
    htmlRows.push(`<div class=row><b>#${i + 1} ${esc(r.film_code)} — render failed: ${esc(e.message)}</b><br>BIZ ${esc(r.business_street)}/${esc(r.business_city)}/${esc(r.business_state)}/${esc(r.business_zip)} · RES ${esc(r.residence_street)}/${esc(r.residence_city)}/${esc(r.residence_state)}/${esc(r.residence_zip)}</div>`);
    console.log(`#${i + 1} ${r.film_code} FAIL ${e.message.slice(0, 40)}`);
  }
  await page.waitForTimeout(500);
}
await b.close();
fs.writeFileSync('./recon-out/review.html', `<!doctype html><meta charset=utf8><style>body{font-family:sans-serif}.row{margin:18px 0;border-bottom:1px solid #ccc}img{max-width:100%}</style><h1>OCR address review (${rows.length})</h1>${htmlRows.join('\n')}`);
console.log('wrote recon-out/review.html and recon-out/review/*.png');
