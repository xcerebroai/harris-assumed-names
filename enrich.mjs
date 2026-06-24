// Stage 2: OCR enrichment + daily re-verify loop.
// For each row with image_status NOT IN ('extracted','dead'):
//   - re-harvest a FRESH ViewEdocs token (stored tokens are session-scoped/expire) by
//     searching the film code, replay the GET->auto-POST.
//   - HTML "IMAGE NOT FOUND"  -> image_status='pending', retry_count++, last_checked=today;
//                                retry_count >= RETRY_CAP (14) -> 'dead'.
//   - application/pdf         -> zonal OCR the page-1 form, write address fields,
//                                image_status='extracted'.
// Politeness: low concurrency (serial) + jitter. Use --limit N to time-box a batch.
//
// Usage: node enrich.mjs [--limit N] [--today MM/DD/YYYY]
import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';
import { extractAddresses, closeWorker } from './lib/ocr.mjs';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER, PASS = process.env.HCCLERK_PASS;
const RETRY_CAP = 14;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = parseInt(arg('limit', '0'), 10) || 0; // 0 = no cap
const TODAY = arg('today', '06/23/2026');
const TODAY_ISO = (() => { const [m, d, y] = TODAY.split('/'); return `${y}-${m}-${d}`; })();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (b, s) => b + Math.floor(Math.random() * s);

// ---- DB + self-migration ----
const db = new Database('./data/assumed_names.db');
db.pragma('journal_mode = WAL');
for (const col of [
  'retry_count INTEGER DEFAULT 0', 'last_checked TEXT', 'extracted_at TEXT',
  'business_street TEXT', 'business_city TEXT', 'business_state TEXT', 'business_zip TEXT',
  'residence_street TEXT', 'residence_city TEXT', 'residence_state TEXT', 'residence_zip TEXT',
  'ocr_raw TEXT',
]) {
  try { db.exec(`ALTER TABLE filings ADD COLUMN ${col}`); } catch { /* exists */ }
}

const pickRows = db.prepare(`
  SELECT film_code, file_number, file_date, COALESCE(retry_count,0) retry_count
  FROM filings
  WHERE image_status NOT IN ('extracted','dead')
    AND (last_checked IS NULL OR last_checked != ?)
  ORDER BY file_date ASC   -- oldest first: those reliably have images (lag is ~1 business day)
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}
`);
const setExtracted = db.prepare(`
  UPDATE filings SET image_status='extracted', extracted_at=@now, last_checked=@today,
    business_street=@bs, business_city=@bc, business_state=@bst, business_zip=@bz,
    residence_street=@rs, residence_city=@rc, residence_state=@rst, residence_zip=@rz, ocr_raw=@raw
  WHERE film_code=@film`);
const setPending = db.prepare(`
  UPDATE filings SET image_status=@status, retry_count=@rc, last_checked=@today WHERE film_code=@film`);

// ---- portal ----
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
let captured = null;

async function login(page) {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
  if (!(await page.context().cookies()).some((c) => /\.ASPXAUTH/i.test(c.name))) throw new Error('login failed');
}

// Re-harvest a fresh ViewEdocs href for a film code.
// Must wait for the ListView to render (postback is async) before reading the link,
// else we'd read [] and mistake a render race for "no document".
async function freshHref(page, film) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', film);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  await page.waitForSelector(docSel, { timeout: 8000 }).catch(() => {});
  const links = await page.$$eval(docSel, (as) => as.map((a) => a.href));
  return links[0] || null;
}

// Fetch the document; returns {kind:'pdf', buf} | {kind:'notfound'} | {kind:'error'}.
async function fetchDoc(page, ctx, href) {
  captured = null;
  await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1400);
  if (!captured) return { kind: 'error' };
  try {
    const resp = await ctx.request.post(captured.url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: captured.postData || '', timeout: 45000,
    });
    const ct = resp.headers()['content-type'] || '';
    if (/pdf/i.test(ct)) return { kind: 'pdf', buf: await resp.body() };
    const body = await resp.text();
    return { kind: /IMAGE NOT FOUND/i.test(body) ? 'notfound' : 'error' };
  } catch { return { kind: 'error' }; }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('request', (r) => { if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() }; });

const stats = { extracted: 0, pending: 0, dead: 0, error: 0 };
try {
  await login(page);
  log('logged in (.ASPXAUTH ok)');
  const rows = pickRows.all(TODAY_ISO);
  log(`${rows.length} rows to process (limit=${LIMIT || 'none'})`);
  for (const row of rows) {
   try {
    const href = await freshHref(page, row.film_code);
    // No link found = a lookup/render miss on our side, NOT a genuine "image not found".
    // Treat as transient error so it does not count toward the dead-out retry cap.
    const doc = href ? await fetchDoc(page, ctx, href) : { kind: 'error' };
    if (doc.kind === 'pdf') {
      let addr = {};
      try {
        const { png } = await pdfPage1ToSharp(doc.buf);
        addr = await extractAddresses(png); // default preprocessing = med5 (watermark denoise)
      } catch (e) { addr = { _err: e.message }; }
      setExtracted.run({
        film: row.film_code, now: new Date().toISOString(), today: TODAY_ISO,
        bs: addr.business_street || null, bc: addr.business_city || null, bst: addr.business_state || null, bz: addr.business_zip || null,
        rs: addr.residence_street || null, rc: addr.residence_city || null, rst: addr.residence_state || null, rz: addr.residence_zip || null,
        raw: addr._raw ? JSON.stringify(addr._raw) : null,
      });
      stats.extracted++;
      log(`  ${row.film_code} EXTRACTED biz[${addr.business_street||''}|${addr.business_city||''} ${addr.business_state||''} ${addr.business_zip||''}] res[${addr.residence_street||''}|${addr.residence_city||''} ${addr.residence_state||''} ${addr.residence_zip||''}]`);
    } else if (doc.kind === 'notfound') {
      const rc = row.retry_count + 1;
      const status = rc >= RETRY_CAP ? 'dead' : 'pending';
      setPending.run({ film: row.film_code, status, rc, today: TODAY_ISO });
      stats[status]++;
      log(`  ${row.film_code} ${status} (retry ${rc}/${RETRY_CAP})`);
    } else {
      stats.error++;
      log(`  ${row.film_code} fetch-error (left as-is, will retry next run)`);
    }
   } catch (e) {
     // A bad row (nav timeout etc.) must not kill the whole batch.
     stats.error++;
     log(`  ${row.film_code} row-error: ${e.message.slice(0, 50)} (left as-is)`);
   }
   await sleep(jitter(700, 800));
  }
} catch (e) {
  log('ERROR:', e.message);
} finally {
  await closeWorker();
  await browser.close();
  const tally = db.prepare("SELECT image_status, COUNT(*) n FROM filings GROUP BY image_status").all();
  log('run stats:', JSON.stringify(stats));
  log('table image_status:', JSON.stringify(tally));
  db.close();
}
