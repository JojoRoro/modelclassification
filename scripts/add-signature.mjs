// Adds an "observed" signature to public/data/signatures.json from a results
// export of the web app (fingerprints.json, the JSON button in Results).
//
//   node scripts/add-signature.mjs <fingerprints.json> <model-id> --family glm [--label "GLM-5 (Zhipu)"] [--note "..."]
//
// For open-weights models prefer an exact signature: put the tokenizer.json in
// ./tokenizers/<family>.json and run `npm run refs` (or use "Add" in the web UI).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signatureFromObservations } from '../public/js/classify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'signatures.json');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const family = opt('family'), label = opt('label'), note = opt('note');
const [file, model] = args;
if (!file || !model || !family) {
  console.error('usage: node scripts/add-signature.mjs <fingerprints.json> <model-id> --family <name> [--label <text>] [--note <text>]');
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(rows) ? rows : rows.models;
const row = list.find((r) => r.model === model);
if (!row) { console.error(`model ${model} not in ${file}`); process.exit(1); }

const slug = (x) => String(x).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
const sig = signatureFromObservations(row.observations, {
  id: `sig:${slug(family)}:${slug(model)}`, family: slug(family), label: label || `${family} (observed from ${model})`, model, note,
});
const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { signatures: [] };
data.signatures = data.signatures.filter((s) => s.id !== sig.id).concat(sig);
data.note = 'Bundled signatures. source "observed" = prompt-token counts measured via the API, normalised by the anchor probe (overhead = anchor - 1).';
fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
console.error(`${sig.id}: ${Object.keys(sig.counts).length} probes → ${path.relative(ROOT, OUT)}`);
