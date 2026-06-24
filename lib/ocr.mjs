// Anchor-based zonal OCR for the Harris County Assumed-Name certificate.
//
// Root-cause fix: fixed-pixel crops drift on scans that vary in offset/skew/scale,
// which dropped whole City/State/Zip lines (nulls) and bled adjacent bands into city.
// Instead we OCR the WHOLE image once at word level, group words into text lines
// (so line grouping follows the page's actual skew), locate the pre-printed labels
// as anchors, and read each value by its geometric position relative to its label:
//   - street  = tokens to the RIGHT of "BUSINESS ADDRESS" / on the residence line
//   - C/S/Z   = the line directly BELOW the street line; city/state/zip then assigned
//               by CONTENT (zip = 5 digits, state = valid 2-letter code, city = rest),
//               which is skew/scale independent and tolerant of mangled small labels.
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';

let _worker = null;
export async function getWorker() {
  if (_worker) return _worker;
  _worker = await createWorker('eng');
  await _worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO }); // full-page layout
  return _worker;
}
export async function closeWorker() { if (_worker) { await _worker.terminate(); _worker = null; } }

const US_STATE = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const normSt = (t) => (t || '').toUpperCase().replace(/[™×✗]/g, 'X').replace(/[^A-Z]/g, '');
const clean = (s) => (s || '').replace(/[^A-Za-z0-9 .,'#/-]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.,'#/-]+|[\s.,'#/-]+$/g, '').trim();
const LABEL = /^(BUSINESS|ADDRESS|ADDRE\w*|RESIDENCE|CITY|STATE|ZIP|PRINT|TYPE|OR|NAME|SIGNATURE|CRY|CRRY|CRATE|SAW|RO|ST|PERIOD)$/i;
const JUNKWORD = /^(RI[MN]OROPE|PRI?[CN]?[EI]DENCE|GONARURE|PRINOROPE|GONG|GGG|BRE|SB|TT|BN|EE)$/i;

function flattenWords(data) {
  const out = [];
  for (const b of data.blocks || [])
    for (const p of b.paragraphs || [])
      for (const l of p.lines || [])
        for (const w of l.words || []) {
          const t = (w.text || '').trim();
          if (t) out.push({ t, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 });
        }
  return out;
}

// Group words into lines by vertical proximity (skew-tolerant).
function groupLines(words) {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
  const heights = sorted.map((w) => w.h).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 20;
  const lines = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const curYc = cur.reduce((s, x) => s + x.yc, 0) / cur.length;
    if (Math.abs(w.yc - curYc) <= medH * 0.6) cur.push(w);
    else { lines.push(cur); cur = [w]; }
  }
  lines.push(cur);
  return lines.map((ws) => {
    ws.sort((a, b) => a.x0 - b.x0);
    return { yc: ws.reduce((s, x) => s + x.yc, 0) / ws.length, words: ws, text: ws.map((w) => w.t).join(' ') };
  });
}

// street value from a line: drop leading label tokens, anchor on the first digit token.
function streetFromLine(lineWords, afterLabelRe) {
  let toks = lineWords.map((w) => w.t);
  if (afterLabelRe) {
    const i = toks.findIndex((t) => afterLabelRe.test(t));
    if (i >= 0) toks = toks.slice(i + 1);
  }
  // anchor on first digit-bearing token (house number)
  const d = toks.findIndex((t) => /\d/.test(t));
  if (d > 0) toks = toks.slice(d);
  toks = toks.filter((t) => !LABEL.test(t) && !JUNKWORD.test(t) && !/^\(?(print|type)\)?$/i.test(t));
  const s = clean(toks.join(' ')).toUpperCase();
  return s.length >= 3 ? s : null;
}

// city/state/zip from a line by content.
function cszFromLine(lineWords) {
  const toks = lineWords.map((w) => w.t);
  let zip = null, zipIdx = -1;
  for (let i = toks.length - 1; i >= 0; i--) { const m = toks[i].match(/\b(\d{5})\b/); if (m) { zip = m[1]; zipIdx = i; break; } }
  let state = null, stIdx = -1;
  const upTo = zipIdx >= 0 ? zipIdx : toks.length;
  for (let i = upTo - 1; i >= 0; i--) { const c = normSt(toks[i]); if (c.length === 2 && US_STATE.has(c) && !LABEL.test(toks[i])) { state = c; stIdx = i; break; } }
  const cityEnd = stIdx >= 0 ? stIdx : (zipIdx >= 0 ? zipIdx : toks.length);
  const cityToks = toks.slice(0, cityEnd).filter((t) => /^[A-Za-z][A-Za-z.'-]+$/.test(t) && !LABEL.test(t) && !JUNKWORD.test(t) && !STOP.test(t));
  const city = clean(cityToks.join(' ')).toUpperCase() || null;
  return { city: city && city.length >= 2 ? city : null, state, zip };
}

const BOILER = /PERIOD|EXCEED|CONDUCTED|UNDERSIGNED|OWNERSHIP|VENTURE|PARTNERSHIP|PROPRIETOR|PRACTITIONER|INVESTMENT|DURING\s+WHICH/i;
// Boilerplate uppercase words that must not be mistaken for a city.
const STOP = /^(DURING|WHICH|ASSUMED|CONDUCTED|PERIOD|EXCEED|SOLE|GENERAL|JOINT|VENTURE|STOCK|COMPANY|REAL|ESTATE|INVESTMENT|TRUST|PROPRIETORSHIP|PRACTITIONER|OTHER|NAME|NAMES|OWNERS|SIGNATURE|RESIDENCE|ADDRESS|BUSINESS|UNDERSIGNED|OWNERSHIP|PARTNERSHIP|YEARS|USED|CHECK|ONE|TRUE|CORRECT|WILL|THERE|GIVEN)$/i;

// STREET line: a >=2-digit house number with street-name word(s) AFTER it
// (distinguishes "14423 ROSEHEDGE CT" from a C/S/Z line "HOUSTON TX 77047").
function isStreetLine(l) {
  if (BOILER.test(l.text)) return false;
  const toks = l.words.map((w) => w.t);
  const ni = toks.findIndex((t) => /\d{2,}/.test(t));
  if (ni < 0) return false;
  const after = toks.slice(ni + 1).filter((t) => /[A-Za-z]{2,}/.test(t) && !LABEL.test(t) && !JUNKWORD.test(t) && !STOP.test(t));
  return after.length >= 1;
}
// CITY/STATE/ZIP line: a zip, a valid state code, or an all-caps city-like word
// (excluding boilerplate). Not a street/boilerplate line.
function isCSZLine(l) {
  if (BOILER.test(l.text)) return false;
  if (/\b\d{5}\b/.test(l.text)) return true;
  for (const w of l.words) {
    const c = normSt(w.t);
    if (c.length === 2 && US_STATE.has(c) && !LABEL.test(w.t)) return true;
  }
  return l.words.some((w) => /^[A-Z][A-Z.'-]{3,}$/.test(w.t) && !LABEL.test(w.t) && !JUNKWORD.test(w.t) && !STOP.test(w.t));
}
function firstBelow(lines, fromIdx, pred, maxGap = 6) {
  for (let i = fromIdx + 1; i < lines.length && i <= fromIdx + maxGap; i++) if (pred(lines[i])) return i;
  return -1;
}

// Extract a {street,city,state,zip} block anchored on a section header line.
// On these scans the typed VALUE prints on its own line and the pre-printed LABEL
// ("BUSINESS ADDRESS", "CITY"...) lands on a separate, often-garbled line — so we
// ignore labels and scan downward from the reliable header for value lines by content.
function blockFrom(lines, headerIdx) {
  const out = { street: null, city: null, state: null, zip: null };
  if (headerIdx < 0) return out;
  const stIdx = firstBelow(lines, headerIdx, isStreetLine, 6);
  if (stIdx >= 0) {
    out.street = streetFromLine(lines[stIdx].words, /RESIDENCE|ADDRE/i);
    const cszIdx = firstBelow(lines, stIdx, isCSZLine, 4);
    if (cszIdx >= 0) Object.assign(out, cszFromLine(lines[cszIdx].words));
  }
  return out;
}

// Preprocessing variants. The scanned forms carry a dithered "OFFICIAL COPY" halftone
// watermark whose dots collide with the small City/State/Zip digits; denoising it before
// OCR is the lever. Default 'full' keeps the original behaviour (enrich.mjs unaffected).
export async function preprocess(png, pre = 'full') {
  const W = 3000;
  const s = () => sharp(png);
  switch (pre) {
    case 'full':       return s().resize({ width: W }).grayscale().normalize().png().toBuffer();
    case 'low':        return s().resize({ width: 1500 }).resize({ width: W }).grayscale().normalize().png().toBuffer();
    case 'med3':       return s().resize({ width: W }).grayscale().normalize().median(3).png().toBuffer();
    case 'med5':       return s().resize({ width: W }).grayscale().normalize().median(5).png().toBuffer();
    case 'med3n':      return s().grayscale().normalize().median(3).resize({ width: W }).png().toBuffer();
    case 'med5n':      return s().grayscale().normalize().median(5).resize({ width: W }).png().toBuffer();
    case 'despeckle':  return s().resize({ width: W }).grayscale().normalize().median(5).sharpen().png().toBuffer();
    case 'blurthresh': return s().resize({ width: W }).grayscale().normalize().blur(1.2).threshold(150).png().toBuffer();
    case 'blurthresh2':return s().resize({ width: W }).grayscale().normalize().blur(0.8).threshold(165).png().toBuffer();
    default:           return s().resize({ width: W }).grayscale().normalize().png().toBuffer();
  }
}

export async function extractAddresses(png, opts = {}) {
  const worker = await getWorker();
  // 'med5' (median 5x5) suppresses the dithered "OFFICIAL COPY" watermark that collides
  // with the small City/State/Zip digits — best variant measured (22/40 vs full 15, low 19).
  const buf = await preprocess(png, opts.pre || 'med5');
  const { data } = await worker.recognize(buf, {}, { blocks: true });
  const lines = groupLines(flattenWords(data));

  // Reliable section-header anchors (large pre-printed text, OCRs well).
  const bizHdr = lines.findIndex((l) => /NAME\s+IN\s+WHICH|BUSINESS\s+IS\s+OR\s+WILL/i.test(l.text));
  let ownHdr = lines.findIndex((l) => /OWNERS/i.test(l.text));
  if (ownHdr < 0) ownHdr = lines.findIndex((l) => /SIGNATURE/i.test(l.text));

  const b = blockFrom(lines, bizHdr >= 0 ? bizHdr : -1);
  const r = blockFrom(lines, ownHdr);

  return {
    business_street: b.street, business_city: b.city, business_state: b.state, business_zip: b.zip,
    residence_street: r.street, residence_city: r.city, residence_state: r.state, residence_zip: r.zip,
    _lines: lines.map((l) => l.text),
  };
}
