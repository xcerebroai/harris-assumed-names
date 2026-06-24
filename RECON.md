# Harris County Clerk — Assumed Names Search: Recon

**Date:** 2026-06-23
**Tooling:** Playwright (Chromium, headless), Node v24
**Scope:** Reconnaissance only. No scraper written yet.

Site: `https://www.cclerk.hctx.net/applications/websearch/`
- Search form: `AN.aspx` ("Assumed Names")
- Results page: `AN_R.aspx?ID=<state-token>`
- Document viewer: `EComm/ViewEdocs.aspx?ID=<doc-token>`
- Login: `Registration/Login.aspx`

The provided start URL **loaded successfully (HTTP 200)** and returned a live results
page — **14,519 Record(s) Found** — so the `ID` token was still valid at recon time.
It is search-state-scoped and will eventually expire; treat it as ephemeral.

---

## 1. Pagination

**Mechanism: classic ASP.NET WebForms postback (`__doPostBack`). NOT a GET query param.**

- The whole page is one `<form id="aspnetForm" method="post">`. Results are rendered
  by an ASP.NET `ListView` (`...ListView1`) driven by a `DataPager` control. There are
  **two** identical pagers (top = `DataPager1`, bottom = `DataPager2`).
- Pager links are anchors whose `href` is JS, e.g.:
  - **Next:** `javascript:__doPostBack('ctl00$ContentPlaceHolder1$DataPager1$ctl03$ctl00','')`
  - **Page N:** `javascript:__doPostBack('ctl00$ContentPlaceHolder1$DataPager1$ctl02$ctl0<N-1>','')`
    (page "2" → `ctl02$ctl01`, page "3" → `ctl02$ctl02`, … "..." → `ctl02$ctl05`)
  - **Previous** is a plain disabled `<a>` (empty href) on page 1.
- Clicking sets `__EVENTTARGET` to that control name and POSTs the form back to the
  **same** `AN_R.aspx?ID=...` URL. The URL in the address bar does **not** change
  (no `?page=` param). Verified live: page 1 first File# = `W46825`, after clicking
  "Next" → page 2 first File# = `W46625` (exactly 200 rows apart), URL unchanged, `ID`
  query param retained.

**Page size: 200 rows per page (fixed in markup).** 14,519 records ≈ **73 pages**.
No visible page-size selector and no "show all" option in the UI. The page size is a
server-side `DataPager.PageSize` property — not exposed as a tweakable query param —
so there is **no documented way to request all results at once**. Scraper must walk
all ~73 postback pages (or narrow via search filters to stay under limits).

**Required POST payload per page turn (heavy):**
- `__EVENTTARGET` = pager control name (see above), `__EVENTARGUMENT` = ``
- `__VIEWSTATE` ≈ **234,000 chars** (~234 KB) — must be round-tripped from the prior
  response on every request. This is the main cost/fragility of paginating.
- `__VIEWSTATEGENERATOR` (8 chars), `__EVENTVALIDATION` (~876 chars)
- `__VIEWSTATEENCRYPTED` = `` (empty — viewstate is signed but not encrypted)
- App hidden fields: `ctl00$ContentPlaceHolder1$hfSearchType`, `hfViewCopyOrders`,
  `hfViewECart`
- `__VIEWSTATE` is NOT encrypted but IS MAC-protected, so it cannot be hand-built —
  you must scrape the current viewstate from each response and echo it back.

**Implication for the scraper:** maintain a session, GET/POST the results page, parse
hidden fields out of every response, and re-POST with the Next `__EVENTTARGET`.
Playwright `page.click()` on the Next anchor handles all of this automatically and is
the most robust path; a raw `requests`-style client must re-harvest viewstate each hop.

---

## 2. Document format (ViewEdocs)  —  ✅ RESOLVED (logged in, verified live)

**Documents are scanned page images wrapped in PDF. NO text layer → OCR is required.**
Verified end-to-end with a logged-in session on 2026-06-23.

**Delivery mechanism — `ViewEdocs.aspx` is a self-submitting bootstrap, not a direct file:**
1. A plain **GET** of `EComm/ViewEdocs.aspx?ID=<token>` returns a tiny (~1.4 KB) HTML
   page (title "View Instrument") whose entire job is to **auto-POST a form back to the
   same URL** on `document.ready`. That bootstrap carries `encId` (= the same token) plus
   its own `__VIEWSTATE` / `__VIEWSTATEGENERATOR` / `__EVENTVALIDATION`.
2. The **POST response** is the real payload: `Content-Type: application/pdf`. The browser
   renders it in the built-in PDF viewer, so a naive `page.click`/`goto` never exposes the
   bytes. To capture the PDF you must either intercept the POST and replay it (we replayed
   the captured `postData` via Playwright's `APIRequestContext` — Chromium does not render
   PDFs there, so you get raw bytes) or drive a download.

**The PDF itself (3 sample 2015 filings inspected):**
- Magic `%PDF-1.4`, ~130–168 KB per 1-page filing.
- **Zero embedded fonts** (`/Font` count = 0) ⇒ no selectable/extractable text. `pdftotext`
  yields nothing; pdf.js renders blank (it mis-handles this CCITT variant).
- Each page is a **single image XObject**: `/Subtype /Image`, **`BitsPerComponent 1`**
  (bitonal B&W), **`Width 2545 × Height 3303`** (≈ US-Letter at ~300 DPI), compressed with
  **CCITT Group 4 fax** (`/CCITTFaxDecode`). No DCTDecode/JBIG2.
- Visually confirmed by extracting the CCITT stream → wrapping in a Group-4 TIFF →
  transcoding with sharp/libvips: it's a scanned **"Assumed Name Certificate / Certificate
  of Ownership for Unincorporated Business"** form (Harris County Clerk letterhead, diagonal
  "COPY" watermark, typed field values, notary block + ink signature).

**⇒ Scraper must OCR.** Bitonal 300-DPI scans of a semi-structured government form OCR well
(Tesseract or a cloud OCR). Field extraction will be layout-dependent (zonal OCR against the
fixed form template is more reliable than raw full-page OCR).

**⚠️ Image availability lags filing date — important operational finding:**
- **Recent filings (the 2026 results) have NO image yet.** Their `ViewEdocs` link redirects
  (server-side) to `Message.aspx` which renders **"IMAGE NOT FOUND — Please contact us in
  order to obtain a copy."** (~1.4 KB HTML). Every 2026 doc sampled returned this.
- **Older filings (2015) return the actual PDF.** So scanned images are published with a
  lag; a scraper should detect the "IMAGE NOT FOUND" page and treat that filing's image as
  not-yet-available (metadata is still scrapeable from the results row regardless).
- Distinguish the two by the POST response: `application/pdf` = real doc; an HTML page
  containing "IMAGE NOT FOUND" = image unavailable.

---

## 3. Auth / session

- **Login is required to view documents** (the search + results browsing is public;
  opening any document is gated). Confirmed via the unauthenticated 302 to Login.aspx.
- **Login page:** `Registration/Login.aspx`. Standard ASP.NET `Login` server control:
  - `ctl00$ContentPlaceHolder1$Login1$UserName` (text)
  - `ctl00$ContentPlaceHolder1$Login1$Password` (password)
  - `ctl00$ContentPlaceHolder1$Login1$RememberMe` (checkbox — "Remember me next time")
  - `ctl00$ContentPlaceHolder1$Login1$LoginButton` (submit → `__doPostBack`)
- **CAPTCHA: NONE detected on the login page.** No reCAPTCHA/hCaptcha/sitekey markup
  present. Login is a plain username+password postback. (Account *registration* may
  differ — not tested.)
- **Cookie:** auth is a standard ASP.NET Forms-Authentication cookie (**`.ASPXAUTH`**,
  confirmed live) set on successful `LoginButton` postback, plus `ASP.NET_SessionId` and a
  set of F5 BIG-IP load-balancer cookies (`f5avraaaa..._session_`) and Google Analytics
  (`_ga`). On success the portal redirects to `Home.aspx`. `RememberMe` issues a persistent
  cookie; otherwise it's session-scoped. The scraper should log in once and reuse the jar.
  **Login verified working** with the provided credentials (2026-06-23).
- **Session timeout:** no idle-timeout JS or "1 hour" warning was found in the public
  search/results HTML. The ~1-hour idle warning you mentioned is likely enforced on the
  authenticated portal side — **to be confirmed once logged in.** Plan for re-login /
  session-refresh on long scraping runs regardless.

---

## 4. Results-row fields (exact HTML)

Each result is a `<tr class="odd|even">` containing the ListView item
`ctl00_ContentPlaceHolder1_ListView1_ctrl<i>_...`. Columns, left→right:

| Field | Source element (per row, `i` = row index) | Example |
|---|---|---|
| (select/cart) | empty leading `<td width:50px>` (checkbox slot, blank here) | — |
| **File Number** | `span#...ListView1_ctrl<i>_lblFileNo` | `W46825` |
| **Term** (years) | bare `<td width:25px>` after file-no cell | `10` |
| **Business name** | `span#...ListView1_ctrl<i>_lblDesc2` (labeled "Business:") | `CHARMS AND CHAPTERS` |
| **Owner(s)** | repeated `tr#...ctrl<i>_lvOwners_ctrl<j>_row` → inner `<span>` (labeled "Owner:"); **nested ListView, can be multiple owners per filing** | `HERNANDEZ SANDRA ESPITIA` |
| **Type / Status** | text in the date `<td>` (e.g. `Unincorporated`) | `Unincorporated` |
| **File Date** | `span#...ListView1_ctrl<i>_lblFileDate` | `06/23/2026` |
| **Pages** | `span#...ListView1_ctrl<i>_lblPgs` | `1` |
| **Film Code / Doc link** | `a.doclinks#...ListView1_ctrl<i>_HyperLinkFCEC`, `target="_blank"`, text = film code, `href` = ViewEdocs URL | `ASN-2026-14507` → `EComm/ViewEdocs.aspx?ID=...` |

Notes:
- **Owners is a one-to-many nested list** — parse all `lvOwners_ctrl<j>_row` spans, not
  just the first, or you'll drop co-owners.
- The **Film Code** anchor text and the **document link** are the same element
  (`a.doclinks`). The film code (`ASN-YYYY-NNNNN`) is the human-readable doc id; the
  real link target is the encrypted ViewEdocs token (see §5).
- The header row labels the columns: `File Number | Term | Names | Status/Type | Date | Pgs | Film Code`.

---

## 5. Document-link tokens

**Per-document encrypted tokens harvested from the results page — NOT predictable/iterable.**

- Doc href form: `EComm/ViewEdocs.aspx?ID=<base64-ish blob>` where the blob contains
  `+`, `/`, `=` (Base64). Example (truncated):
  `...ViewEdocs.aspx?ID=8Au+NaHfpnLdGoqih03QNaTMZ+SHxIp15D91KB90hMop+jjxV6xX...`
- Every doc token on the page **shares the same long leading prefix**
  (`8Au+NaHfpnLdGoqih03QN…`) and then diverges. That shared prefix across rows is the
  signature of block-cipher (likely ECB-mode) encryption of a structured server-side
  payload — i.e. the IDs are **server-encrypted blobs, not sequential integers**. You
  **cannot** guess/enumerate them; you **must** harvest each `href` from the rendered
  results rows.
- The **results-page `ID`** (`AN_R.aspx?ID=NJSfuty…`) is a *different* token type
  (search-state, different prefix) and is session/search-scoped & ephemeral.
- **Workflow for the scraper:** search → walk all 73 result pages → for each row capture
  {file no, owners, business, dates, pgs, film code, **ViewEdocs href**} → (authenticated)
  GET each ViewEdocs href to fetch the document. Tokens are only valid in-session, so
  fetch docs within the same logged-in session that produced the results page.

---

## Search form (AN.aspx) — exact fields (verified)

Public form, no date-range requirement (an empty search returns everything). Inputs:
- `ctl00$ContentPlaceHolder1$txtFileNo` — File Number
- `ctl00$ContentPlaceHolder1$txtFilmCd` — Film Code
- `ctl00$ContentPlaceHolder1$txtFrom` / `txtTo` — File-date range (`MM/DD/YYYY`)
- `ctl00$ContentPlaceHolder1$txtBusiness` — Business name
- `ctl00$ContentPlaceHolder1$txtOwner` — Owner name
- `ctl00$ContentPlaceHolder1$btnSearch` (submit) / `btnClear`

Date-range filtering works and is the natural way to shard a full crawl into
sub-result-cap chunks (e.g. one day/week at a time) instead of paging 73× through one
giant 14k-row result set.

## Open items / next step

- **§2 is now RESOLVED** (scanned bitonal PDFs, CCITT G4, no text layer → OCR required;
  recent filings show "IMAGE NOT FOUND" until images are published). Login verified.
- **Idle-timeout still not stress-tested.** Session held fine across the recon run; the
  ~1-hour idle warning was not triggered. Plan for re-login on long crawls regardless.
- **Recon scripts live in repo root** (`recon-doc*.mjs`, `extract-img.mjs`, `render*.mjs`);
  outputs (incl. downloaded PDFs with personal data) go to `recon-out/`, which is
  **git-ignored** so no PII is committed.
- No production scraper written yet. Suggested next build: (1) login + cookie jar,
  (2) date-sharded search walk capturing result-row metadata, (3) per-row ViewEdocs
  GET→auto-POST replay to fetch the PDF (skip/flag "IMAGE NOT FOUND"), (4) OCR pipeline
  (zonal OCR against the fixed form template).

---

## Image publish lag  (✅ characterized live, 2026-06-23)

**Question:** how long after a filing's *File Date* does its scanned image become
available via `ViewEdocs`? Method: for sampled file-dates, pull result-row doc links and
replay the `ViewEdocs` GET→auto-POST, recording `application/pdf` (image published) vs the
`Message.aspx` **"IMAGE NOT FOUND"** HTML (not yet published). Doc-fetch timeouts under the
slow county server are retried (3×, 45 s) so a transient `err` never masquerades as
"not found".

**Coarse sweep — every lookback ≥ ~1 business day already has images:**

| Lookback | File date sampled | Sample result |
|---|---|---|
| 7 d   | 06/16/2026 | 5/5 PDF |
| 14 d  | 06/09/2026 | 5/5 PDF |
| 30 d  | 05/22/2026 | 5/5 PDF |
| 60 d  | 04/24/2026 | 5/5 PDF |
| 90 d  | 03/25/2026 | 5/5 PDF |
| 180 d | 12/24/2025 | 5/5 PDF |
| 365 d | 06/23/2025 | 5/5 PDF |

**Fine sweep of the last week (newest+oldest rows per day):**

| File date | Records | Result |
|---|---|---|
| 06/16/2026 (Tue) | 123 | 6/6 PDF |
| 06/17/2026 (Wed) | 94  | 6/6 PDF |
| 06/18/2026 (Thu) | 95  | 6/6 PDF |
| 06/19–06/21      | 0   | no filings (Juneteenth Fri + weekend) |
| **06/22/2026 (Mon)** | 173 | **8/8 PDF** (newest *and* oldest of the day) |
| **06/23/2026 (Tue, today)** | 66 | **8/8 IMAGE NOT FOUND** (incl. newest `ASN-2026-14551` and oldest sampled) |

**Cutoff: images appear within ~1 business day of filing.**
- **Same-day (today's) filings have NO image yet** — every 06/23 row sampled returns
  "IMAGE NOT FOUND".
- **By the next business day the entire day's batch is published** — all of 06/22 (the
  prior business day, across the full file-number range) returned real PDFs.
- The flip is **per-filing-day, batch-style** (whole day present or whole day absent),
  consistent with an overnight scan/publish job rather than a slow trickle.

**Implication for the scraper:** metadata (this Stage-1 pass) is available immediately and
unaffected. For image/OCR later: rows whose `file_date` is the current day should be left
`image_status='pending'` and re-checked on the next run (≥1 business day later); a daily
incremental that re-pulls from the last run date forward naturally revisits them once the
overnight batch lands. Treat a persistent "IMAGE NOT FOUND" on filings older than a few
business days as genuinely `dead` (never scanned), not lag.

---

## Stage 2 — OCR enrichment + daily re-verify loop (`enrich.mjs`, `daily.mjs`)

Scope: **dashboard data only** — extract the **business** and **residence** addresses that
are *printed on the certificate*. No skip-trace, no enrichment beyond the document.

**Pipeline (`enrich.mjs`)** — for each row `image_status NOT IN ('extracted','dead')`:
1. **Re-harvest a fresh ViewEdocs token** — stored `doc_token`s are session-scoped and
   expire, so we search the **film code** (`txtFilmCd`) to get a live doc link each time.
   (Must `waitForSelector` on the result row — reading the link before the async postback
   renders returns nothing and would be mis-read as "no image".)
2. Replay the GET→auto-POST.
   - HTML **"IMAGE NOT FOUND"** → `image_status='pending'`, `retry_count++`, `last_checked`;
     `retry_count >= 14` → **`dead`** (stop re-checking).
   - **`application/pdf`** → render page-1 (CCITT→TIFF→PNG), **zonal OCR**, write address
     fields, `image_status='extracted'`.
   - A *lookup/render miss* (no link, transient) is logged as an **error** and left as-is —
     it does **not** count toward the dead-out cap (only genuine "IMAGE NOT FOUND" does).
3. Politeness: serial, jittered; `--limit N` time-boxes a batch. `last_checked != today`
   guard prevents double-counting retries on same-day re-runs.

**Zonal OCR (`lib/ocr.mjs`, Tesseract.js)** — the 2026 form is fixed-layout (2550×3300 @
300 dpi). Each value line is cropped to its own tight band and OCR'd in single-line mode
(PSM 7); City/State/Zip assigned by x-cell; street anchored on the first digit-bearing
token (drops mangled "Residence Address"/"(print or type)" labels + box borders); state
normalized for the common `TX`→`T™` misread.
- Bands: `biz_street 0.176–0.198`, `biz_csz 0.199–0.223`, `res_street 0.400–0.420`,
  `res_csz 0.421–0.444` (fractions of page height).

**Daily orchestration (`daily.mjs`)** chains: (a) `scraper.mjs --daily` (new rows) →
(b/c/d) `enrich.mjs` whose single query covers new rows, re-verifies prior-day `pending`
rows, and ages `pending` past the cap to `dead`. Enrichment processes oldest-first (those
reliably have images per the lag finding).

### Accuracy — 10-row spot check (visually verified vs. the rendered form)

Field fill-rate over the 10 extracted rows: business street 8/10, city 5/10, state 3/10,
zip 4/10; residence street 10/10, city 6/10, state 4/10, zip 5/10.

**Per-field exact accuracy ≈ 41% (26/64 fields over 8 ground-truth-verified rows)**
(2 of 10 could not be re-rendered for verification — county server was throttling).
- **Residence block beats business block** (residence CSZ is in a cleaner part of the form;
  the business address line is more often crossed by the diagonal "OFFICIAL/UNOFFICIAL
  COPY" watermark — 2 rows lost the *entire* business block).
- **By field:** city/street are the most reliable; **state is weakest** (frequently dropped
  when the whole CSZ line is watermark-obscured); zip moderate, with occasional ±1 digit
  errors (e.g. `77581`→`77580`).
- **At least one usable street** captured for ~7/8 rows; a **complete** address
  (street+city+state+zip) for ~3/8.
- Dominant failure mode is the **watermark** over value lines, plus leading/most-significant
  **digit corruption** (`11900`→`711900`, `5207`→`5507`).

**Honest assessment:** the zonal Tesseract pipeline is wired end-to-end and correct
(fetch → classify → render → OCR → DB; retry/age-out works), but raw accuracy on these
watermarked bitonal scans is **modest (~40% exact fields)** and not yet production-grade.
Clear upgrade path (future work, not done here): watermark suppression via
connected-component filtering before OCR; multi-PSM consensus; or a cloud OCR
(Google Vision / Textract) which handles watermarked forms far better. Schema and loop are
OCR-engine-agnostic, so swapping the recognizer is a `lib/ocr.mjs`-only change.

### New columns (self-migrated by `enrich.mjs`)
`retry_count`, `last_checked`, `extracted_at`, `business_street/city/state/zip`,
`residence_street/city/state/zip`, `ocr_raw`.
