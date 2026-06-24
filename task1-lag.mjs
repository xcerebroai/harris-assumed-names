import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const log = (...a) => console.log(...a);
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER;
const PASS = process.env.HCCLERK_PASS;

// Today is 2026-06-23 (per task). Sample these days-back values.
const TODAY = new Date('2026-06-23T12:00:00');
const DAYS_BACK = [7, 14, 30, 60, 90, 180, 365];
const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
const minus = (base, days) => { const d = new Date(base); d.setDate(d.getDate() - days); return d; };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

let captured = null;
page.on('request', (req) => {
  if (/ViewEdocs\.aspx/i.test(req.url()) && req.method() === 'POST') {
    captured = { url: req.url(), postData: req.postData() };
  }
});

async function login() {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton'),
  ]);
}

const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';

async function searchDay(dateStr) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', dateStr);
  await page.fill('#ctl00_ContentPlaceHolder1_txtTo', dateStr);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_btnSearch'),
  ]);
  const cntTxt = (await page.locator('text=/Record\\(s\\) Found/i').first().textContent().catch(() => '')) || '';
  const m = cntTxt.match(/([\d,]+)\s+Record/i);
  const count = m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
  let links = [];
  if (count > 0) {
    await page.waitForSelector(docSel, { timeout: 15000 }).catch(() => {});
    links = await page.$$eval(docSel, (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href })));
  }
  return { count, links };
}

// Find a day with records, walking backward up to 6 days if the target is empty (weekend/holiday)
async function findDayWithRecords(target) {
  for (let i = 0; i <= 6; i++) {
    const d = minus(target, i);
    const ds = fmt(d);
    const { count, links } = await searchDay(ds);
    if (count > 0) return { date: ds, count, links, shifted: i };
  }
  return { date: fmt(target), count: 0, links: [], shifted: 0 };
}

async function classify(href) {
  captured = null;
  await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (!captured) return { result: 'no-post' };
  const resp = await ctx.request.post(captured.url, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: captured.postData || '',
  });
  const ct = resp.headers()['content-type'] || '';
  if (/pdf/i.test(ct)) return { result: 'pdf', ct };
  const body = await resp.text();
  if (/IMAGE NOT FOUND/i.test(body)) return { result: 'image_not_found', ct };
  return { result: 'other', ct, sample: body.slice(0, 120) };
}

const findings = [];
try {
  await login();
  log('logged in\n');
  for (const db of DAYS_BACK) {
    const target = minus(TODAY, db);
    const { date, count, links, shifted } = await findDayWithRecords(target);
    log(`~${db}d back -> ${date}${shifted ? ` (shifted -${shifted}d)` : ''}: ${count} records, ${links.length} links`);
    const sample = links.slice(0, 5);
    const tally = { pdf: 0, image_not_found: 0, other: 0, 'no-post': 0 };
    const detail = [];
    for (const l of sample) {
      const c = await classify(l.href);
      tally[c.result] = (tally[c.result] || 0) + 1;
      detail.push({ film: l.text, ...c });
      log(`   ${l.text}: ${c.result}${c.ct ? ' (' + c.ct + ')' : ''}`);
      await page.waitForTimeout(400 + Math.random() * 600); // polite jitter
    }
    findings.push({ daysBack: db, date, recordCount: count, sampled: sample.length, tally, detail });
    log('');
  }
} catch (e) {
  log('ERROR:', e.message);
} finally {
  fs.writeFileSync('./recon-out/lag-findings.json', JSON.stringify(findings, null, 2));
  await browser.close();
}

log('=== SUMMARY ===');
for (const f of findings) {
  const verdict = f.tally.pdf > 0 ? 'IMAGES PRESENT' : f.tally.image_not_found > 0 ? 'no images' : 'unknown';
  log(`~${f.daysBack}d (${f.date}): pdf=${f.tally.pdf} not_found=${f.tally.image_not_found} other=${f.tally.other} -> ${verdict}`);
}
