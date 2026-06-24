import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
let captured = null;
page.on('request', (r) => { if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() }; });

await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);

await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', '06/22/2026');
await page.fill('#ctl00_ContentPlaceHolder1_txtTo', '06/22/2026');
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
await page.waitForSelector(docSel);
const links = await page.$$eval(docSel, (as) => as.map((a) => ({ film: a.textContent.trim(), href: a.href })));

const sample = links.slice(0, 5);
for (const l of sample) {
  captured = null;
  await page.goto(l.href, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  if (!captured) { console.log(l.film, 'no post'); continue; }
  const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000 });
  const ct = resp.headers()['content-type'] || '';
  if (!/pdf/i.test(ct)) { console.log(l.film, 'not pdf:', ct); continue; }
  const pdf = await resp.body();
  fs.writeFileSync(`./recon-out/sample-${l.film}.pdf`, pdf);
  try {
    const { png, width, height } = await pdfPage1ToSharp(pdf);
    fs.writeFileSync(`./recon-out/sample-${l.film}.png`, png);
    console.log(l.film, 'OK', width + 'x' + height, pdf.length + 'b');
  } catch (e) { console.log(l.film, 'render err', e.message); }
  await page.waitForTimeout(600);
}
await browser.close();
