import 'dotenv/config';
import { chromium } from 'playwright';
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext(); const page = await ctx.newPage();
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
async function count(from, to) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  if (from) await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', from);
  if (to) await page.fill('#ctl00_ContentPlaceHolder1_txtTo', to);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  const t = (await page.locator('text=/Record\\(s\\) Found/i').first().textContent().catch(() => '')) || '';
  return t.trim();
}
for (const [label, f, t] of [
  ['ALL (no date filter)', '', ''],
  ['2026 YTD', '01/01/2026', '06/23/2026'],
  ['2025 full', '01/01/2025', '12/31/2025'],
  ['last 30 days', '05/24/2026', '06/23/2026'],
]) {
  console.log(`${label} [${f||'-'}..${t||'-'}]: ${await count(f, t)}`);
}
await b.close();
