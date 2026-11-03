// Builds public/data/reference.json: token counts of every probe under every
// reference tokenizer, plus a greedily chosen default probe set that maximises
// separation between tokenizer families (after the per-endpoint offset is fitted).
//
//   npm install            # installs the reference tokenizers (optionalDependencies)
//   npm run refs           # regenerates the JSON
//   node scripts/build-refs.mjs --probes 10
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReferenceTokenizers } from '../lib/tokenizers.mjs';
import { PROBE_POOL } from '../lib/probe-pool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argN = process.argv.indexOf('--probes');
const N_DEFAULT = argN > 0 ? Number(process.argv[argN + 1]) : 8;

const toks = loadReferenceTokenizers({ verbose: true });
if (!toks.length) { console.error('No tokenizers installed. Run `npm install` first.'); process.exit(1); }

// counts[refId][probeId]
const counts = {};
for (const t of toks) {
  counts[t.id] = {};
  for (const p of PROBE_POOL) counts[t.id][p.id] = t.count(p.text);
}

// Merge references that are indistinguishable on the whole pool.
const sig = (id) => PROBE_POOL.map((p) => counts[id][p.id]).join(',');
const groups = new Map();
for (const t of toks) {
  const k = sig(t.id);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(t);
}
const references = [...groups.values()].map((g) => ({
  id: g[0].id,
  label: g.map((t) => t.label).join(' ≡ '),
  family: g[0].family,
  members: g.map((t) => t.id),
}));
for (const r of references) if (r.members.length > 1) console.error(`identical on pool: ${r.members.join(', ')}`);

// Separation of two references on a probe subset, after fitting a constant offset.
function separation(a, b, probeIds) {
  const d = probeIds.map((p) => counts[a][p] - counts[b][p]).sort((x, y) => x - y);
  const m = d[d.length >> 1];
  return d.reduce((s, x) => s + Math.abs(x - m), 0);
}

// Only pairs from *different* families need to be separated.
const pairs = [];
for (let i = 0; i < references.length; i++)
  for (let j = i + 1; j < references.length; j++)
    if (references[i].family !== references[j].family) pairs.push([references[i].id, references[j].id]);

// Greedy: always keep the anchor, then add the probe that most improves the
// worst-separated pair (capped utility so one huge gap doesn't dominate).
const CAP = 12;
const chosen = ['anchor'];
const utility = (set) => {
  const seps = pairs.map(([a, b]) => Math.min(CAP, separation(a, b, set)));
  return { min: Math.min(...seps), sum: seps.reduce((s, x) => s + x, 0) };
};
while (chosen.length < N_DEFAULT) {
  let best = null;
  for (const p of PROBE_POOL) {
    if (chosen.includes(p.id)) continue;
    const u = utility([...chosen, p.id]);
    if (!best || u.min > best.u.min || (u.min === best.u.min && u.sum > best.u.sum)) best = { id: p.id, u };
  }
  chosen.push(best.id);
}

const final = utility(chosen);
console.error(`default probes (${chosen.length}): ${chosen.join(', ')}`);
console.error(`min pairwise separation (tokens, capped ${CAP}): ${final.min}`);
const worst = pairs.map(([a, b]) => [a, b, separation(a, b, chosen)]).sort((x, y) => x[2] - y[2]).slice(0, 5);
console.error('closest family pairs:', worst.map(([a, b, s]) => `${a}~${b}:${s}`).join('  '));

const out = {
  generated: new Date().toISOString(),
  note: 'counts = tokens(probe text) without special tokens; observed prompt_tokens = overhead + counts',
  references,
  defaultProbeIds: chosen,
  probes: PROBE_POOL.map((p) => ({
    ...p,
    counts: Object.fromEntries(references.map((r) => [r.id, counts[r.id][p.id]])),
  })),
};
const file = path.join(ROOT, 'public', 'data', 'reference.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.error(`wrote ${path.relative(ROOT, file)} (${references.length} reference classes, ${PROBE_POOL.length} probes)`);
