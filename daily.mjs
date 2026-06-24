// Daily orchestrator: one invocation does the full day's work.
//   (a) Stage 1  : scrape NEW result rows since the last successful run (scraper --daily)
//   (b)+(c)+(d)  : Stage 2 enrichment over EVERY row with image_status not in
//                  ('extracted','dead') — this single query covers new rows, prior-day
//                  'pending' rows (re-verify), and ages 'pending' past the retry cap to 'dead'.
//
// Usage: node daily.mjs [--limit N] [--today MM/DD/YYYY]
//   --limit caps the enrichment batch per run (politeness / time-boxing the backfill).
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const passthrough = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? [flag, argv[i + 1]] : []; };
const today = passthrough('--today');
const limit = passthrough('--limit');

function run(script, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}

console.log('=== DAILY: Stage 1 (scrape new rows) ===');
await run('./scraper.mjs', ['--daily', ...today]);
console.log('\n=== DAILY: Stage 2 (OCR enrich + re-verify + age-out) ===');
await run('./enrich.mjs', [...today, ...limit]);
console.log('\n=== DAILY: done ===');
