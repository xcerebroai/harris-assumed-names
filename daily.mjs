// Daily orchestrator: one invocation does the full day's work.
//   (a) Stage 1  : scrape NEW result rows since the last successful run (scraper --daily)
//   (b) Stage 2  : ONE conservative enrichment batch (default --limit 150). The county
//                  server throttles after ~150-200 docs/session, so we deliberately cap
//                  each daily run instead of grinding the full backlog. enrich.mjs's query
//                  (image_status NOT IN ('extracted','dead') AND last_checked != today)
//                  skips already-extracted rows and re-verifies prior pending rows; only a
//                  genuine "IMAGE NOT FOUND" burns a retry strike — timeouts are transient.
//   (c) Export   : generate a fresh dated DELTA skip-trace CSV of newly-qualified rows only
//                  (ledger-based; already-exported film_codes never repeat). Output lands in
//                  exports/ which is gitignored — this PII never enters git.
//   (d) Publish  : rebuild docs/data.json, then commit + push so the GitHub Pages dashboard
//                  refreshes. Staging is restricted to docs/data.json; exports/ is never
//                  staged (and a guard aborts the push if anything under exports/ ever is).
//
// Designed to run unattended in the early-morning low-traffic window (see the Windows
// Scheduled Task "HarrisAssumedNames-Daily").
//
// Usage: node daily.mjs [--limit N] [--today MM/DD/YYYY] [--no-publish]
//   --limit defaults to 150 (the safe per-session batch). Pass --limit 0 for uncapped.
import { spawn, execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const passthrough = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? [flag, argv[i + 1]] : []; };
const has = (flag) => argv.includes(flag);

const today = passthrough('--today');
// Default the daily enrichment to a conservative 150-doc batch unless overridden.
const limitArg = passthrough('--limit');
const limit = limitArg.length ? limitArg : ['--limit', '150'];
const doPublish = !has('--no-publish');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
    p.on('error', reject);
  });
}
const node = (script, args) => run(process.execPath, [script, ...args]);

console.log(`=== DAILY ${new Date().toISOString()} ===`);

console.log('\n=== Stage 1: scrape new rows ===');
await node('./scraper.mjs', ['--daily', ...today]);

console.log(`\n=== Stage 2: OCR enrich (batch ${limit[1] === '0' ? 'uncapped' : limit[1]}) ===`);
await node('./enrich.mjs', [...today, ...limit]);

// Stage 3: local-only delta skip-trace CSV (gitignored PII). Runs even with --no-publish.
console.log('\n=== Stage 3: skip-trace export (local delta CSV) ===');
await node('./export-skiptrace.mjs', []);

if (!doPublish) {
  console.log('\n=== Publish skipped (--no-publish) ===\n=== DAILY: done ===');
} else {
  console.log('\n=== Stage 4: publish — rebuild data.json + commit + push ===');
  await node('./build-data.mjs', []);

  const git = (args) => run('git', args);
  // Stage ONLY the public dashboard data — never `git add .`/`-A`, so exports/ (PII) and
  // any other local artifacts can never be swept into the commit.
  await git(['add', 'docs/data.json']);

  // Safety guard: assert nothing under exports/ (or the ledger) is staged before we push.
  // If this ever trips, something is misconfigured — abort rather than risk leaking PII.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  const leaked = staged.filter((p) => p.startsWith('exports/'));
  if (leaked.length) {
    console.error('ABORT: refusing to push — exports/ paths are staged:', leaked.join(', '));
    process.exit(1);
  }
  console.log(`staged for commit: ${staged.length ? staged.join(', ') : '(nothing)'}`);

  const stamp = new Date().toISOString().slice(0, 10);
  // Commit and push are handled separately: a failing `git commit` is routine (nothing
  // staged), but a failing `git push` means the dashboard has silently stopped updating
  // and must surface as a non-zero exit. Sharing one catch hid 48 rejected pushes for
  // three weeks by reporting every one of them as "nothing to publish".
  let committed = true;
  try {
    await git(['commit', '-m', `daily refresh ${stamp}: rebuild dashboard data`]);
  } catch {
    // `git commit` exits non-zero when there's nothing staged (no new addresses today).
    committed = false;
    console.log('=== Nothing to publish (data.json unchanged) ===');
  }

  if (committed) {
    try {
      await git(['push']);
      console.log('=== Published: pushed to main (exports/ excluded) ===');
    } catch (err) {
      // Most likely a non-fast-forward rejection because main was advanced elsewhere.
      // Reconciling means merging, which can conflict — not safe to do unattended, so
      // stop loudly and leave the commit sitting locally for a human to resolve.
      console.error(`PUSH FAILED: ${err.message}`);
      console.error('The commit is safe locally but GitHub Pages is now serving stale data.');
      console.error('Resolve with: git pull --no-rebase && git push');
      process.exit(1);
    }
  }
  console.log('\n=== DAILY: done ===');
}
