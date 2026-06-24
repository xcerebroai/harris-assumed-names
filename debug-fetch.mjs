import 'dotenv/config';
import { chromium } from 'playwright';
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext(); const page = await ctx.newPage();
let captured = null;
page.on('request', (r) => { if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() }; });
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
for (const film of ['ASN-2026-104', 'ASN-2026-7376', 'ASN-2026-12391']) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', film);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  await page.waitForSelector(docSel, { timeout: 8000 }).catch(()=>{});
  const href = (await page.$$eval(docSel, (as) => as.map((a) => a.href)))[0];
  captured = null;
  await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.waitForTimeout(1800);
  let out = { film, captured: !!captured };
  if (captured) {
    const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000 });
    out.ct = resp.headers()['content-type'];
    const buf = await resp.body();
    out.size = buf.length;
    out.head = buf.slice(0, 12).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    if (/html/i.test(out.ct)) out.notfound = /IMAGE NOT FOUND/i.test(buf.toString('latin1'));
  }
  console.log(JSON.stringify(out));
}
await b.close();
