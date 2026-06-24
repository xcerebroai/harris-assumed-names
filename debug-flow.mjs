import 'dotenv/config';
import { chromium } from 'playwright';
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext(); const page = await ctx.newPage();
const events = [];
page.on('request', (r) => { if (/ViewEdocs|Message|eSteps/i.test(r.url())) events.push(`REQ ${r.method()} ${r.url().slice(0,90)}`); });
page.on('response', (r) => { if (/ViewEdocs|Message|eSteps/i.test(r.url())) events.push(`RES ${r.status()} ${r.headers()['content-type']||''} ${r.url().slice(0,90)}`); });
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
for (const film of ['ASN-2026-104', 'ASN-2026-7376']) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', film);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  const href = (await page.$$eval(docSel, (as) => as.map((a) => a.href)))[0];
  events.length = 0;
  await page.goto(href, { waitUntil: 'networkidle' }).catch((e)=>events.push('goto-err '+e.message.slice(0,40)));
  await page.waitForTimeout(2500);
  console.log(`\n=== ${film} ===  final url: ${page.url().slice(0,80)}`);
  console.log(events.join('\n'));
  const txt = await page.evaluate(() => document.body ? document.body.innerText.slice(0,120).replace(/\s+/g,' ') : '');
  console.log('body:', txt);
}
await b.close();
