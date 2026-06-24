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

try {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton'),
  ]);
  log('logged in');

  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', '06/15/2026');
  await page.fill('#ctl00_ContentPlaceHolder1_txtTo', '06/23/2026');
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_btnSearch'),
  ]);

  const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
  const cnt = await page.locator('text=/Record\\(s\\) Found/i').first().textContent().catch(() => '');
  log('count:', (cnt || '').trim());
  await page.waitForSelector(docSel, { timeout: 20000 });
  const docLinks = await page.$$eval(docSel, (as) =>
    as.map((a) => ({ text: a.textContent.trim(), href: a.href, pages: null })),
  );
  // also pull page counts to correlate
  const rows = await page.$$eval('tr.odd, tr.even', (trs) =>
    trs.map((tr) => {
      const fc = tr.querySelector('a.doclinks[id*="HyperLinkFCEC"]');
      const pg = tr.querySelector('span[id*="lblPgs"]');
      return fc ? { film: fc.textContent.trim(), pages: pg ? pg.textContent.trim() : null } : null;
    }).filter(Boolean),
  );
  const pageByFilm = Object.fromEntries(rows.map((r) => [r.film, r.pages]));
  log('doc links:', docLinks.length);

  // Sample across the page: first 25
  const sample = docLinks.slice(0, 25);
  const results = [];
  for (const d of sample) {
    const info = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: 'include', redirect: 'follow' });
        const ct = res.headers.get('content-type') || '';
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf).slice(0, 12);
        const magic = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(bytes).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        // if html, sniff for the "IMAGE NOT FOUND" message + any embedded image/pdf src
        let note = '';
        if (ct.includes('text/html')) {
          const txt = new TextDecoder().decode(buf);
          if (/IMAGE NOT FOUND/i.test(txt)) note = 'IMAGE_NOT_FOUND';
          const m = txt.match(/(src|data)=["']([^"']*\.(pdf|tif|tiff|png|jpe?g)[^"']*)/i);
          if (m) note += ' embed:' + m[2];
          const fr = txt.match(/<iframe[^>]+src=["']([^"']+)/i);
          if (fr) note += ' iframe:' + fr[1];
        }
        return { url: res.url, status: res.status, ct, size: buf.byteLength, magic, ascii, note };
      } catch (e) {
        return { error: e.message };
      }
    }, d.href);
    info.film = d.text;
    info.pages = pageByFilm[d.text] ?? null;
    results.push(info);
    const tag = info.note || info.ct;
    log(`${d.text} pgs=${info.pages} -> ${info.status} ${info.ct} ${info.size}b ${tag}`);
  }
  fs.writeFileSync(path.join(OUT, 'sample-results.json'), JSON.stringify(results, null, 2));

  // Summarize
  const summary = {};
  for (const r of results) {
    const k = r.error ? 'error' : r.note?.includes('IMAGE_NOT_FOUND') ? 'image_not_found' : r.ct;
    summary[k] = (summary[k] || 0) + 1;
  }
  log('\nSUMMARY:', JSON.stringify(summary, null, 2));
} catch (e) {
  log('ERROR:', e.message);
} finally {
  await browser.close();
}
