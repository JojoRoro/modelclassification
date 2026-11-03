// Loads reference tokenizers used to fingerprint unknown models.
//
// Sources (all optional; whatever is installed gets used):
//   1. @lenml/tokenizer-* npm packages (bundle the HF tokenizer.json of a model family)
//   2. js-tiktoken (OpenAI cl100k_base / o200k_base)
//   3. Any HuggingFace `tokenizer.json` you drop into ./tokenizers/<name>.json
//      (optionally with ./tokenizers/<name>.config.json). Use this to add a family
//      that has no npm package yet, e.g. a freshly released open-weights model.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// id -> { pkg, label, family }
// `family` is the coarse class reported to the user; several references may share one.
export const LENML_REFS = [
  { id: 'llama2', pkg: '@lenml/tokenizer-llama2', label: 'Llama 2 / Mistral-v1 (SentencePiece 32k)', family: 'llama2' },
  { id: 'llama3', pkg: '@lenml/tokenizer-llama3', label: 'Llama 3.x (tiktoken-style 128k)', family: 'llama3' },
  { id: 'gemma', pkg: '@lenml/tokenizer-gemma', label: 'Gemma 1/2 (SentencePiece 256k)', family: 'gemma' },
  { id: 'gemma3', pkg: '@lenml/tokenizer-gemma3', label: 'Gemma 3 (262k)', family: 'gemma' },
  { id: 'gemini', pkg: '@lenml/tokenizer-gemini', label: 'Gemini (256k)', family: 'gemma' },
  { id: 'qwen2_5', pkg: '@lenml/tokenizer-qwen2_5', label: 'Qwen 2.5 (151k)', family: 'qwen' },
  { id: 'qwen3', pkg: '@lenml/tokenizer-qwen3', label: 'Qwen 3 (151k)', family: 'qwen' },
  { id: 'deepseek_v3', pkg: '@lenml/tokenizer-deepseek_v3', label: 'DeepSeek V3/R1 (128k)', family: 'deepseek' },
  { id: 'deepseek_v4', pkg: '@lenml/tokenizer-deepseek_v4', label: 'DeepSeek V4 (129k)', family: 'deepseek' },
  { id: 'mistral_nemo', pkg: '@lenml/tokenizer-mistral_nemo', label: 'Mistral Tekken (Nemo / Small 3 / Large 2)', family: 'mistral-tekken' },
  { id: 'claude', pkg: '@lenml/tokenizer-claude', label: 'Claude (legacy 65k, pre-Claude-3)', family: 'claude-legacy' },
  { id: 'gptoss', pkg: '@lenml/tokenizer-gptoss', label: 'gpt-oss / o200k_harmony', family: 'openai-o200k' },
  { id: 'chatglm3', pkg: '@lenml/tokenizer-chatglm3', label: 'ChatGLM3 (64k)', family: 'glm-legacy' },
];

export const TIKTOKEN_REFS = [
  { id: 'cl100k', enc: 'cl100k_base', label: 'OpenAI cl100k (GPT-4 / 3.5)', family: 'openai-cl100k' },
  { id: 'o200k', enc: 'o200k_base', label: 'OpenAI o200k (GPT-4o / 4.1 / 5 / o-series)', family: 'openai-o200k' },
];

function silence(fn) {
  // @lenml warns about unknown tokenizer classes on stdout; keep the console clean.
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
}

/** Returns [{id,label,family,count(text)=>number}] for every tokenizer that loads. */
export function loadReferenceTokenizers({ verbose = false } = {}) {
  const out = [];
  const log = (...a) => verbose && console.error(...a);

  try {
    const { getEncoding } = require('js-tiktoken');
    for (const r of TIKTOKEN_REFS) {
      const enc = getEncoding(r.enc);
      out.push({ ...r, source: 'js-tiktoken', count: (t) => enc.encode(t, [], []).length });
    }
  } catch (e) { log('js-tiktoken unavailable:', e.message); }

  for (const r of LENML_REFS) {
    try {
      const tok = silence(() => require(r.pkg).fromPreTrained());
      out.push({ ...r, source: r.pkg, count: (t) => tok.encode(t, { add_special_tokens: false }).length });
    } catch (e) { log(`${r.pkg} unavailable:`, e.message.split('\n')[0]); }
  }

  // User-supplied tokenizer.json files.
  const dir = path.join(ROOT, 'tokenizers');
  if (fs.existsSync(dir)) {
    let loader;
    try { loader = require('@lenml/tokenizers').TokenizerLoader; } catch { loader = null; }
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.endsWith('.config.json')) continue;
      if (!loader) { log('install @lenml/tokenizers to load', f); break; }
      const id = 'custom:' + f.replace(/\.json$/, '');
      try {
        const tokenizerJSON = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const cfgPath = path.join(dir, f.replace(/\.json$/, '.config.json'));
        const tokenizerConfig = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
        const tok = silence(() => loader.fromPreTrained({ tokenizerJSON, tokenizerConfig }));
        const name = f.replace(/\.json$/, '');
        out.push({ id, label: `${name} (custom tokenizer.json)`, family: name, source: f,
          count: (t) => tok.encode(t, { add_special_tokens: false }).length });
      } catch (e) { log(`failed to load ${f}:`, e.message.split('\n')[0]); }
    }
  }
  return out;
}
