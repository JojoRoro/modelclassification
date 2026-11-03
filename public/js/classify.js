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
 * @param {{references: {id:string,label:string,family:string}[], probes: {id:string, counts: Record<string,number>}[]}} ref
 */
export function scoreReferences(obs, ref) {
  const probes = ref.probes.filter((p) => Number.isFinite(obs[p.id]));
  if (!probes.length) return [];
  const rows = ref.references.map((r) => {
    const diffs = probes.map((p) => obs[p.id] - p.counts[r.id]);
    const offset = median(diffs);
    const resid = diffs.map((d) => d - offset);
    const absErr = resid.reduce((a, e) => a + Math.abs(e), 0);
    const refTotal = probes.reduce((a, p) => a + p.counts[r.id], 0);
    const exact = resid.filter((e) => e === 0).length;
    const within1 = resid.filter((e) => Math.abs(e) <= 1).length;
    // A negative overhead is physically implausible (fewer tokens than the raw text).
    const penalty = offset < 0 ? Math.abs(offset) * probes.length : 0;
    return {
      id: r.id, label: r.label, family: r.family,
      offset, resid, absErr, score: absErr + penalty,
      relErr: refTotal ? absErr / refTotal : 1,
      exact, within1, n: probes.length,
    };
  });
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
 *  - 'unknown'  : nothing in the reference set fits -> likely a NEW tokenizer
 *  - 'insufficient' : too few probes answered
 */
export function classify(obs, ref) {
  const rows = scoreReferences(obs, ref);
  const fam = familyRanking(rows);
  const n = rows[0]?.n ?? 0;
  if (n < 3) return { verdict: 'insufficient', n, rows, families: fam };
  const [a, b] = fam;
  const fitsWell = a.within1 >= Math.ceil(n * 0.8) && a.relErr <= 0.03 && a.offset >= 0;
  const margin = b ? (b.score - a.score) / Math.max(1, a.score) : Infinity;
  let verdict;
  if (!fitsWell) verdict = 'unknown';
  else if (!b || (b.score >= a.score + 3 && margin >= 1)) verdict = 'match';
  else verdict = 'likely';
  // Rough confidence in [0,1] from the score gap (Laplace-like likelihood, temperature 2 tokens).
  const z = fam.map((f) => Math.exp(-(f.score - a.score) / 2));
  const conf = z[0] / z.reduce((s, v) => s + v, 0);
  return { verdict, n, best: a, runnerUp: b ?? null, confidence: verdict === 'unknown' ? 0 : conf, rows, families: fam };
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
