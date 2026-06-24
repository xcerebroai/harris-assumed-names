import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT_DIR || './recon-out';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER;
const PASS = process.env.HCCLERK_PASS;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();

async function login() {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton'),
  ]);
}
async function search(from, to) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', from);
  await page.fill('#ctl00_ContentPlaceHolder1_txtTo', to);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_btnSearch'),
  ]);
}

// Capture the POST that ViewEdocs auto-submits, so we can replay it for raw bytes
let captured = null;
page.on('request', (req) => {
  if (/ViewEdocs\.aspx/i.test(req.url()) && req.method() === 'POST') {
    captured = { url: req.url(), postData: req.postData(), headers: req.headers() };
  }
});

async function getPdf(label, href) {
  captured = null;
  await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  if (!captured) { log(label, 'no POST captured'); return null; }
  // Replay POST via APIRequestContext (no browser PDF rendering -> raw body)
  const resp = await ctx.request.post(captured.url, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: captured.postData || '',
  });
  const ct = resp.headers()['content-type'] || '';
  const body = await resp.body();
  const ext = /pdf/i.test(ct) ? 'pdf' : 'bin';
  const f = path.join(OUT, `doc-${label}.${ext}`);
  fs.writeFileSync(f, body);
  log(`${label}: ${resp.status()} ${ct} ${body.length}b magic="${Array.from(body.slice(0,8)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}" -> ${f}`);
  return f;
}

try {
  await login();
  log('logged in');
  await search('01/01/2015', '01/31/2015');
  const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
  await page.waitForSelector(docSel, { timeout: 20000 });
  const links = await page.$$eval(docSel, (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href })));
  const saved = [];
  for (const l of links.slice(0, 3)) { const f = await getPdf(l.text, l.href); if (f) saved.push(f); }
  log('SAVED:', saved);
} catch (e) {
  log('ERROR:', e.message);
} finally {
  await browser.close();
}
