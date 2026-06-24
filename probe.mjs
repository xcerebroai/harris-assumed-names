// Throttle probe: fetch 10 documents from the OLDEST pending rows (which should have
// images) using the normal delay/jitter. Read-only — NO DB writes, not the full run.
import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER, PASS = process.env.HCCLERK_PASS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (b, s) => b + Math.floor(Math.random() * s);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';

const db = new Database('./data/assumed_names.db', { readonly: true });
const films = db.prepare("SELECT film_code FROM filings WHERE image_status='pending' ORDER BY file_date ASC LIMIT 10").all().map(r => r.film_code);
db.close();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
let captured = null;
page.on('request', (r) => { if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() }; });

async function login() {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
}
async function freshHref(film) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', film);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  await page.waitForSelector(docSel, { timeout: 8000 }).catch(() => {});
  return (await page.$$eval(docSel, (as) => as.map((a) => a.href)))[0] || null;
}

const results = [];
try {
  await login();
  for (const film of films) {
    let outcome = 'error', ms = null;
    try {
      const href = await freshHref(film);
      if (!href) { results.push({ film, outcome: 'no-link', ms: null }); await sleep(jitter(700, 800)); continue; }
      captured = null;
      await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1400);
      if (!captured) { results.push({ film, outcome: 'no-post', ms: null }); await sleep(jitter(700, 800)); continue; }
      const t0 = Date.now();
      try {
        const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000 });
        ms = Date.now() - t0;
        const ctype = resp.headers()['content-type'] || '';
        if (/pdf/i.test(ctype)) outcome = 'pdf';
        else { const body = await resp.text(); outcome = /IMAGE NOT FOUND/i.test(body) ? 'notfound' : 'other'; }
      } catch (e) { ms = Date.now() - t0; outcome = /[Tt]imeout/.test(e.message) ? 'timeout' : 'error'; }
    } catch (e) { outcome = 'error'; }
    results.push({ film, outcome, ms });
    console.log(`${film.padEnd(16)} ${outcome.padEnd(9)} ${ms == null ? '-' : ms + 'ms'}`);
    await sleep(jitter(700, 800));
  }
} finally {
  await browser.close();
}

const n = results.length;
const succ = results.filter(r => r.outcome === 'pdf').length;
const notfound = results.filter(r => r.outcome === 'notfound').length;
const timeouts = results.filter(r => r.outcome === 'timeout').length;
const errs = results.filter(r => ['error', 'no-post', 'no-link', 'other'].includes(r.outcome)).length;
const times = results.filter(r => r.ms != null && r.outcome === 'pdf').map(r => r.ms);
const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
const allTimes = results.filter(r => r.ms != null).map(r => r.ms);
const avgAll = allTimes.length ? Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length) : null;
console.log('\n=== THROTTLE PROBE (10 oldest pending) ===');
console.log(`PDF (success):     ${succ}/${n}`);
console.log(`IMAGE NOT FOUND:   ${notfound}/${n}`);
console.log(`Timeouts (45s):    ${timeouts}/${n}`);
console.log(`Other errors:      ${errs}/${n}`);
console.log(`Avg response (PDF success): ${avg == null ? 'n/a' : avg + ' ms'}`);
console.log(`Avg response (all completed POSTs): ${avgAll == null ? 'n/a' : avgAll + ' ms'}`);
console.log(`Range: ${allTimes.length ? Math.min(...allTimes) + '–' + Math.max(...allTimes) + ' ms' : 'n/a'}`);
