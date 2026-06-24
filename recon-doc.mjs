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

// Capture all responses so we can inspect content-types for the doc fetch
const responses = [];
page.on('response', (r) => {
  responses.push({ url: r.url(), status: r.status(), ct: r.headers()['content-type'] || '' });
});

try {
  // ---- 1. LOGIN ----
  log('== Step 1: login ==');
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton'),
  ]);
  const cookies = await ctx.cookies();
  const hasAuth = cookies.some((c) => /auth|ASPXFORMSAUTH|\.ASPXAUTH/i.test(c.name));
  log('cookies:', cookies.map((c) => c.name).join(', '));
  log('auth cookie present:', hasAuth);
  log('url after login:', page.url());
  await page.screenshot({ path: path.join(OUT, '01-after-login.png'), fullPage: true });

  // ---- 2. SEARCH ----
  log('\n== Step 2: search form ==');
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, '02-search-form.png'), fullPage: true });
  // Dump the form field names so we know what to fill
  const fields = await page.$$eval('input,select', (els) =>
    els
      .filter((e) => e.name && !/^__/.test(e.name))
      .map((e) => ({ name: e.name, type: e.type || e.tagName, id: e.id })),
  );
  fs.writeFileSync(path.join(OUT, 'search-fields.json'), JSON.stringify(fields, null, 2));
  log('search fields written:', fields.length);
} catch (e) {
  log('ERROR:', e.message);
} finally {
  fs.writeFileSync(path.join(OUT, 'responses.json'), JSON.stringify(responses, null, 2));
  await browser.close();
}
