import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const db = new Database('./data/assumed_names.db', { readonly: true });
const r = db.prepare("SELECT film_code, file_number, file_date FROM filings WHERE film_code='ASN-2026-104'").get();
console.log('DB row:', r);
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext(); const page = await ctx.newPage();
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
async function trySearch(field, val) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill(field, val);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  const cnt = (await page.locator('text=/Record\\(s\\) Found/i').first().textContent().catch(()=>'')) || '';
  const links = await page.$$eval(docSel, (as) => as.map((a) => ({ film: a.textContent.trim(), href: a.href })));
  console.log(`  ${field}=${val}: ${cnt.trim()} | ${links.length} links`, links.slice(0,2).map(l=>l.film));
}
console.log('film code variants:');
await trySearch('#ctl00_ContentPlaceHolder1_txtFilmCd', 'ASN-2026-104');
await trySearch('#ctl00_ContentPlaceHolder1_txtFilmCd', 'ASN-2026-00104');
console.log('file number:');
await trySearch('#ctl00_ContentPlaceHolder1_txtFileNo', r.file_number);
await b.close(); db.close();
