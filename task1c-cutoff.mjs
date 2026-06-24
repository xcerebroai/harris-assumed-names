import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const log = (...a) => console.log(...a);
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER, PASS = process.env.HCCLERK_PASS;
// Disambiguate the exact cutoff: the two most recent business days with filings.
const DATES = ['06/22/2026', '06/23/2026'];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
let captured = null;
page.on('request', (req) => { if (/ViewEdocs\.aspx/i.test(req.url()) && req.method() === 'POST') captured = { url: req.url(), postData: req.postData() }; });
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';

async function login() {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
}
async function searchDay(d) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', d);
  await page.fill('#ctl00_ContentPlaceHolder1_txtTo', d);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  await page.waitForSelector(docSel, { timeout: 15000 }).catch(()=>{});
  return page.$$eval(docSel, (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href })));
}
// classify with retries so a transient timeout never masquerades as "not found"
async function classify(href) {
  for (let attempt = 0; attempt < 3; attempt++) {
    captured = null;
    await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForTimeout(1500);
    if (!captured) continue;
    try {
      const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000 });
      const ct = resp.headers()['content-type'] || '';
      if (/pdf/i.test(ct)) return 'pdf';
      const body = await resp.text();
      return /IMAGE NOT FOUND/i.test(body) ? 'image_not_found' : 'other';
    } catch (e) { await page.waitForTimeout(1500); }
  }
  return 'err-after-retries';
}

const out = [];
try {
  await login();
  log('logged in\n');
  for (const d of DATES) {
    const links = await searchDay(d);
    // newest 4 + oldest 4 of the day (rows are file-number descending)
    const pick = [...links.slice(0, 4), ...links.slice(-4)].filter((v, i, a) => a.findIndex((x) => x.href === v.href) === i);
    const detail = [];
    for (const l of pick) {
      const r = await classify(l.href);
      detail.push({ film: l.text, r });
      log(`${d}  ${l.text}: ${r}`);
      await page.waitForTimeout(700);
    }
    out.push({ date: d, total: links.length, newest: links[0]?.text, oldest: links[links.length-1]?.text, detail });
    log('');
  }
} catch (e) { log('ERR', e.message); } finally {
  fs.writeFileSync('./recon-out/lag-cutoff.json', JSON.stringify(out, null, 2));
  await browser.close();
}
