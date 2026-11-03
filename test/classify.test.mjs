import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classify, isFree, expectedFamily, stealthSignals } from '../public/js/classify.js';

const ref = JSON.parse(fs.readFileSync(new URL('../public/data/reference.json', import.meta.url)));
const defaults = new Set(ref.defaultProbeIds);
const defRef = { ...ref, probes: ref.probes.filter((p) => defaults.has(p.id)) };

// Simulate an endpoint that uses reference `r` with a chat-template overhead and
// occasional ±1 boundary noise.
function simulate(r, overhead, noise = () => 0) {
  return Object.fromEntries(defRef.probes.map((p) => [p.id, p.counts[r.id] + overhead + noise(p)]));
}

test('every reference is recovered exactly with arbitrary template overhead', () => {
  for (const r of ref.references) {
    for (const overhead of [0, 7, 23, 140]) {
      const res = classify(simulate(r, overhead), defRef);
      assert.equal(res.best.family, r.family, `${r.id} @${overhead}`);
      assert.equal(res.best.offset, overhead);
      assert.equal(res.verdict, 'match', `${r.id} verdict ${res.verdict}`);
    }
  }
});

test('robust to ±1 boundary-merge noise on a couple of probes', () => {
  let i = 0;
  for (const r of ref.references) {
    const noisy = simulate(r, 12, (p) => (p.id === defRef.probes[1 + (i % 6)].id ? (i % 2 ? 1 : -1) : 0));
    i++;
    const res = classify(noisy, defRef);
    assert.equal(res.best.family, r.family, r.id);
    assert.notEqual(res.verdict, 'unknown', r.id);
  }
});

test('an unseen tokenizer is reported as unknown', () => {
  // Synthetic "new" tokenizer: ~0.6 tokens per char, unlike any reference.
  const obs = Object.fromEntries(defRef.probes.map((p) => [p.id, 9 + Math.round([...p.text].length * 0.6)]));
  const res = classify(obs, defRef);
  assert.equal(res.verdict, 'unknown');
});

test('leave-one-family-out: a held-out family is never confidently matched to another', () => {
  for (const held of new Set(ref.references.map((r) => r.family))) {
    const target = ref.references.find((r) => r.family === held);
    const reduced = { ...defRef, references: defRef.references.filter((r) => r.family !== held) };
    const res = classify(simulate(target, 10), reduced);
    assert.equal(res.verdict, 'unknown', `${held} -> ${res.best.family} (${res.verdict})`);
  }
});

test('insufficient with < 3 probes', () => {
  const r = ref.references[0];
  const obs = { [defRef.probes[0].id]: 5, [defRef.probes[1].id]: 9 };
  assert.equal(classify(obs, defRef).verdict, 'insufficient');
  void r;
});

test('isFree is strict', () => {
  assert.equal(isFree({ pricing: { prompt: '0', completion: '0', request: '0', image: '0' } }), true);
  assert.equal(isFree({ pricing: { prompt: '0', completion: '0.000001' } }), false);
  assert.equal(isFree({ pricing: { prompt: '-1', completion: '-1' } }), false); // openrouter/auto
  assert.equal(isFree({ pricing: {} }), false);
  assert.equal(isFree({}), false);
});

test('metadata helpers', () => {
  assert.equal(expectedFamily({ id: 'meta-llama/llama-3.3-70b-instruct:free' }), 'llama3');
  assert.equal(expectedFamily({ id: 'qwen/qwen3-coder:free' }), 'qwen');
  assert.equal(expectedFamily({ id: 'openai/gpt-oss-20b:free' }), 'openai-o200k');
  assert.equal(expectedFamily({ id: 'openrouter/some-alpha', architecture: { tokenizer: 'Other' } }), null);
  assert.ok(stealthSignals({ id: 'openrouter/sonoma-sky-alpha', name: 'Sonoma Sky Alpha', architecture: { tokenizer: 'Other' } }).length >= 2);
});
