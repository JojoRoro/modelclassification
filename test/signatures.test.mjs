import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import {
  classify, mergeSignatures, signatureFromObservations, signatureFromTokenizer,
  clusterByTokenizer, sameTokenizer,
} from '../public/js/classify.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url)));
const ref = read('../public/data/reference.json');
const bundled = read('../public/data/signatures.json').signatures;
const real = read('./fixtures/observed-2026-11.json').models;
const obsOf = (id) => real.find((m) => m.model === id).observations;

test('real data, built-in references only: why the lab models were not detected', () => {
  // GLM / Aion / Muse have tokenizers that are not in the reference set -> unknown (correct).
  for (const id of ['z-ai/glm-5.3-flashx-legal', 'aion-labs/aion-3.5', 'meta/muse-spark-open'])
    assert.equal(classify(obsOf(id), ref).verdict, 'unknown', id);
  // MiMo is ~2% away from Qwen: now reported as a variant instead of unknown.
  const mimo = classify(obsOf('xiaomi/mimo-v2.6-flash'), ref);
  assert.equal(mimo.verdict, 'variant');
  assert.equal(mimo.best.family, 'qwen');
});

test('real data: GLM-5.3 and Aion-3.5 cluster together as one new tokenizer type', () => {
  const groups = clusterByTokenizer(real.map((m) => ({ id: m.model, obs: m.observations })));
  const glm = groups.find((g) => g.some((x) => x.id.startsWith('z-ai/')));
  assert.deepEqual(glm.map((x) => x.id).sort(), ['aion-labs/aion-3.5', 'z-ai/glm-5.3-flashx-legal']);
  assert.equal(groups.length, 3);
  assert.equal(sameTokenizer(obsOf('xiaomi/mimo-v2.6-flash'), obsOf('z-ai/glm-5.3-flashx-legal')).same, false);
});

test('real data with bundled signatures: Aion-3.5 is identified as GLM', () => {
  const eff = mergeSignatures(ref, bundled);
  const aion = classify(obsOf('aion-labs/aion-3.5'), eff);
  assert.equal(aion.best.family, 'glm');
  assert.equal(aion.verdict, 'match');
  for (const [id, fam] of [['z-ai/glm-5.3-flashx-legal', 'glm'], ['xiaomi/mimo-v2.6-flash', 'mimo'], ['meta/muse-spark-open', 'meta-muse']])
    assert.equal(classify(obsOf(id), eff).best.family, fam, id);
});

test('signatures do not capture models of the built-in families', () => {
  const eff = mergeSignatures(ref, bundled);
  const ids = new Set(ref.defaultProbeIds);
  for (const r of ref.references) {
    const obs = Object.fromEntries(ref.probes.filter((p) => ids.has(p.id)).map((p) => [p.id, p.counts[r.id] + 17]));
    const res = classify(obs, eff);
    assert.equal(res.best.family, r.family, r.id);
    assert.ok(['match', 'likely'].includes(res.verdict), `${r.id}: ${res.verdict}`);
  }
});

test('an observed signature recovers its family at a different overhead, with partial probe overlap', () => {
  const ids = ref.defaultProbeIds;
  const truth = ref.references.find((r) => r.id === 'mistral_nemo');
  const obsA = Object.fromEntries(ids.map((pid) => [pid, ref.probes.find((p) => p.id === pid).counts[truth.id] + 40]));
  const sig = signatureFromObservations(obsA, { family: 'secret-lab' });
  const reduced = { ...ref, references: ref.references.filter((r) => r.family !== 'mistral-tekken') };
  const eff = mergeSignatures(reduced, [sig]);
  // Another endpoint with the same tokenizer, different template, only 5 of the probes answered.
  const obsB = Object.fromEntries(ids.slice(0, 5).map((pid) => [pid, ref.probes.find((p) => p.id === pid).counts[truth.id] + 3]));
  const res = classify(obsB, eff);
  assert.equal(res.best.family, 'secret-lab');
  assert.notEqual(res.verdict, 'unknown');
});

test('vendored browser tokenizer library matches the build-time reference counts', (t) => {
  const require = createRequire(import.meta.url);
  let tokJSON;
  try { tokJSON = require('@lenml/tokenizer-qwen2_5/models/tokenizer.json'); } catch { t.skip('reference tokenizers not installed'); return; }
  const ctx = { console: { ...console, warn() {}, log() {} }, TextEncoder, TextDecoder };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../public/vendor/lenml-tokenizers-3.7.2.global.js', import.meta.url), 'utf8') + ';globalThis.Tokenizers=Tokenizers;', ctx);
  const tok = ctx.Tokenizers.TokenizerLoader.fromPreTrained({ tokenizerJSON: tokJSON, tokenizerConfig: {} });
  const sig = signatureFromTokenizer((s) => tok.encode(s, { add_special_tokens: false }).length, ref.probes, { family: 'qwen-check' });
  for (const p of ref.probes) assert.equal(sig.counts[p.id], p.counts.qwen2_5, p.id);
});
