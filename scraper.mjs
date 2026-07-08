// Stage 1 metadata scraper for Harris County Clerk Assumed Names.
// Captures result-row metadata only. NO PDF fetch, NO OCR (image_status defaults to "pending").
//
// Usage:
//   node scraper.mjs --from MM/DD/YYYY --to MM/DD/YYYY   # explicit backfill range
//   node scraper.mjs --backfill                          # full range (EARLIEST..today)
//   node scraper.mjs --daily                             # incremental: from last successful run date..today
//   node scraper.mjs --from ... --to ... --shard week    # weekly shards (default: day)
//
import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://www.cclerk.hctx.net/applications/websearch/';
const USER = process.env.HCCLERK_USER;
const PASS = process.env.HCCLERK_PASS;
// Real current date in America/Chicago (filings + the scheduled task run on Central time),
// formatted MM/DD/YYYY to match the county search form. TODAY itself is resolved below,
// after the CLI parser, so the --today flag can take precedence (see resolveRange usage).
const centralToday = () => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const EARLIEST = '01/01/1990'; // generous lower bound for full backfill
const PAGE_CAP = 200; // server-side DataPager page size

// ---------- CLI ----------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const MODE_DAILY = !!arg('daily', false);
const MODE_BACKFILL = !!arg('backfill', false);
const SHARD = (arg('shard', 'day') || 'day').toString();
// Upper-bound "now" for the search window. Precedence: --today flag > TODAY env var > real
// current date (Central). daily.mjs passes --today through; env stays available for testing.
const todayFlag = arg('today');
const TODAY = (todayFlag && todayFlag !== true) ? todayFlag : (process.env.TODAY || centralToday());
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- date helpers (MM/DD/YYYY) ----------
const toDate = (s) => { const [m, d, y] = s.split('/').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
const fmt = (dt) => `${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}/${dt.getUTCFullYear()}`;
const iso = (s) => { const [m, d, y] = s.split('/'); return `${y}-${m}-${d}`; };
const addDays = (dt, n) => { const x = new Date(dt); x.setUTCDate(x.getUTCDate() + n); return x; };

function* shards(fromStr, toStr, kind) {
  let cur = toDate(fromStr);
  const end = toDate(toStr);
  const step = kind === 'week' ? 7 : 1;
  while (cur <= end) {
    const sEnd = step === 1 ? cur : (() => { const e = addDays(cur, 6); return e > end ? end : e; })();
    yield { from: fmt(cur), to: fmt(sEnd) };
    cur = addDays(cur, step);
  }
}

// ---------- DB ----------
fs.mkdirSync('./data', { recursive: true });
const db = new Database('./data/assumed_names.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS filings (
    film_code     TEXT PRIMARY KEY,
    file_number   TEXT,
    term          TEXT,
    business_name TEXT,
    owners        TEXT,          -- JSON array of owner names
    status_type   TEXT,
    file_date     TEXT,          -- ISO YYYY-MM-DD
    pages         INTEGER,
    doc_token     TEXT,          -- ViewEdocs href / encrypted ID (session-scoped; harvested for later fetch)
    image_status  TEXT DEFAULT 'pending',  -- pending | extracted | dead
    first_seen    TEXT,
    last_seen     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_filings_filedate ON filings(file_date);
  CREATE INDEX IF NOT EXISTS idx_filings_imgstatus ON filings(image_status);
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT, range_from TEXT, range_to TEXT,
    rows_seen INTEGER, rows_new INTEGER,
    started_at TEXT, finished_at TEXT, ok INTEGER DEFAULT 0
  );
`);

const upsert = db.prepare(`
  INSERT INTO filings (film_code, file_number, term, business_name, owners, status_type, file_date, pages, doc_token, image_status, first_seen, last_seen)
  VALUES (@film_code, @file_number, @term, @business_name, @owners, @status_type, @file_date, @pages, @doc_token, 'pending', @now, @now)
  ON CONFLICT(film_code) DO UPDATE SET
    file_number=excluded.file_number, term=excluded.term, business_name=excluded.business_name,
    owners=excluded.owners, status_type=excluded.status_type, file_date=excluded.file_date,
    pages=excluded.pages, doc_token=excluded.doc_token, last_seen=excluded.last_seen
`);
const wasNew = db.prepare('SELECT 1 FROM filings WHERE film_code = ?');

// ---------- scraping ----------
const docSel = 'a.doclinks[id*="ListView1"][id*="HyperLinkFCEC"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, span) => base + Math.floor(Math.random() * span);

async function login(page) {
  await page.goto(BASE + 'Registration/Login.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_UserName', USER);
  await page.fill('#ctl00_ContentPlaceHolder1_Login1_Password', PASS);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_Login1_LoginButton')]);
  const ok = (await page.context().cookies()).some((c) => /\.ASPXAUTH/i.test(c.name));
  if (!ok) throw new Error('login failed (no .ASPXAUTH cookie)');
}

async function runSearch(page, from, to) {
  await page.goto(BASE + 'AN.aspx', { waitUntil: 'networkidle' });
  await page.fill('#ctl00_ContentPlaceHolder1_txtFrom', from);
  await page.fill('#ctl00_ContentPlaceHolder1_txtTo', to);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('#ctl00_ContentPlaceHolder1_btnSearch')]);
}

function recordCount(page) {
  return page.locator('text=/Record\\(s\\) Found/i').first().textContent().catch(() => '')
    .then((t) => { const m = (t || '').match(/([\d,]+)\s+Record/i); return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0; });
}

// Parse all result rows currently rendered. Returns array of row objects.
async function parseRows(page) {
  return page.evaluate(() => {
    const out = [];
    // Scope strictly to the results ListView; the account cart grid (gvReqItems) also uses lblFileNo.
    const fileNoSpans = Array.from(document.querySelectorAll('span[id*="_ListView1_"][id*="_lblFileNo"]'));
    for (const fn of fileNoSpans) {
      const prefix = fn.id.replace(/_lblFileNo$/, '');
      const q = (suf) => document.getElementById(prefix + suf);
      const desc = q('_lblDesc2');
      const fdate = q('_lblFileDate');
      const pgs = q('_lblPgs');
      const fc = document.querySelector(`a[id="${prefix}_HyperLinkFCEC"]`);
      // owners: nested ListView rows (`..._lvOwners_ctrl<j>_row`); the name is the <span>
      // inside each (the "Owner:" label is a <strong>, not a span, so it's excluded).
      const ownerSpans = Array.from(document.querySelectorAll(`[id^="${prefix}_lvOwners"] span`))
        .map((s) => s.textContent.replace(/\s+/g, ' ').trim())
        .filter((t) => t && !/^owner:?$/i.test(t));
      // Term: the cell immediately AFTER the file-number cell (`..._FileNoOpen` td).
      const fileNoTd = document.getElementById(prefix + '_FileNoOpen');
      let term = null;
      if (fileNoTd && fileNoTd.nextElementSibling && fileNoTd.nextElementSibling.tagName === 'TD') {
        term = fileNoTd.nextElementSibling.textContent.trim() || null;
      }
      // Status/Type: the date cell holds e.g. "Unincorporated<br>06/16/2026"; type = cell text minus the date.
      let statusType = null;
      if (fdate) {
        const dateTd = fdate.closest('td');
        if (dateTd) statusType = dateTd.textContent.replace(fdate.textContent, '').replace(/\s+/g, ' ').trim() || null;
      }
      out.push({
        file_number: fn.textContent.trim(),
        term,
        business_name: desc ? desc.textContent.trim() : null,
        owners: ownerSpans,
        status_type: statusType,
        file_date: fdate ? fdate.textContent.trim() : null,
        pages: pgs ? parseInt(pgs.textContent.trim(), 10) || null : null,
        film_code: fc ? fc.textContent.trim() : null,
        doc_href: fc ? fc.href : null,
      });
    }
    return out;
  });
}

// Click the pager "Next" link if enabled; returns true if it advanced.
async function gotoNextPage(page) {
  const next = page.locator('a:has-text("Next")').first();
  const cnt = await next.count();
  if (!cnt) return false;
  const href = await next.getAttribute('href').catch(() => null);
  if (!href || !/doPostBack/i.test(href)) return false; // disabled
  const firstBefore = await page.locator('span[id*="_ListView1_"][id*="_lblFileNo"]').first().textContent().catch(() => '');
  await Promise.all([page.waitForLoadState('networkidle'), next.click()]);
  const firstAfter = await page.locator('span[id*="_ListView1_"][id*="_lblFileNo"]').first().textContent().catch(() => '');
  return firstAfter && firstAfter !== firstBefore;
}

async function scrapeShard(page, from, to, stats) {
  await runSearch(page, from, to);
  const count = await recordCount(page);
  if (count === 0) { log(`  ${from}..${to}: 0 records`); return; }
  if (count > PAGE_CAP) log(`  ${from}..${to}: ${count} records (>${PAGE_CAP} cap -> will paginate)`);
  let pageNum = 1;
  const fileDateISO = from === to ? iso(from) : null;
  const now = new Date().toISOString();
  while (true) {
    await page.waitForSelector(docSel, { timeout: 20000 }).catch(() => {});
    const rows = await parseRows(page);
    const insertMany = db.transaction((rs) => {
      for (const r of rs) {
        if (!r.film_code) continue;
        const isNew = !wasNew.get(r.film_code);
        upsert.run({
          film_code: r.film_code,
          file_number: r.file_number,
          term: r.term,
          business_name: r.business_name,
          owners: JSON.stringify(r.owners || []),
          status_type: r.status_type,
          file_date: r.file_date ? iso(r.file_date.replace(/-/g, '/')) || r.file_date : fileDateISO,
          pages: r.pages,
          doc_token: r.doc_href,
          now,
        });
        stats.seen++;
        if (isNew) stats.new++;
      }
    });
    insertMany(rows);
    log(`  ${from}..${to} p${pageNum}: +${rows.length} rows (seen=${stats.seen}, new=${stats.new})`);
    const advanced = count > PAGE_CAP ? await gotoNextPage(page) : false;
    if (!advanced) break;
    pageNum++;
    await sleep(jitter(800, 700));
  }
}

// ---------- main ----------
function resolveRange() {
  if (MODE_DAILY) {
    const last = db.prepare("SELECT range_to FROM runs WHERE ok=1 ORDER BY id DESC LIMIT 1").get();
    const from = last?.range_to || TODAY; // resume from last successful run's end date
    return { mode: 'daily', from, to: TODAY };
  }
  if (MODE_BACKFILL) return { mode: 'backfill', from: EARLIEST, to: TODAY };
  const from = arg('from'); const to = arg('to');
  if (!from || !to || from === true || to === true) {
    console.error('Provide --from MM/DD/YYYY --to MM/DD/YYYY, or --backfill, or --daily');
    process.exit(1);
  }
  return { mode: 'range', from, to };
}

const { mode, from, to } = resolveRange();
log(`MODE=${mode} range=${from}..${to} shard=${SHARD}`);
const runIns = db.prepare('INSERT INTO runs (mode, range_from, range_to, rows_seen, rows_new, started_at) VALUES (?,?,?,0,0,?)');
const runId = runIns.run(mode, from, to, new Date().toISOString()).lastInsertRowid;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const stats = { seen: 0, new: 0 };
let ok = 0;
try {
  await login(page);
  log('logged in (.ASPXAUTH ok)');
  const all = [...shards(from, to, SHARD)];
  log(`${all.length} shards to walk`);
  for (const sh of all) {
    await scrapeShard(page, sh.from, sh.to, stats);
    await sleep(jitter(900, 900)); // polite gap between shards
  }
  ok = 1;
} catch (e) {
  log('ERROR:', e.message);
} finally {
  db.prepare('UPDATE runs SET rows_seen=?, rows_new=?, finished_at=?, ok=? WHERE id=?')
    .run(stats.seen, stats.new, new Date().toISOString(), ok, runId);
  await browser.close();
  const total = db.prepare('SELECT COUNT(*) n FROM filings').get().n;
  log(`DONE ok=${ok} seen=${stats.seen} new=${stats.new} | table total=${total}`);
  db.close();
}
