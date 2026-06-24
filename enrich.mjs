// Stage 2: OCR enrichment + daily re-verify loop.
// For each pending row:
//   - re-harvest a FRESH ViewEdocs token by searching the film code
//   - application/pdf       -> OCR (med5 denoise + anchor-based), write address fields
//   - "IMAGE NOT FOUND"     -> retry_count++; if >= RETRY_CAP (14) -> 'dead'
//   - timeout               -> transient, NO retry_count increment, left as-is for next run
//   - other error / no-link -> transient, NO retry_count increment, left as-is for next run
//
// Adaptive backoff: 3 consecutive timeouts -> pause 20 min -> re-probe -> resume or abort.
// Checkpoint: last_checked = TODAY_ISO on extracted + notfound rows.
//             Stop/resume re-queries; already-stamped rows are skipped automatically.
//
// Usage: node enrich.mjs [--limit N] [--today YYYY-MM-DD]
import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { pdfPage1ToSharp } from './lib/pdf-image.mjs';
import { extractAddresses, closeWorker } from './lib/ocr.mjs';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER, PASS = process.env.HCCLERK_PASS;
const RETRY_CAP = 14;
const CONSEC_THRESHOLD = 3;
const BACKOFF_MS = 20 * 60 * 1000; // 20 min
const PROGRESS_EVERY = 50;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const TODAY_ISO = arg('today', new Date().toISOString().slice(0, 10));

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
  ORDER BY file_date ASC
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}
`);
const pickProbeFilms = db.prepare(`
  SELECT film_code FROM filings WHERE image_status='pending' ORDER BY file_date ASC LIMIT 3
`);
const setExtracted = db.prepare(`
  UPDATE filings SET image_status='extracted', extracted_at=@now, last_checked=@today,
    business_street=@bs, business_city=@bc, business_state=@bst, business_zip=@bz,
    residence_street=@rs, residence_city=@rc, residence_state=@rst, residence_zip=@rz, ocr_raw=@raw
  WHERE film_code=@film`);
const setPending = db.prepare(`
  UPDATE filings SET image_status=@status, retry_count=@rc, last_checked=@today WHERE film_code=@film`);

// ---- portal helpers ----
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
let captured = null;

async function login(page) {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
  if (!(await page.context().cookies()).some((c) => /\.ASPXAUTH/i.test(c.name))) throw new Error('login failed');
}

async function freshHref(page, film) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFilmCd', film);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
  await page.waitForSelector(docSel, { timeout: 8000 }).catch(() => {});
  const links = await page.$$eval(docSel, (as) => as.map((a) => a.href));
  return links[0] || null;
}

// Returns {kind:'pdf',buf,ms} | {kind:'notfound',ms} | {kind:'timeout',ms} | {kind:'error'}
// Distinguishing 'timeout' from 'error' is critical: only 'notfound' drives retry_count.
async function fetchDoc(page, ctx, href) {
  captured = null;
  await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1400);
  if (!captured) return { kind: 'error' };
  const t0 = Date.now();
  try {
    const resp = await ctx.request.post(captured.url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: captured.postData || '',
      timeout: 45000,
    });
    const ms = Date.now() - t0;
    const ct = resp.headers()['content-type'] || '';
    if (/pdf/i.test(ct)) return { kind: 'pdf', buf: await resp.body(), ms };
    const body = await resp.text();
    return { kind: /IMAGE NOT FOUND/i.test(body) ? 'notfound' : 'error', ms };
  } catch (e) {
    return { kind: /[Tt]imeout/.test(e.message) ? 'timeout' : 'error', ms: Date.now() - t0 };
  }
}

// Open a fresh browser, context, and page; wire POST interceptor; log in.
async function newSession() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('request', (r) => {
    if (/ViewEdocs\.aspx/i.test(r.url()) && r.method() === 'POST') captured = { url: r.url(), postData: r.postData() };
  });
  await login(page);
  return { browser, ctx, page };
}

// Try 3 oldest pending docs; returns count of PDFs (>0 = server ok).
async function miniProbe(page, ctx) {
  const films = pickProbeFilms.all().map((r) => r.film_code);
  let pdfs = 0;
  for (const film of films) {
    try {
      const href = await freshHref(page, film);
      if (!href) { log(`  probe ${film}: no-link`); continue; }
      const doc = await fetchDoc(page, ctx, href);
      log(`  probe ${film}: ${doc.kind}${doc.ms != null ? ' ' + doc.ms + 'ms' : ''}`);
      if (doc.kind === 'pdf') pdfs++;
    } catch (e) { log(`  probe ${film}: threw ${e.message.slice(0, 40)}`); }
    await sleep(jitter(700, 800));
  }
  return pdfs;
}

// ---- stats + progress ----
const stats = { extracted: 0, notfound: 0, dead: 0, timeout: 0, error: 0 };
const pdfTimes = [];
let processed = 0;
function progressReport(total) {
  const avg = pdfTimes.length ? Math.round(pdfTimes.reduce((a, b) => a + b, 0) / pdfTimes.length) : null;
  log(`=== ${processed}/${total} processed | +${stats.extracted} extracted | ${stats.timeout} timeouts | avg PDF ${avg != null ? avg + 'ms' : 'n/a'} | ${stats.notfound} not-found | ${stats.dead} dead | ${stats.error} err ===`);
}

// ---- main ----
log(`TODAY_ISO=${TODAY_ISO}  LIMIT=${LIMIT || 'none'}`);
let session = await newSession();
log('logged in (.ASPXAUTH ok)');
const rows = pickRows.all(TODAY_ISO);
log(`${rows.length} rows queued`);

let consecTimeouts = 0;

try {
  for (const row of rows) {
    // All paths through this block fall through to the single processed++ below.
    try {
      // Step 1: get a fresh doc href (render race -> null, not a dead-out signal)
      let href = null;
      let navTimedOut = false;
      try {
        href = await freshHref(session.page, row.film_code);
      } catch (e) {
        navTimedOut = /[Tt]imeout/.test(e.message);
        if (navTimedOut) { consecTimeouts++; stats.timeout++; }
        else stats.error++;
        log(`  ${row.film_code} nav-${navTimedOut ? 'timeout' : 'error'} (consec=${consecTimeouts})`);
      }

      // Step 2: fetch the document (skip if nav threw)
      if (!navTimedOut) {
        // href=null (no-link / render race) -> transient error, not a "not found"
        const doc = href ? await fetchDoc(session.page, session.ctx, href) : { kind: 'error' };

        if (doc.kind === 'pdf') {
          consecTimeouts = 0;
          if (doc.ms) pdfTimes.push(doc.ms);
          let addr = {};
          try {
            const { png } = await pdfPage1ToSharp(doc.buf);
            addr = await extractAddresses(png);
          } catch (e) { addr = { _err: e.message }; }
          setExtracted.run({
            film: row.film_code, now: new Date().toISOString(), today: TODAY_ISO,
            bs: addr.business_street || null, bc: addr.business_city || null,
            bst: addr.business_state || null, bz: addr.business_zip || null,
            rs: addr.residence_street || null, rc: addr.residence_city || null,
            rst: addr.residence_state || null, rz: addr.residence_zip || null,
            raw: addr._raw ? JSON.stringify(addr._raw) : null,
          });
          stats.extracted++;
          log(`  ${row.film_code} ${doc.ms}ms EXTRACTED biz[${addr.business_street || ''}|${addr.business_city || ''} ${addr.business_state || ''} ${addr.business_zip || ''}] res[${addr.residence_street || ''}|${addr.residence_city || ''} ${addr.residence_state || ''} ${addr.residence_zip || ''}]`);
        } else if (doc.kind === 'notfound') {
          consecTimeouts = 0;
          const rc = row.retry_count + 1;
          const newStatus = rc >= RETRY_CAP ? 'dead' : 'pending';
          setPending.run({ film: row.film_code, status: newStatus, rc, today: TODAY_ISO });
          stats[newStatus === 'dead' ? 'dead' : 'notfound']++;
          log(`  ${row.film_code} IMAGE NOT FOUND (retry ${rc}/${RETRY_CAP}) -> ${newStatus}`);
        } else if (doc.kind === 'timeout') {
          // Transient: NO DB write, NO retry_count bump. Will be retried next run.
          consecTimeouts++;
          stats.timeout++;
          log(`  ${row.film_code} TIMEOUT (consec=${consecTimeouts}) — left as-is`);
        } else {
          // error / no-post / no-link: transient, no penalty
          stats.error++;
          log(`  ${row.film_code} fetch-error (left as-is)`);
        }
      }
    } catch (e) {
      stats.error++;
      log(`  ${row.film_code} row-error: ${e.message.slice(0, 60)}`);
    }

    // ---- single accounting point per row ----
    processed++;
    if (processed % PROGRESS_EVERY === 0) progressReport(rows.length);

    // ---- adaptive backoff ----
    if (consecTimeouts >= CONSEC_THRESHOLD) {
      log(`!!! ${consecTimeouts} consecutive timeouts — backing off ${BACKOFF_MS / 60000} min then re-probing`);
      await session.browser.close();
      let recovered = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        log(`  sleeping ${BACKOFF_MS / 60000} min... (attempt ${attempt}/3)`);
        await sleep(BACKOFF_MS);
        log('  opening fresh session for re-probe...');
        session = await newSession();
        const pdfs = await miniProbe(session.page, session.ctx);
        if (pdfs > 0) {
          log(`  re-probe: ${pdfs}/3 PDF — server recovered, resuming`);
          consecTimeouts = 0;
          recovered = true;
          break;
        }
        log(`  re-probe: 0/3 PDF — still throttled`);
        await session.browser.close();
      }
      if (!recovered) {
        log('server still throttling after 3 backoff attempts — aborting. Re-run when recovered.');
        break;
      }
    }

    await sleep(jitter(700, 800));
  }
} catch (e) {
  log('FATAL:', e.message);
} finally {
  await closeWorker();
  await session.browser.close();
  progressReport(rows.length);
  const tally = db.prepare('SELECT image_status, COUNT(*) n FROM filings GROUP BY image_status').all();
  log('run stats:', JSON.stringify(stats));
  log('table:', JSON.stringify(tally));
  db.close();
}
