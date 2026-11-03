// Tokenizer-fingerprint classifier. Pure functions; runs in the browser and in Node tests.
//
// Model of an observation:
//     prompt_tokens(probe) = overhead + tokens_ref(probe) + noise
// `overhead` is the (unknown) chat-template / system-prompt cost and is constant
// for a given endpoint, so we estimate it per reference as the median of
// (observed - reference) and score the residuals. The true tokenizer gives
// residuals of ~0 on every probe; a wrong one leaves large, probe-dependent residuals.

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * @param {Record<string, number>} obs probeId -> observed prompt_tokens
 * @param {{references: {id:string,label:string,family:string,source?:string}[], probes: {id:string, counts: Record<string,number>}[]}} ref
 *
 * References come in two kinds:
 *  - tokenizer references: counts are exact token counts of the probe text
 *  - observed signatures (source 'observed'): counts measured through an API,
 *    normalised by subtracting their own estimated overhead. Their absolute level
 *    is only approximate, so a slightly negative offset is allowed for them.
 * A reference may lack counts for some probes; it is then scored on the probes it
 * shares with the observation (and skipped if fewer than 3 are shared).
 */
export function scoreReferences(obs, ref) {
  const answered = ref.probes.filter((p) => Number.isFinite(obs[p.id]));
  if (!answered.length) return [];
  const rows = [];
  for (const r of ref.references) {
    const probes = answered.filter((p) => Number.isFinite(p.counts[r.id]));
    if (probes.length < Math.min(3, answered.length)) continue;
    const diffs = probes.map((p) => obs[p.id] - p.counts[r.id]);
    const offset = median(diffs);
    const residList = diffs.map((d) => d - offset);
    const resid = Object.fromEntries(probes.map((p, i) => [p.id, residList[i]]));
    const absErr = residList.reduce((a, e) => a + Math.abs(e), 0);
    const refTotal = probes.reduce((a, p) => a + p.counts[r.id], 0);
    const exact = residList.filter((e) => e === 0).length;
    const within1 = residList.filter((e) => Math.abs(e) <= 1).length;
    const observed = r.source === 'observed';
    // A negative overhead is physically implausible for exact tokenizer references.
    const penalty = !observed && offset < 0 ? Math.abs(offset) * probes.length : observed && offset < -4 ? Math.abs(offset) : 0;
    // Scale to the number of answered probes so references with fewer shared probes aren't favoured.
    const score = ((absErr + penalty) * answered.length) / probes.length;
    rows.push({
      id: r.id, label: r.label, family: r.family, source: r.source || 'tokenizer',
      offset, resid, absErr, score, relErr: refTotal ? absErr / refTotal : 1,
      exact, within1, n: probes.length,
    });
  }
  rows.sort((a, b) => a.score - b.score || a.relErr - b.relErr);
  return rows;
}

/** Best reference per family, sorted. */
export function familyRanking(rows) {
  const best = new Map();
  for (const r of rows) if (!best.has(r.family) || best.get(r.family).score > r.score) best.set(r.family, r);
  return [...best.values()].sort((a, b) => a.score - b.score || a.relErr - b.relErr);
}

/**
 * Turns scores into a verdict.
 *  - 'match'    : best family fits (almost) every probe and clearly beats the runner-up
 *  - 'likely'   : best fits well but runner-up is close
 *  - 'variant'  : close to one family (≤ 5% error) but not exact, e.g. an extended or
 *                 retrained vocabulary derived from it
 *  - 'unknown'  : nothing in the reference set fits -> likely a NEW tokenizer
 *  - 'insufficient' : too few probes answered
 */
export function classify(obs, ref) {
  const rows = scoreReferences(obs, ref);
  const fam = familyRanking(rows);
  const n = rows[0]?.n ?? 0;
  if (n < 3) return { verdict: 'insufficient', n, rows, families: fam };
  const [a, b] = fam;
  const okOffset = a.offset >= 0 || a.source === 'observed';
  const fitsWell = a.within1 >= Math.ceil(n * 0.8) && a.relErr <= 0.03 && okOffset;
  const near = a.relErr <= 0.05 && a.within1 >= Math.ceil(n * 0.5) && okOffset;
  const margin = b ? (b.score - a.score) / Math.max(1, a.score) : Infinity;
  let verdict;
  if (fitsWell) verdict = !b || (b.score >= a.score + 3 && margin >= 1) ? 'match' : 'likely';
  else verdict = near ? 'variant' : 'unknown';
  // Rough confidence in [0,1] from the score gap (Laplace-like likelihood, temperature 2 tokens).
  const z = fam.map((f) => Math.exp(-(f.score - a.score) / 2));
  const conf = z[0] / z.reduce((s, v) => s + v, 0);
  return { verdict, n, best: a, runnerUp: b ?? null, confidence: verdict === 'unknown' ? 0 : conf, rows, families: fam };
}

// ---------- Signatures: new reference classes created at runtime ----------

/**
 * Normalise an observation vector into a signature: subtract the endpoint's own
 * overhead, estimated from the 1-token anchor probe (or the smallest count).
 */
export function signatureFromObservations(obs, { id, label, family, model, note } = {}) {
  const vals = Object.values(obs).filter(Number.isFinite);
  if (vals.length < 3) throw new Error('need at least 3 probe observations to create a signature');
  const overhead = Number.isFinite(obs.anchor) ? obs.anchor - 1 : Math.min(...vals) - 1;
  const counts = Object.fromEntries(Object.entries(obs).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.max(0, v - overhead)]));
  return {
    id: id || 'sig:' + (family || model || 'unnamed').toLowerCase().replace(/[^a-z0-9.]+/g, '-'),
    label: label || family || model, family: family || label || model,
    source: 'observed', model: model || null, note: note || null,
    created: new Date().toISOString().slice(0, 10), counts,
  };
}

/** Exact signature from a tokenizer: counts for every probe in the pool. */
export function signatureFromTokenizer(countFn, probes, { id, label, family, note } = {}) {
  return {
    id: id || 'tok:' + (family || label).toLowerCase().replace(/[^a-z0-9.]+/g, '-'),
    label: label || family, family: family || label, source: 'tokenizer', note: note || null,
    created: new Date().toISOString().slice(0, 10),
    counts: Object.fromEntries(probes.map((p) => [p.id, countFn(p.text)])),
  };
}

/** Returns a copy of the reference data with signatures added as extra references. */
export function mergeSignatures(ref, signatures = []) {
  const seen = new Set(ref.references.map((r) => r.id));
  const sigs = signatures.filter((s) => s && s.id && !seen.has(s.id) && (seen.add(s.id), true));
  return {
    ...ref,
    references: [...ref.references, ...sigs.map((s) => ({ id: s.id, label: s.label, family: s.family, source: s.source, members: [s.id], signature: true }))],
    probes: ref.probes.map((p) => ({
      ...p,
      counts: { ...p.counts, ...Object.fromEntries(sigs.filter((s) => Number.isFinite(s.counts?.[p.id])).map((s) => [s.id, s.counts[p.id]])) },
    })),
  };
}

/** Are two observation vectors from the same tokenizer (up to a constant overhead)? */
export function sameTokenizer(a, b) {
  const shared = Object.keys(a).filter((k) => Number.isFinite(a[k]) && Number.isFinite(b[k]));
  if (shared.length < 4) return { same: false, shared: shared.length };
  const d = shared.map((k) => a[k] - b[k]);
  const off = median(d);
  const r = d.map((x) => Math.abs(x - off));
  const within1 = r.filter((x) => x <= 1).length;
  const same = within1 >= Math.ceil(shared.length * 0.75) && r.every((x) => x <= 3);
  return { same, shared: shared.length, within1, absErr: r.reduce((s, x) => s + x, 0), offset: off };
}

/**
 * Groups models whose observations agree with each other but not with any reference.
 * Each group is a candidate NEW tokenizer type. Single-member groups are returned too.
 * @param {{id:string, obs:Record<string,number>}[]} items
 */
export function clusterByTokenizer(items) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (sameTokenizer(items[i].obs, items[j].obs).same) parent[find(i)] = find(j);
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// ---------- Ground-truth hints from OpenRouter metadata (for calibration) ----------

const TOKENIZER_FIELD = {
  gpt: 'openai-o200k', claude: 'claude-legacy', gemini: 'gemma', gemma: 'gemma',
  llama2: 'llama2', llama3: 'llama3', mistral: 'mistral-tekken', qwen: 'qwen', qwen3: 'qwen',
  deepseek: 'deepseek',
};

/** Best-effort expected family for a listed model (null if unknown/cloaked). */
export function expectedFamily(model) {
  const id = (model.id || '').toLowerCase();
  const rules = [
    [/^openai\/(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|gpt-oss|chatgpt-4o)/, 'openai-o200k'],
    [/^openai\/(gpt-4|gpt-3\.5)/, 'openai-cl100k'],
    [/llama-?3/, 'llama3'],
    [/llama-?2|mistral-7b-instruct-v0\.[12]|^mistralai\/mixtral-8x7b/, 'llama2'],
    [/gemma|^google\/gemini/, 'gemma'],
    [/qwen|qwq/, 'qwen'],
    [/deepseek/, 'deepseek'],
    [/^z-ai\/|^thudm\/|^zai-org\/|\bglm-?[4-9]/, 'glm'],
    [/^xiaomi\/|\bmimo\b/, 'mimo'],
    [/^meta\/muse|muse-spark/, 'meta-muse'],
    [/^moonshotai\/|\bkimi\b/, 'kimi'],
    [/^minimax\//, 'minimax'],
    [/mistral-nemo|mistral-small-3|mistral-small-24b|ministral|pixtral|devstral|mistral-medium|magistral|mistral-large-24/, 'mistral-tekken'],
  ];
  for (const [re, fam] of rules) if (re.test(id)) return fam;
  const t = (model.architecture?.tokenizer || '').toLowerCase();
  return TOKENIZER_FIELD[t] ?? null;
}

// ---------- Model metadata helpers ----------

/** True only if EVERY price on the model is zero. Used as the hard spending guard. */
export function isFree(model) {
  const p = model?.pricing;
  if (!p || typeof p !== 'object') return false;
  const vals = Object.values(p);
  if (!vals.length) return false;
  return vals.every((v) => v === null || v === undefined || Number(v) === 0);
}

/** Heuristic: is this listing probably a cloaked/stealth model? */
export function stealthSignals(model, nowSec = Date.now() / 1000) {
  const s = [];
  const id = (model.id || '').toLowerCase();
  const name = (model.name || '').toLowerCase();
  const desc = (model.description || '').toLowerCase();
  if (/^(openrouter|stealth)\//.test(id) && !/auto|free$|router/.test(id.split('/')[1] || '')) s.push('openrouter/stealth namespace');
  if (/\b(alpha|beta|cloaked|stealth|preview)\b/.test(name + ' ' + id)) s.push('alpha/beta/cloaked name');
  if (/stealth|cloaked|anonymous|undisclosed|unnamed (lab|provider)/.test(desc)) s.push('description says stealth');
  const tok = (model.architecture?.tokenizer || '').toLowerCase();
  if (!tok || tok === 'other' || tok === 'router') s.push(`tokenizer "${model.architecture?.tokenizer || 'none'}"`);
  if (model.created && nowSec - model.created < 30 * 86400) s.push('listed < 30 days ago');
  return s;
}
