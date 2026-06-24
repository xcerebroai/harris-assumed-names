import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const log = (...a) => console.log(...a);
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER;
const PASS = process.env.HCCLERK_PASS;

// Fine sweep of the last week to pin the publish cutoff.
const DATES = ['06/16/2026','06/17/2026','06/18/2026','06/19/2026','06/20/2026','06/21/2026','06/22/2026','06/23/2026'];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
let captured = null;
page.on('request', (req) => {
  if (/ViewEdocs\.aspx/i.test(req.url()) && req.method() === 'POST') captured = { url: req.url(), postData: req.postData() };
});
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
  const t = (await page.locator('text=/Record\\(s\\) Found/i').first().textContent().catch(() => '')) || '';
  const m = t.match(/([\d,]+)\s+Record/i);
  const count = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  let links = [];
  if (count) { await page.waitForSelector(docSel, { timeout: 15000 }).catch(()=>{}); links = await page.$$eval(docSel, (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href }))); }
  return { count, links };
}
async function classify(href) {
  captured = null;
  await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.waitForTimeout(1200);
  if (!captured) return 'no-post';
  try {
    const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 20000 });
    const ct = resp.headers()['content-type'] || '';
    if (/pdf/i.test(ct)) return 'pdf';
    const body = await resp.text();
    return /IMAGE NOT FOUND/i.test(body) ? 'image_not_found' : 'other';
  } catch (e) {
    return 'err';
  }
}

const out = [];
try {
  await login();
  log('logged in\n');
  for (const d of DATES) {
    const { count, links } = await searchDay(d);
    // sample first 3 (newest) and last 3 (oldest) of the day to catch intra-day boundary
    const pick = [...links.slice(0, 3), ...links.slice(-3)].filter((v, i, a) => a.findIndex((x) => x.href === v.href) === i);
    const tally = { pdf: 0, image_not_found: 0, other: 0, 'no-post': 0 };
    const detail = [];
    for (const l of pick) { const r = await classify(l.href); tally[r] = (tally[r]||0)+1; detail.push({ film: l.text, r }); await page.waitForTimeout(400 + Math.random()*500); }
    log(`${d}: ${count} recs | pdf=${tally.pdf} not_found=${tally.image_not_found} other=${tally.other} | ${detail.map(x=>x.film+':'+x.r).join(', ')}`);
    out.push({ date: d, count, tally, detail });
  }
} catch (e) { log('ERR', e.message); } finally {
  fs.writeFileSync('./recon-out/lag-finegrain.json', JSON.stringify(out, null, 2));
  await browser.close();
}
