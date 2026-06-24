import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER, PASS = process.env.HCCLERK_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', '06/16/2026');
await page.fill('#ctl00_ContentPlaceHolder1_txtTo', '06/16/2026');
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
await page.waitForSelector('span[id*="_ListView1_"][id*="_lblFileNo"]', { timeout: 15000 });
// Find a row that has multiple owners if possible, else first
const html = await page.evaluate(() => {
  const fns = Array.from(document.querySelectorAll('span[id*="_ListView1_"][id*="_lblFileNo"]'));
  // prefer an item whose lvOwners has >1 owner span
  let best = fns[0];
  for (const fn of fns) {
    const prefix = fn.id.replace(/_lblFileNo$/, '');
    const owners = document.querySelectorAll(`[id^="${prefix}_lvOwners"] span`);
    if (owners.length > 2) { best = fn; break; }
  }
  const prefix = best.id.replace(/_lblFileNo$/, '');
  const item = best.closest('tr');
  // include a couple following sibling rows (owner rows may be separate <tr>)
  let block = item.outerHTML;
  let sib = item.nextElementSibling;
  for (let i = 0; i < 4 && sib; i++) { block += '\n<!-- sibling -->\n' + sib.outerHTML; sib = sib.nextElementSibling; }
  const ownerSpans = Array.from(document.querySelectorAll(`[id^="${prefix}_lvOwners"] span`)).map((s) => ({ id: s.id, text: s.textContent.trim() }));
  return { prefix, block, ownerSpans };
});
fs.writeFileSync('./recon-out/sample-row.html', html.block);
fs.writeFileSync('./recon-out/sample-row-owners.json', JSON.stringify(html.ownerSpans, null, 2));
console.log('prefix:', html.prefix);
console.log('owner spans:', JSON.stringify(html.ownerSpans, null, 2));
await browser.close();
