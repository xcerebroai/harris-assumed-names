// Skip-trace export: build a CSV of export-ready leads from data/assumed_names.db.
//
// COLUMNS: first_name,last_name,property_address,property_city,property_state,property_zip,address_source
//
// QUALIFY: image_status='extracted', NOT withdrawn, a confidently-parseable primary-owner
//          name, AND a fully-clean 4-part address (residence preferred, else business).
// HOLD (excluded, retried next run): incomplete/garbled address OR unparseable name.
// DEDUP: exports/exported_keys.json ledger — only NEW film_codes are written; rows already
//        sent are never re-exported. Held-back rows are NOT ledgered, so they get another
//        chance once a later OCR pass cleans them up.
//
// Usage: node export-skiptrace.mjs [--today YYYYMMDD] [--dry-run]
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, 'data', 'assumed_names.db');
const EXPORT_DIR = path.join(__dirname, 'exports');
const LEDGER = path.join(EXPORT_DIR, 'exported_keys.json');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
// Local-date stamp (not UTC) so the filename matches the operator's calendar day.
const localStamp = (() => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
})();
const STAMP = arg('today', localStamp);

// ---------- name parsing ----------
// Common Hispanic paternal/maternal surnames. Used to detect double-surname structure:
// in "A B C", if B is a recognized surname we treat last="A B", first=C; otherwise B is a
// given/middle name and last=A, first=B.
const HISPANIC_SURNAMES = new Set(`
GARCIA RODRIGUEZ MARTINEZ HERNANDEZ LOPEZ GONZALEZ PEREZ SANCHEZ RAMIREZ TORRES
FLORES RIVERA GOMEZ DIAZ REYES MORALES CRUZ ORTIZ GUTIERREZ CHAVEZ RAMOS GONZALES
RUIZ ALVAREZ MENDOZA VAZQUEZ VASQUEZ CASTILLO JIMENEZ MORENO ROMERO HERRERA MEDINA
AGUILAR GARZA CASTRO VARGAS FERNANDEZ GUZMAN MUNOZ MENDEZ SALAZAR ROJAS DOMINGUEZ
VILLANUEVA ESPINOZA ESPINOSA CONTRERAS PINEDA ARIAS SUAREZ SOTO DELGADO CERVANTES
CARRILLO ESTRADA ORTEGA NUNEZ NAVARRO MALDONADO CORTES CORTEZ ROSALES VEGA AVILA
MARQUEZ JUAREZ MEJIA FIGUEROA LARA VICENTE GALLEGOS RIOS MONTOYA CAMACHO VELASQUEZ
PADILLA VILLA VALENZUELA CABRERA VALDEZ MACIAS VELAZQUEZ VILLARREAL VILLAREAL ZAMORA
VALDES VILLEGAS VILLALOBOS RANGEL PENA VENEGAS ACOSTA VEGA TREJO VILLALPANDO ANGULO
LEON LUNA AYALA SANTIAGO COREA BARRERA BUENO CEDENO MADRID GUEVARA AGUIRRE QUINTERO
SANDOVAL TREVINO BAUTISTA MATA LOZANO IBARRA ZUNIGA ESCOBAR MELENDEZ FUENTES CISNEROS
PALACIOS MONTES SERRANO GALVAN VERA CANO DURAN BENITEZ GAMEZ ALONSO ARELLANO ARREDONDO
CARDENAS TAPIA CORDOVA OLIVARES BARAJAS MANZO PONCE RINCON SOSA ULLOA URIBE VILLANUEVA
ZAVALA NAVA OROZCO PERALTA SOLANO ZARAGOZA GALINDO CHAVARRIA BETANCOURT DARAWSHA
`.trim().split(/\s+/));

// Surname particles that bind into the family name.
const PARTICLES = new Set(['DE', 'DEL', 'DELA', 'LA', 'LAS', 'LOS', 'Y', 'VAN', 'VON', 'DER', 'DI', 'DA', 'DOS', 'MAC', 'MC', 'SAN', 'SANTA', 'ST', "O'"]);
const SUFFIXES = new Set(['JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV', 'V']);

// Returns { first, last } or { flag: reason }.
function parseName(primary) {
  if (!primary || !primary.trim()) return { flag: 'empty' };
  let toks = primary.trim().toUpperCase().split(/\s+/).filter(Boolean);
  // strip generational suffixes (kept out of the name columns)
  toks = toks.filter((t) => !SUFFIXES.has(t));
  if (toks.length < 2) return { flag: `mononym(${toks.length}tok)` };
  if (toks.length > 5) return { flag: `too-many(${toks.length}tok)` };

  if (toks.length === 2) return { last: toks[0], first: toks[1] };

  // 3+ tokens: determine the surname span from the front.
  const surname = [toks[0]];
  let i = 1;
  // absorb particles that immediately follow the first surname
  while (i < toks.length - 1 && PARTICLES.has(toks[i])) { surname.push(toks[i]); i++; }
  // a recognized second (maternal) surname?
  if (i < toks.length - 1 && HISPANIC_SURNAMES.has(toks[i])) {
    surname.push(toks[i]); i++;
    while (i < toks.length - 1 && PARTICLES.has(toks[i])) { surname.push(toks[i]); i++; }
  }
  const first = toks[i];
  if (!first) return { flag: 'no-given-name' };
  return { last: surname.join(' '), first };
}

// ---------- address cleanliness ----------
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));

// Harris County + surrounding metro cities (correctly spelled). A strict allowlist is the
// highest-precision guard against OCR garbage like "HOOUSTON", "TOMBALL LO", "BL HOUSTO NT".
const CITIES = new Set([
  'HOUSTON', 'BAYTOWN', 'PASADENA', 'PEARLAND', 'SPRING', 'CYPRESS', 'KATY', 'HUMBLE',
  'KINGWOOD', 'TOMBALL', 'CONROE', 'FRIENDSWOOD', 'LEAGUE CITY', 'DEER PARK', 'LA PORTE',
  'WEBSTER', 'STAFFORD', 'MISSOURI CITY', 'SUGAR LAND', 'BELLAIRE', 'CHANNELVIEW', 'CROSBY',
  'HIGHLANDS', 'HUFFMAN', 'ATASCOCITA', 'MANVEL', 'ALVIN', 'DICKINSON', 'TEXAS CITY',
  'GALVESTON', 'RICHMOND', 'ROSENBERG', 'FRESNO', 'HOCKLEY', 'MAGNOLIA', 'PORTER',
  'SPLENDORA', 'NEW CANEY', 'DAYTON', 'MONT BELVIEU', 'SANTA FE', 'SEABROOK', 'KEMAH',
  'PINEHURST', 'WALLER', 'BROOKSHIRE', 'FULSHEAR', 'CLEVELAND', 'HUNTSVILLE', 'WILLIS',
  'MONTGOMERY', 'SOUTH HOUSTON', 'GALENA PARK', 'JACINTO CITY', 'JERSEY VILLAGE',
  'NASSAU BAY', 'EL LAGO', 'TAYLOR LAKE VILLAGE', 'SHENANDOAH', 'OAK RIDGE NORTH',
  'PRAIRIE VIEW', 'HEMPSTEAD', 'SEALY', 'NEEDVILLE', 'ANGLETON', 'LIBERTY', 'DEVERS',
  'BARKER', 'ROSHARON', 'IOWA COLONY', 'BACLIFF', 'SAN LEON', 'HITCHCOCK', 'SANTA ROSA',
]);

const cleanZip = (z) => typeof z === 'string' && /^\d{5}$/.test(z.trim());
const cleanState = (s) => typeof s === 'string' && US_STATES.has(s.trim().toUpperCase());
const cleanCity = (c) => typeof c === 'string' && CITIES.has(c.trim().toUpperCase());
// House-number lead + a real street-name word; rejects "RIMOROPE...", "GO07...", "1 1 6 1 8".
const cleanStreet = (s) => {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  return v.length >= 6 && v.length <= 50 && /^\d{1,6}\b/.test(v) && /[A-Za-z]{3,}/.test(v);
};
// TX zips are 75xxx–79xxx and 733xx/885xx. If the zip is clearly Texas but the state isn't
// TX, the OCR'd state is garbage (e.g. "CO 77064", "TN 77...") — reject the whole address.
const zipStateConsistent = (state, zip) => {
  const st = state.trim().toUpperCase(), z = zip.trim();
  const isTxZip = /^7[5-9]\d{3}$/.test(z) || /^733\d{2}$/.test(z) || /^885\d{2}$/.test(z);
  if (isTxZip && st !== 'TX') return false;
  if (st === 'TX' && !isTxZip) return false;
  return true;
};

function pickAddress(r) {
  const cand = (street, city, state, zip, source) => {
    if (cleanStreet(street) && cleanCity(city) && cleanState(state) && cleanZip(zip) && zipStateConsistent(state, zip)) {
      return { property_address: street.trim(), property_city: city.trim().toUpperCase(), property_state: state.trim().toUpperCase(), property_zip: zip.trim(), address_source: source };
    }
    return null;
  };
  return cand(r.residence_street, r.residence_city, r.residence_state, r.residence_zip, 'residence')
      || cand(r.business_street, r.business_city, r.business_state, r.business_zip, 'business');
}

// ---------- CSV ----------
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const HEADER = ['first_name', 'last_name', 'property_address', 'property_city', 'property_state', 'property_zip', 'address_source'];

// ---------- run ----------
const db = new Database(DB, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT film_code, owners,
         business_street, business_city, business_state, business_zip,
         residence_street, residence_city, residence_state, residence_zip
  FROM filings
  WHERE image_status='extracted' AND status_type != 'Withdrawn Unknown'
  ORDER BY file_date DESC, film_code DESC
`).all();
db.close();

fs.mkdirSync(EXPORT_DIR, { recursive: true });
const ledger = fs.existsSync(LEDGER) ? new Set(JSON.parse(fs.readFileSync(LEDGER, 'utf8'))) : new Set();

const stats = { total: rows.length, alreadyExported: 0, exported: 0, residence: 0, business: 0, heldAddress: 0, heldName: 0 };
const out = [];
const newKeys = [];

for (const r of rows) {
  if (ledger.has(r.film_code)) { stats.alreadyExported++; continue; }

  let owners = [];
  try { owners = JSON.parse(r.owners || '[]'); } catch { owners = []; }
  const name = parseName(owners[0] || '');
  if (name.flag) { stats.heldName++; continue; }

  const addr = pickAddress(r);
  if (!addr) { stats.heldAddress++; continue; }

  out.push([name.first, name.last, addr.property_address, addr.property_city, addr.property_state, addr.property_zip, addr.address_source]);
  newKeys.push(r.film_code);
  stats.exported++;
  stats[addr.address_source]++;
}

const csvPath = path.join(EXPORT_DIR, `harris-skiptrace-${STAMP}.csv`);
const csv = [HEADER.join(','), ...out.map((row) => row.map(csvCell).join(','))].join('\r\n') + '\r\n';

if (!DRY) {
  if (out.length) {
    fs.writeFileSync(csvPath, csv);
    fs.writeFileSync(LEDGER, JSON.stringify([...ledger, ...newKeys], null, 0));
  }
}

console.log('=== SKIP-TRACE EXPORT ===');
console.log(`extracted, non-withdrawn rows : ${stats.total}`);
console.log(`already exported (ledger)     : ${stats.alreadyExported}`);
console.log(`NEW qualified -> exported     : ${stats.exported}`);
console.log(`   using residence address   : ${stats.residence}`);
console.log(`   using business address    : ${stats.business}`);
console.log(`held — incomplete address    : ${stats.heldAddress}`);
console.log(`held — unparseable name      : ${stats.heldName}`);
if (DRY) console.log('(dry-run: nothing written)');
else if (out.length) console.log(`wrote ${csvPath}  (${out.length} rows)\nledger now ${ledger.size + newKeys.length} keys`);
else console.log('no new qualified rows — nothing written');
