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
  const cnt = await page.locator('text=/Record\\(s\\) Found/i').first().textContent().catch(() => '');
  log('count:', (cnt || '').trim());
}

try {
  await login();
  log('logged in');

  // Try OLD filings (2015) -- more likely to have scanned images published
  await search('01/01/2015', '01/31/2015');
  const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
  await page.waitForSelector(docSel, { timeout: 20000 });
  const docLinks = await page.$$eval(docSel, (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.href })));
  log('old doc links:', docLinks.length);

  // Inspect raw HTML of first old doc fetch
  const raw = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include', redirect: 'follow' });
    const txt = await res.text();
    return { url: res.url, ct: res.headers.get('content-type'), len: txt.length, txt };
  }, docLinks[0].href);
  fs.writeFileSync(path.join(OUT, 'raw-old-doc.html'), raw.txt);
  log('raw fetch ->', raw.url, raw.ct, raw.len, 'bytes');

  // Now actually NAVIGATE (not fetch) to the viewer in a popup and inspect DOM + any image network hits
  const imgHits = [];
  page.on('response', (r) => {
    const ct = r.headers()['content-type'] || '';
    if (/image|pdf|tiff|octet-stream/i.test(ct)) imgHits.push({ url: r.url(), ct, status: r.status() });
  });
  const popupP = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.click(docSel + ' >> nth=0');
  const popup = await popupP;
  const vp = popup || page;
  await vp.waitForLoadState('networkidle').catch(() => {});
  log('viewer url:', vp.url());
  await vp.screenshot({ path: path.join(OUT, '05-old-doc-viewer.png'), fullPage: true }).catch(() => {});
  const dom = await vp.evaluate(() => ({
    title: document.title,
    embeds: Array.from(document.querySelectorAll('embed,object,iframe')).map((e) => e.src || e.data),
    imgs: Array.from(document.querySelectorAll('img')).map((i) => ({ src: i.src, w: i.naturalWidth, h: i.naturalHeight })),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
  })).catch((e) => ({ error: e.message }));
  fs.writeFileSync(path.join(OUT, 'old-doc-dom.json'), JSON.stringify(dom, null, 2));
  log('viewer dom:', JSON.stringify(dom, null, 2));
  log('image/pdf network hits:', JSON.stringify(imgHits, null, 2));
} catch (e) {
  log('ERROR:', e.message);
} finally {
  await browser.close();
}
