// Build step for the static GitHub Pages site.
// Reads data/assumed_names.db (read-only) and writes docs/data.json — the public-safe
// row data the UI needs. Internal-only fields (doc_token session blobs, ocr_raw, retry
// bookkeeping) are intentionally excluded. Re-run via `npm run build` to refresh.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, 'data', 'assumed_names.db');
const OUT = path.join(__dirname, 'docs', 'data.json');

const db = new Database(DB, { readonly: true, fileMustExist: true });
try {
  // All current filings. Withdrawn ("Withdrawn Unknown") rows are INCLUDED but tagged via
  // status_type, so the dashboard's hide-by-default + "show withdrawn" toggle and the
  // stat tiles keep working exactly as built (the client filters them out by default).
  const raw = db.prepare(`
    SELECT film_code, file_number, term, business_name, owners, status_type, file_date, pages, image_status,
           business_street, business_city, business_state, business_zip,
           residence_street, residence_city, residence_state, residence_zip
    FROM filings
    ORDER BY file_date DESC, film_code DESC
  `).all();

  const rows = raw.map((r) => {
    let owners = [];
    try { owners = JSON.parse(r.owners || '[]'); } catch { owners = []; }
    return {
      film_code: r.film_code, file_number: r.file_number, term: r.term,
      business_name: r.business_name, owners, status_type: r.status_type,
      file_date: r.file_date, pages: r.pages, image_status: r.image_status,
      business: { street: r.business_street, city: r.business_city, state: r.business_state, zip: r.business_zip },
      residence: { street: r.residence_street, city: r.residence_city, state: r.residence_state, zip: r.residence_zip },
    };
  });

  // "This week" window anchored on the latest file_date (advances as the daily job adds rows).
  const anchor = db.prepare('SELECT MAX(file_date) m FROM filings').get().m;
  const weekStart = anchor ? db.prepare("SELECT date(?, '-6 days') s").get(anchor).s : null;

  const payload = {
    meta: { generatedAt: new Date().toISOString(), grandTotal: rows.length, anchor, weekStart, withdrawnLabel: 'Withdrawn Unknown' },
    rows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload)); // minified to keep the file small
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`wrote ${OUT}  (${rows.length} rows, ${kb} KB, weekStart ${weekStart})`);
} finally {
  db.close();
}
