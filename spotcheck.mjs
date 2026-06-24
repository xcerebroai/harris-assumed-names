import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const db = new Database('./data/assumed_names.db', { readonly: true });
const rows = db.prepare("SELECT film_code, business_street, business_city, business_state, business_zip, residence_street, residence_city, residence_state, residence_zip FROM filings WHERE image_status='extracted' ORDER BY film_code LIMIT 10").all();
db.close();

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext(); const page = await ctx.newPage();
let captured = null;
page.on('request', (r) => { if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() }; });
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';

for (const r of rows) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', r.film_code);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  await page.waitForSelector(docSel, { timeout: 8000 }).catch(()=>{});
  const href = (await page.$$eval(docSel, (as) => as.map((a) => a.href)))[0];
  captured = null;
  await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.waitForTimeout(1600);
  if (!captured) { console.log(r.film_code, 'no capture'); continue; }
  const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000 });
  const pdf = await resp.body();
  const { png, width: W, height: H } = await pdfPage1ToSharp(pdf);
  // single crop covering business + residence address regions (0.13 .. 0.50)
  await sharp(png).extract({ left: 0, top: Math.round(0.13 * H), width: W, height: Math.round(0.37 * H) })
    .resize({ width: 1500 }).png().toFile(`./recon-out/spot-${r.film_code}.png`);
  console.log(`${r.film_code} | OCR biz: ${r.business_street} / ${r.business_city} / ${r.business_state} / ${r.business_zip} | OCR res: ${r.residence_street} / ${r.residence_city} / ${r.residence_state} / ${r.residence_zip}`);
}
await b.close();
