// Daily orchestrator: one invocation does the full day's work.
//   (a) Stage 1  : scrape NEW result rows since the last successful run (scraper --daily)
//   (b) Stage 2  : ONE conservative enrichment batch (default --limit 150). The county
//                  server throttles after ~150-200 docs/session, so we deliberately cap
//                  each daily run instead of grinding the full backlog. enrich.mjs's query
//                  (image_status NOT IN ('extracted','dead') AND last_checked != today)
//                  skips already-extracted rows and re-verifies prior pending rows; only a
//                  genuine "IMAGE NOT FOUND" burns a retry strike — timeouts are transient.
//   (c) Publish  : rebuild docs/data.json, then commit + push so the GitHub Pages dashboard
//                  (and any export consuming data.json) refreshes automatically.
//
// Designed to run unattended in the early-morning low-traffic window (see the Windows
// Scheduled Task "HarrisAssumedNames-Daily").
//
// Usage: node daily.mjs [--limit N] [--today MM/DD/YYYY] [--no-publish]
//   --limit defaults to 150 (the safe per-session batch). Pass --limit 0 for uncapped.
import { spawn } from 'node:child_process';

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

if (!doPublish) {
  console.log('\n=== Publish skipped (--no-publish) ===\n=== DAILY: done ===');
} else {
  console.log('\n=== Publish: rebuild data.json + commit + push ===');
  await node('./build-data.mjs', []);

  // Commit only if data.json actually changed; never fail the run on a no-op commit.
  const git = (args) => run('git', args);
  await git(['add', 'docs/data.json']);
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    await git(['commit', '-m', `daily refresh ${stamp}: rebuild dashboard data`]);
    await git(['push']);
    console.log('=== Published: pushed to main ===');
  } catch {
    // `git commit` exits non-zero when there's nothing staged (no new addresses today).
    console.log('=== Nothing to publish (data.json unchanged) ===');
  }
  console.log('\n=== DAILY: done ===');
}
