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

// Capture EVERY ViewEdocs response (GET bootstrap + POST document)
const viewdocResp = [];
page.on('response', async (r) => {
  if (/ViewEdocs\.aspx/i.test(r.url())) {
    const rec = { method: r.request().method(), status: r.status(), ct: r.headers()['content-type'] || '' };
    try {
      const body = await r.body();
      rec.size = body.length;
      rec.magic = Array.from(body.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      rec.ascii = Array.from(body.slice(0, 16)).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      rec._body = body; // keep for saving
    } catch (e) {
      rec.bodyErr = e.message;
    }
    viewdocResp.push(rec);
  }
});

async function probe(label, href) {
  viewdocResp.length = 0;
  log(`\n--- probe ${label} ---`);
  await page.goto(href, { waitUntil: 'networkidle' }).catch((e) => log('nav:', e.message));
  await page.waitForTimeout(2500); // allow auto-submit POST + doc to load
  for (const r of viewdocResp) {
    log(`${r.method} ${r.status} ${r.ct} ${r.size}b magic[${r.magic}] "${r.ascii}"`);
  }
  // Save the largest non-html body as a file for inspection
  const docResp = viewdocResp.filter((r) => r._body && !/text\/html/i.test(r.ct)).sort((a, b) => b.size - a.size)[0];
  if (docResp) {
    const ext = /pdf/i.test(docResp.ct) ? 'pdf' : /tif/i.test(docResp.ct) ? 'tif' : /png/i.test(docResp.ct) ? 'png' : /jpe?g/i.test(docResp.ct) ? 'jpg' : 'bin';
    const f = path.join(OUT, `doc-${label}.${ext}`);
    fs.writeFileSync(f, docResp._body);
    log('saved doc ->', f, docResp.size, 'bytes', docResp.ct);
    return f;
  }
  log('(no binary document response captured)');
  return null;
}

try {
  await login();
  log('logged in');

  await search('01/01/2015', '01/31/2015');
  const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
  await page.waitForSelector(docSel, { timeout: 20000 });
  const links = await page.$$eval(docSel, (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href })));
  log('links:', links.length);

  const saved = [];
  for (const l of links.slice(0, 4)) {
    const f = await probe(l.text, l.href);
    if (f) saved.push(f);
  }
  log('\nSAVED DOCS:', saved);
} catch (e) {
  log('ERROR:', e.message);
} finally {
  await browser.close();
}
