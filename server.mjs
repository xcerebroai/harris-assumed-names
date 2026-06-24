// Local static preview of the GitHub Pages site (docs/). Optional — Pages serves docs/
// directly. Useful locally because browsers block fetch() of ./data.json over file://.
// Read-only static file serving; no DB access, no API.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const app = express();
app.use(express.static(path.join(__dirname, 'docs')));
app.listen(PORT, () => {
  console.log(`\n  Static preview of /docs  →  http://localhost:${PORT}\n`);
  console.log(`  (GitHub Pages serves the same /docs folder.)\n`);
});
