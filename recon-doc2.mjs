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

const responses = [];
page.on('response', (r) => {
  const ct = r.headers()['content-type'] || '';
  responses.push({ url: r.url(), status: r.status(), ct });
});

try {
  // 1. LOGIN
  log('== login ==');
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton'),
  ]);
  log('logged in ->', page.url());

  // 2. SEARCH by a narrow recent date range to get a small result set
  log('\n== search ==');
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', '06/15/2026');
  await page.fill('#ctl00_ContentPlaceHolder1_txtTo', '06/23/2026');
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_btnSearch'),
  ]);
  log('results url:', page.url());
  const recCount = await page
    .locator('text=/Record\\(s\\) Found/i')
    .first()
    .textContent()
    .catch(() => null);
  log('record count text:', (recCount || '').trim());
  await page.screenshot({ path: path.join(OUT, '03-results.png'), fullPage: false });

  // 3. Grab first RESULT-ROW document link (HyperLinkFCEC, not the cart/header links)
  const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
  const docLinks = await page.$$eval(docSel, (as) =>
    as.map((a) => ({ text: a.textContent.trim(), href: a.href })),
  );
  log('doc links found:', docLinks.length);
  fs.writeFileSync(path.join(OUT, 'doclinks.json'), JSON.stringify(docLinks.slice(0, 5), null, 2));
  if (!docLinks.length) throw new Error('no doc links on results page');
  const first = docLinks[0];
  log('opening doc:', first.text, '->', first.href);

  // 4. Open the doc. It targets _blank -> capture popup. Also handle possible download.
  let download = null;
  page.on('download', (d) => (download = d));

  const popupPromise = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.click(docSel + ' >> nth=0');
  const popup = await popupPromise;

  let docPage = popup || page;
  if (popup) {
    await popup.waitForLoadState('networkidle').catch(() => {});
    log('popup url:', popup.url());
    await popup.screenshot({ path: path.join(OUT, '04-doc-viewer.png'), fullPage: true }).catch(() => {});
  } else {
    log('no popup opened; current url:', page.url());
  }

  // Inspect the viewer DOM for embed/iframe/img (PDF vs image viewer)
  const viewerInfo = await docPage.evaluate(() => {
    const grab = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.src || e.data || e.getAttribute('href') || '');
    return {
      title: document.title,
      url: location.href,
      embeds: grab('embed'),
      objects: grab('object'),
      iframes: grab('iframe'),
      imgs: Array.from(document.querySelectorAll('img')).map((i) => i.src).slice(0, 20),
      bodyTextSample: document.body ? document.body.innerText.slice(0, 500) : '',
    };
  }).catch((e) => ({ error: e.message }));
  fs.writeFileSync(path.join(OUT, 'viewer-info.json'), JSON.stringify(viewerInfo, null, 2));
  log('\nviewer info:', JSON.stringify(viewerInfo, null, 2));

  // 5. Try fetching the doc URL directly within the session to learn its content-type
  const target = first.href;
  const fetchInfo = await docPage.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: 'include' });
      const ct = res.headers.get('content-type');
      const cd = res.headers.get('content-disposition');
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf).slice(0, 16);
      const magic = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = Array.from(bytes).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      return { ok: res.ok, status: res.status, ct, cd, size: buf.byteLength, magic, ascii };
    } catch (e) {
      return { error: e.message };
    }
  }, target);
  fs.writeFileSync(path.join(OUT, 'doc-fetch.json'), JSON.stringify(fetchInfo, null, 2));
  log('\ndoc fetch info:', JSON.stringify(fetchInfo, null, 2));

  if (download) {
    const dl = path.join(OUT, 'downloaded-' + (download.suggestedFilename() || 'doc.bin'));
    await download.saveAs(dl).catch(() => {});
    log('download saved:', dl);
  }
} catch (e) {
  log('ERROR:', e.message);
} finally {
  fs.writeFileSync(path.join(OUT, 'responses2.json'), JSON.stringify(responses, null, 2));
  await browser.close();
}
