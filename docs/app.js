'use strict';
// Static build: load docs/data.json once, then do every stat / filter / sort / page in JS.
// (Replaces the old Express /api endpoints — identical UI behaviour.)
const $ = (id) => document.getElementById(id);
const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const fmtNum = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

const WITHDRAWN = 'Withdrawn Unknown';
let ALL = [];          // every row from data.json
let META = {};
const state = { q: '', city: '', status: '', from: '', to: '', hasAddress: false, showWithdrawn: false, sort: 'file_date', dir: 'desc', offset: 0, limit: 100, total: 0 };

// ---- rendering (unchanged from the server version) ----
function ownersHtml(owners) {
  if (!owners || !owners.length) return '<span class="more">—</span>';
  const head = esc(owners[0]);
  const extra = owners.length > 1 ? ` <span class="more">+${owners.length - 1} more</span>` : '';
  return head + extra;
}
function addressHtml(row) {
  const st = row.image_status;
  if (st === 'pending') return '<span class="note">Image not yet published</span>';
  if (st === 'dead') return '<span class="note">No image available</span>';
  const a = row.business.street ? row.business : (row.residence.street ? row.residence : null);
  if (!a || !a.street) return '<span class="note">Image present — address not parsed</span>';
  const reliable = `${esc(a.street)}${a.city ? ', ' + esc(a.city) : ''}`;
  const sz = [a.state, a.zip].filter(Boolean).map(esc).join(' ');
  const szHtml = sz
    ? ` <span class="sz">${sz}</span><span class="flag" title="State &amp; ZIP are OCR low-confidence — verify before use">OCR</span>`
    : ` <span class="flag" title="State &amp; ZIP not captured by OCR">no st/zip</span>`;
  return `<span class="line">${reliable}${szHtml}</span>`;
}
function statusBadge(st) {
  if (st === 'extracted') return '<span class="badge b-ex">Address extracted</span>';
  if (st === 'pending') return '<span class="badge b-pe">Awaiting image</span>';
  if (st === 'dead') return '<span class="badge b-de">No image</span>';
  return '';
}
const isActive = (r) => r.status_type !== WITHDRAWN;

// ---- tiles ----
function loadStats() {
  const active = ALL.filter(isActive);
  const ws = META.weekStart;
  const s = {
    total: active.length,
    newThisWeek: ws ? active.filter((r) => r.file_date >= ws).length : 0,
    extracted: active.filter((r) => r.image_status === 'extracted').length,
    pending: active.filter((r) => r.image_status === 'pending').length,
    dead: active.filter((r) => r.image_status === 'dead').length,
    withdrawn: ALL.length - active.length,
    grandTotal: ALL.length,
    weekStart: ws,
  };
  const tiles = [
    { label: 'Total Leads', num: s.total, foot: `${fmtNum(s.grandTotal)} filings incl. ${fmtNum(s.withdrawn)} withdrawn` },
    { label: 'New This Week', num: s.newThisWeek, foot: s.weekStart ? `since ${fmtDate(s.weekStart)}` : '', accent: true },
    { label: 'Addresses Extracted', num: s.extracted, foot: 'OCR’d from the filed image' },
    { label: 'Awaiting Image', num: s.pending, foot: `${fmtNum(s.dead)} marked no-image` },
  ];
  $('tiles').innerHTML = tiles.map((t) =>
    `<div class="tile ${t.accent ? 'accent' : ''}"><div class="label">${t.label}</div>
     <div class="num">${fmtNum(t.num)}</div><div class="foot">${esc(t.foot)}</div></div>`).join('');
}

// ---- leads of the week ----
function loadLeads() {
  const ws = META.weekStart;
  const rows = ws ? ALL.filter((r) => isActive(r) && r.file_date >= ws) : [];
  $('leadsCnt').textContent = rows.length ? `${fmtNum(rows.length)} filed since ${fmtDate(ws)}` : '';
  if (!rows.length) { $('leadGrid').innerHTML = '<div class="empty">No new filings in the last 7 days.</div>'; return; }
  const CAP = 11;
  $('leadGrid').innerHTML = rows.slice(0, CAP).map((r) => `
    <div class="lead">
      <span class="newbadge">NEW</span>
      <div class="biz">${esc(r.business_name) || '—'}</div>
      <div class="meta">${fmtDate(r.file_date)} · ${statusBadge(r.image_status)}</div>
      <div class="own">${ownersHtml(r.owners)}</div>
      <div class="addr">${addressHtml(r)}</div>
    </div>`).join('') + (rows.length > CAP
      ? `<div class="lead" style="display:grid;place-items:center;text-align:center;cursor:pointer;border-style:dashed" id="moreLeads">
           <div><b>+${fmtNum(rows.length - CAP)} more this week</b><br><span style="color:var(--muted)">see the full list below ↓</span></div>
         </div>` : '');
  const more = $('moreLeads');
  if (more) more.addEventListener('click', () => document.querySelector('.toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// ---- cities ----
function loadCities() {
  const counts = new Map();
  for (const r of ALL) {
    if (!isActive(r)) continue;
    const c = (r.business.city || '').trim();
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const cities = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200);
  $('city').insertAdjacentHTML('beforeend', cities.map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${n})</option>`).join(''));
}

// ---- main table (client-side filter/sort/paginate) ----
const SORT = { file_date: (r) => r.file_date || '', business_name: (r) => (r.business_name || '').toUpperCase(), city: (r) => (r.business.city || r.residence.city || '').toUpperCase() };
function filtered() {
  const q = state.q.trim().toLowerCase();
  let rows = ALL.filter((r) => {
    if (state.showWithdrawn !== true && !isActive(r)) return false;
    if (q) {
      const hay = ((r.business_name || '') + ' ' + (r.owners || []).join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.city && r.business.city !== state.city) return false;
    if (state.status && r.image_status !== state.status) return false;
    if (state.hasAddress && !(r.business.street && r.business.street.trim())) return false;
    if (state.from && (!r.file_date || r.file_date < state.from)) return false;
    if (state.to && (!r.file_date || r.file_date > state.to)) return false;
    return true;
  });
  const key = SORT[state.sort] || SORT.file_date;
  rows.sort((a, b) => { const ka = key(a), kb = key(b); return (ka < kb ? -1 : ka > kb ? 1 : 0) * (state.dir === 'asc' ? 1 : -1) || (a.film_code < b.film_code ? 1 : -1); });
  return rows;
}
function loadRows() {
  const rows = filtered();
  state.total = rows.length;
  const page = rows.slice(state.offset, state.offset + state.limit);
  $('tbody').innerHTML = page.map((r) => `
    <tr>
      <td><div class="biz">${esc(r.business_name) || '—'}</div><div class="fn">${esc(r.film_code)}${r.file_number ? ' · ' + esc(r.file_number) : ''}</div></td>
      <td class="owners">${ownersHtml(r.owners)}</td>
      <td>${fmtDate(r.file_date)}</td>
      <td>${statusBadge(r.image_status)}${r.status_type === WITHDRAWN ? ' <span class="badge b-wd">withdrawn</span>' : ''}</td>
      <td>${esc(r.business.city || r.residence.city || '')}</td>
      <td class="addr">${addressHtml(r)}</td>
    </tr>`).join('');
  $('empty').style.display = page.length ? 'none' : 'block';
  $('rowsCnt').textContent = `${fmtNum(state.total)} match`;
  const end = Math.min(state.offset + state.limit, state.total);
  $('pageInfo').textContent = state.total ? `Showing ${fmtNum(state.offset + 1)}–${fmtNum(end)} of ${fmtNum(state.total)}` : '';
  $('prev').disabled = state.offset <= 0;
  $('next').disabled = end >= state.total;
  document.querySelectorAll('th[data-sort] .arrow').forEach((a) => (a.textContent = ''));
  const th = document.querySelector(`th[data-sort="${state.sort}"] .arrow`);
  if (th) th.textContent = state.dir === 'asc' ? '↑' : '↓';
}

// ---- wiring ----
let t;
const debounce = (fn) => { clearTimeout(t); t = setTimeout(fn, 200); };
function refresh() { state.offset = 0; loadRows(); }
$('q').addEventListener('input', (e) => { state.q = e.target.value; debounce(refresh); });
$('city').addEventListener('change', (e) => { state.city = e.target.value; refresh(); });
$('status').addEventListener('change', (e) => { state.status = e.target.value; refresh(); });
$('from').addEventListener('change', (e) => { state.from = e.target.value; refresh(); });
$('to').addEventListener('change', (e) => { state.to = e.target.value; refresh(); });
$('hasAddr').addEventListener('change', (e) => { state.hasAddress = e.target.checked; refresh(); });
$('showWd').addEventListener('change', (e) => { state.showWithdrawn = e.target.checked; refresh(); });
$('reset').addEventListener('click', () => {
  Object.assign(state, { q: '', city: '', status: '', from: '', to: '', hasAddress: false, showWithdrawn: false, sort: 'file_date', dir: 'desc', offset: 0 });
  $('q').value = ''; $('city').value = ''; $('status').value = ''; $('from').value = ''; $('to').value = '';
  $('hasAddr').checked = false; $('showWd').checked = false; loadRows();
});
$('prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadRows(); });
$('next').addEventListener('click', () => { if (state.offset + state.limit < state.total) { state.offset += state.limit; loadRows(); } });
document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const c = th.dataset.sort;
  if (state.sort === c) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  else { state.sort = c; state.dir = c === 'file_date' ? 'desc' : 'asc'; }
  refresh();
}));

(async function init() {
  // loading state so the page is never blank during the data.json fetch
  $('tiles').innerHTML = '<div class="tile" style="grid-column:1/-1;text-align:center;color:var(--muted)">Loading filings…</div>';
  $('tbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Loading leads…</td></tr>';
  try {
    const data = await (await fetch('./data.json', { cache: 'no-cache' })).json();
    ALL = data.rows || [];
    META = data.meta || {};
    if (META.generatedAt) $('stamp').textContent = `Data refreshed ${new Date(META.generatedAt).toLocaleString('en-US')} · ${fmtNum(ALL.length)} filings`;
    loadStats(); loadLeads(); loadCities(); loadRows();
  } catch (e) {
    $('tiles').innerHTML = `<div class="tile" style="grid-column:1/-1;color:var(--red)">Could not load data.json — run <code>npm run build:data</code> first. (${esc(e.message)})</div>`;
  }
})();
