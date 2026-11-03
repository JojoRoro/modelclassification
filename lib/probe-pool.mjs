// Candidate probe strings. Each probe is sent as the *entire* user message, so
// the model's reported prompt_tokens = template_overhead + tokens(probe).
// The build script picks the subset that best separates tokenizer families.
//
// Design goals for a good probe:
//  - large spread in token count across tokenizers (digits, whitespace, CJK,
//    emoji, rare scripts, long words split very differently by BPE vs SPM)
//  - stable: no leading/trailing whitespace (avoids merges with template tokens)
//  - harmless & short enough that free endpoints accept it.

const rep = (s, n) => Array.from({ length: n }, () => s).join('');

export const PROBE_POOL = [
  { id: 'anchor', text: 'Hi', why: 'Short anchor; pins the chat-template overhead.' },
  { id: 'digits60', text: '314159265358979323846264338327950288419716939937510582097494', why: 'Digit chunking: 1/token (Llama2, Gemma, Qwen, DeepSeek) vs 3/token (Llama3, GPT-4/4o).' },
  { id: 'digits_sep', text: '12,345.678 + 9,876,543.21 = 9,888,888.888', why: 'Numbers with separators.' },
  { id: 'spaces', text: 'a' + rep(' ', 40) + 'b', why: 'Run of spaces: merged into large whitespace tokens by some BPEs.' },
  { id: 'indent_code', text: 'def f(x):\n' + rep('        if x:\n', 4) + '            return x', why: 'Code indentation whitespace.' },
  { id: 'newlines', text: 'x' + rep('\n', 12) + 'y', why: 'Newline runs.' },
  { id: 'tabs', text: 'k' + rep('\t', 16) + 'v', why: 'Tab runs.' },
  { id: 'cjk_zh', text: '人工智能模型的分词器决定了文本如何被切分成词元，这是识别模型来源的重要线索。', why: 'Chinese: tiny for Qwen/DeepSeek/GLM, large for Llama2/cl100k.' },
  { id: 'cjk_ja', text: '東京特許許可局の新しい言語モデルはトークン化の仕組みが独特です。', why: 'Japanese kana+kanji.' },
  { id: 'korean', text: '대규모 언어 모델의 토크나이저는 서로 다른 방식으로 텍스트를 분할합니다.', why: 'Hangul.' },
  { id: 'russian', text: 'Токенизатор определяет, как текст разбивается на части для нейросети.', why: 'Cyrillic.' },
  { id: 'hindi', text: 'भाषा मॉडल का टोकनाइज़र पाठ को अलग-अलग तरीके से विभाजित करता है।', why: 'Devanagari: very different across vocab sizes.' },
  { id: 'arabic', text: 'يقوم المحلل اللغوي بتقسيم النص إلى رموز بطرق مختلفة.', why: 'Arabic script.' },
  { id: 'thai', text: 'โมเดลภาษาขนาดใหญ่แบ่งข้อความออกเป็นโทเค็นด้วยวิธีที่แตกต่างกัน', why: 'Thai (no spaces).' },
  { id: 'emoji', text: '🤖🧠🔥🚀🦄🧬🪐🫠🥹🧑‍💻👩‍👩‍👧‍👦🏳️‍🌈', why: 'Emoji incl. ZWJ sequences: byte-fallback differences.' },
  { id: 'math', text: '∀ε>0 ∃δ>0: |x−a|<δ ⇒ |f(x)−f(a)|<ε ∮∇×𝐁·d𝐀 ≈ ℏω', why: 'Unicode math symbols.' },
  { id: 'rareword', text: 'Pneumonoultramicroscopicsilicovolcanoconiosis antidisestablishmentarianism floccinaucinihilipilification', why: 'Very long rare words.' },
  { id: 'camel', text: 'getUserAccountSettingsFromRemoteConfigurationProviderAsync', why: 'CamelCase identifier.' },
  { id: 'base64', text: 'U3RlYWx0aE1vZGVsVG9rZW5pemVyRmluZ2VycHJpbnQ9PUhlbGxvV29ybGQxMjM0NQ==', why: 'Base64: near-random characters.' },
  { id: 'hex', text: '0x7f3a9c2be1d04f68a5c3b2e1f0d9c8b7a6e5f4d3c2b1a09f8e7d6c5b4a39281', why: 'Hex string.' },
  { id: 'url', text: 'https://example.com/api/v2/users?id=8472&sort=desc&filter=active#section-3', why: 'URL punctuation.' },
  { id: 'punct', text: '!!!???...;;;:::---___===+++***&&&|||~~~```', why: 'Repeated punctuation merges.' },
  { id: 'repeat_a', text: rep('a', 64), why: 'Single-char run: longest merge in vocab.' },
  { id: 'xml', text: '<div class="row"><span id="x">&nbsp;&lt;tag&gt;</span></div>', why: 'Markup/entities.' },
  { id: 'english', text: 'The quick brown fox jumps over the lazy dog while the cat watches silently.', why: 'Plain English (low spread, good control).' },
  { id: 'german', text: 'Donaudampfschifffahrtsgesellschaftskapitänswitwe trinkt Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz.', why: 'German compounds.' },
  { id: 'accents', text: 'Ünïcödé façade naïve coöperate résumé jalapeño Ångström Øresund', why: 'Latin diacritics.' },
  { id: 'mixed', text: 'Model名: GPT/Llama/Qwen 混合 text — 2026年 🚀 v3.1.4', why: 'Mixed scripts.' },
  { id: 'json', text: '{"model":"x","temperature":0.7,"messages":[{"role":"user","content":"hi"}]}', why: 'JSON.' },
  { id: 'year_list', text: '1999 2000 2001 2024 2025 2026 1066 1492 1776 1914', why: 'Year-like numbers.' },
];
