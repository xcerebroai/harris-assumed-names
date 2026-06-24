import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
const url = pathToFileURL(path.resolve('recon-out/doc-243834192.pdf')).href;
await p.goto(url, { waitUntil: 'load' }).catch((e) => console.log('nav', e.message));
await p.waitForTimeout(4000);
await p.screenshot({ path: 'recon-out/pdfium-render.png', fullPage: false });
console.log('done', url);
await b.close();
