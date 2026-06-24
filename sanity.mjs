// Aggregate sanity checks across ALL extracted rows. Report-only, no mutations.
import Database from 'better-sqlite3';
const db = new Database('./data/assumed_names.db', { readonly: true });
const N = db.prepare("SELECT COUNT(*) n FROM filings WHERE image_status='extracted'").get().n;
const one = (q) => db.prepare(q).get().n;
console.log(`=== Sanity checks over ${N} extracted rows ===\n`);

const US = "('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC')";

for (const [label, q] of [
  ['business_zip not 5 digits (non-null)', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND business_zip IS NOT NULL AND business_zip NOT GLOB '[0-9][0-9][0-9][0-9][0-9]'`],
  ['residence_zip not 5 digits (non-null)', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND residence_zip IS NOT NULL AND residence_zip NOT GLOB '[0-9][0-9][0-9][0-9][0-9]'`],
  ['business_state not valid US code (non-null)', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND business_state IS NOT NULL AND business_state NOT IN ${US}`],
  ['residence_state not valid US code (non-null)', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND residence_state IS NOT NULL AND residence_state NOT IN ${US}`],
  ['business_street empty/null', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND (business_street IS NULL OR TRIM(business_street)='')`],
  ['residence_street empty/null', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND (residence_street IS NULL OR TRIM(residence_street)='')`],
  ['business_street has NO digit (non-null)', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND business_street IS NOT NULL AND business_street NOT GLOB '*[0-9]*'`],
  ['residence_street has NO digit (non-null)', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND residence_street IS NOT NULL AND residence_street NOT GLOB '*[0-9]*'`],
  ['business_city contains a digit', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND business_city GLOB '*[0-9]*'`],
  ['residence_city contains a digit', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND residence_city GLOB '*[0-9]*'`],
  ['business_zip not in Harris-area 77xxx/770-77xxx (non-null)', `SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND business_zip IS NOT NULL AND business_zip NOT GLOB '77[0-9][0-9][0-9]'`],
]) {
  console.log(`${String(one(q)).padStart(4)}  ${label}`);
}

console.log('\n--- null/blank field counts (extracted rows) ---');
console.log(db.prepare(`SELECT
  SUM(business_street IS NULL) bs_null, SUM(business_city IS NULL) bc_null, SUM(business_state IS NULL) bst_null, SUM(business_zip IS NULL) bz_null,
  SUM(residence_street IS NULL) rs_null, SUM(residence_city IS NULL) rc_null, SUM(residence_state IS NULL) rst_null, SUM(residence_zip IS NULL) rz_null
  FROM filings WHERE image_status='extracted'`).get());

console.log('\n--- distinct (invalid) state values seen ---');
console.log('business_state:', db.prepare(`SELECT business_state v, COUNT(*) n FROM filings WHERE image_status='extracted' AND business_state IS NOT NULL AND business_state NOT IN ${US} GROUP BY business_state`).all());
console.log('residence_state:', db.prepare(`SELECT residence_state v, COUNT(*) n FROM filings WHERE image_status='extracted' AND residence_state IS NOT NULL AND residence_state NOT IN ${US} GROUP BY residence_state`).all());

console.log('\n--- proposed deterministic fix preview (NOT applied) ---');
const tmFix = db.prepare(`SELECT COUNT(*) n FROM filings WHERE image_status='extracted' AND (business_state GLOB '*[™×]*' OR residence_state GLOB '*[™×]*')`).get().n;
console.log(`T™/×→TX style fix would touch: ${tmFix} rows`);
db.close();
