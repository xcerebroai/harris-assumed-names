import 'dotenv/config';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';
const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const U = process.env.HCCLERK_USER, P = process.env.HCCLERK_PASS;
const FILMS = ['ASN-2026-96', 'ASN-2026-79', 'ASN-2026-83', 'ASN-2026-98'];
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext(); const page = await ctx.newPage();
let captured = null;
page.on('request', (r) => { if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() }; });
await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', U);
await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', P);
await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
for (const film of FILMS) {
  try {
    await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
    await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', film);
    await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
    await page.waitForSelector(docSel, { timeout: 8000 }).catch(()=>{});
    const href = (await page.$$eval(docSel, (as) => as.map((a) => a.href)))[0];
    captured = null;
    await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForTimeout(1800);
    if (!captured) { console.log(film, 'no capture'); continue; }
    const resp = await ctx.request.post(captured.url, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000 });
    const { png, width: W, height: H } = await pdfPage1ToSharp(await resp.body());
    await sharp(png).extract({ left: 0, top: Math.round(0.13 * H), width: W, height: Math.round(0.37 * H) }).resize({ width: 1500 }).png().toFile(`./recon-out/spot-${film}.png`);
    console.log(film, 'rendered');
  } catch (e) { console.log(film, 'err', e.message.slice(0, 50)); }
}
await b.close();
