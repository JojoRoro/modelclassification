# Classifying stealth LLMs by tokenization

## Problem

Aggregators like OpenRouter regularly list **cloaked / stealth models** (e.g. `openrouter/*-alpha`, `stealth/*`) with no vendor named. Many are free during the stealth period. The question: **who built it?** Text style and self-reports are unreliable, because models are told to hide their identity and are trained on each other's outputs. The **tokenizer** is much harder to disguise. A lab almost always ships a new model with its own tokenizer, or with the tokenizer of its previous generation. And the API leaks the tokenizer through the billed token counts.

## Signals the API leaks

| Signal | How to read it | Cost | Strength |
|---|---|---|---|
| **Prompt-token counts** (`usage.prompt_tokens`) | Send probe string *p*, read prompt_tokens = overhead + tokens(p) | 1 tiny request / probe (`max_tokens: 1`) | **Strong.** Exact integers, deterministic, no sampling noise |
| Native counts from `/api/v1/generation?id=` (`native_tokens_prompt`) | Same, from OpenRouter's generation stats | +1 free lookup | Use as a cross-check if `usage` is ever normalised |
| Template overhead (fitted constant) | The residual constant after fitting | free (by-product) | Weak-to-medium. Reflects chat template + injected system prompt |
| Completion-token counts vs returned text | completion_tokens vs tokens(output) under each ref | 1 request with longer output | Medium. Confounded by hidden reasoning tokens |
| Truncation boundaries | `max_tokens = k` while asking the model to echo a string; the cut point shows token boundaries | several requests | Strong but expensive; breaks on reasoning models |
| Single-token answer distributions | Ask trivial questions, collect the first token | many requests | Fingerprints the *model*, not only the tokenizer ("One Token Is Enough", 2026) |
| Metadata (`architecture.tokenizer`, context length, created date, provider) | `/api/v1/models` | free | Hints only. Stealth listings usually say `Other` |

This app implements the first three, because they are cheap enough for the free tier. OpenRouter's free models are limited to about 20 req/min and about 50 req/day on keys with less than $10 of credit purchased.

## Method implemented

1. **Probe pool** (`lib/probe-pool.mjs`): 30 strings chosen to stress the places where tokenizers differ most:
   - digit chunking: 1 digit/token for SentencePiece, Gemma, Qwen and DeepSeek; 3 digits/token for Llama 3 and GPT-4/4o
   - whitespace runs and code indentation
   - CJK, Hangul, Devanagari, Thai, Arabic, Cyrillic: vocab size and training-data mix show up most here
   - emoji with ZWJ sequences (byte-fallback behaviour), rare long words, base64/hex, URLs, JSON

2. **Reference counts** (`scripts/build-refs.mjs`): every probe is tokenised offline with every reference tokenizer: OpenAI cl100k/o200k (`js-tiktoken`), plus Llama 2/3, Gemma/Gemini, Qwen 2.5/3, DeepSeek V3/V4, Mistral Tekken, Claude legacy, gpt-oss and ChatGLM3 (`@lenml/tokenizer-*`). Tokenizers that give identical counts on the whole pool are merged into one class: o200k ≡ gpt-oss, Gemma ≡ Gemini, Qwen 2.5 ≡ Qwen 3, DeepSeek V3 ≡ V4.

3. **Greedy probe selection**: start from an anchor probe and repeatedly add the probe that most increases the *worst-separated pair of families*, measured after fitting a per-endpoint offset. With 8 probes, every pair of families differs by **≥ 23 tokens** of total residual. The closest pairs are Llama 2 vs ChatGLM3, o200k vs DeepSeek, and o200k vs Llama 3.
   Default set: `anchor, emoji, korean, cjk_zh, hindi, digits60, digits_sep, spaces`.

4. **Classification** (`public/js/classify.js`): for each reference *r*:
   - offset = median_i(obs_i − ref_r,i). This is the chat-template overhead, unknown but constant per endpoint.
   - score = Σ_i |obs_i − ref_r,i − offset|, plus a penalty if offset < 0 (impossible).

   The true tokenizer gives a column of zeros. Margins of ±1 are tolerated because the first or last token of the probe can merge with template tokens. Verdicts:
   - **match**: ≥ 80% of probes within ±1, relative error ≤ 3%, and the runner-up is clearly worse
   - **likely**: fits, but the runner-up is close
   - **unknown**: nothing fits. This is the interesting outcome for a stealth model: a new tokenizer, i.e. a new or retrained model from a lab whose tokenizer isn't in the reference set.

5. **Validation** (`npm test`): simulated endpoints with arbitrary overheads and ±1 boundary noise are recovered 100%. In a **leave-one-family-out** test, a family missing from the reference set is always reported `unknown`, never confidently matched to a wrong family. In the app, a **calibration** panel runs the classifier on free models whose family is known (Llama, Qwen, Gemma, DeepSeek, gpt-oss, Mistral…) and shows the agreement rate. Use it to check the pipeline on your key before trusting a verdict on a stealth model.

## Interpreting results and caveats

- **Tokenizer ≠ model.** A match says "uses the Qwen tokenizer", not "is Qwen 3". Fine-tunes and distillations (e.g. DeepSeek-R1-Distill-Llama) inherit their base model's tokenizer. A 2026 holdout study ("Token Counts Are Not Model Lineage") warns that token counts only support narrow claims about the tokenizer and request-wrapping stack. Freeze thresholds before looking at the target, and keep a holdout set.
- **Tokenizers can be copied.** A new lab can reuse an open tokenizer, e.g. Llama 3 or Qwen. Treat a match as evidence, not proof.
- **`unknown` is common for genuinely new families** whose tokenizer isn't installed. Examples reported for 2026 stealth models are GLM-5 and MiniMax. To test such a hypothesis, drop that model's HuggingFace `tokenizer.json` into `tokenizers/`, run `npm run refs`, and re-score. Cached observations are reused, so this costs no requests.
- **Claude 3+ and Gemini tokenizers are not public.** The "Claude legacy" reference is the pre-Claude-3 tokenizer. The `gemini` package matches Gemma's vocabulary.
- **Provider wrappers**: some providers inject system prompts or strip characters (e.g. emoji). The offset absorbs constant injections. Per-character stripping shows up as large residuals on one probe only, which you can see in the detail view.
- **Is `usage` native?** OpenRouter reports native token counts. If you ever see every model classified as o200k, the counts are being normalised. Switch *Token source* to `native_tokens_prompt`.
- **Privacy:** stealth endpoints usually log prompts for training. The probes are synthetic and harmless; don't add private data.

## Reported case studies (unverified, from the web)

- Community analyses of an "Ox Alpha" stealth model reported its counts matching Zhipu's GLM-5 tokenizer on all of 95 probes, using the same base-plus-probe differencing approach. A separate write-up attributes "Space Bunny Alpha" to the MiniMax tokenizer (within one constant framing token). Neither is confirmed by the labs.
  - <https://www.implicator.ai/ox-alpha-zhipu-glm-tokenizer-match/>
  - <https://huggingface.co/stealth-model/space-bunny-alpha/discussions/1>
  - <https://codersera.com/blog/space-bunny-alpha-stealth-model-2026/>

## Literature

These were found by web search; abstracts only were checked, not full papers.

- *Token Counts Are Not Model Lineage: A Frozen-Threshold Holdout Study of Black-Box LLM API Fingerprinting* (arXiv 2608.29930, 2026). <https://arxiv.org/pdf/2608.29930>
- *One Token Is Enough: Fingerprinting and Verifying LLMs from Single-Token Output Distributions* (arXiv 2607.10252, 2026). Covers 165 OpenRouter models. <https://arxiv.org/pdf/2607.10252>
- *FDLLM: A Dedicated Detector for Black-Box LLMs Fingerprinting* (arXiv 2501.16029). <https://arxiv.org/html/2501.16029v4>
- *RoFL: Robust Fingerprinting of Language Models* (arXiv 2505.12682). <https://arxiv.org/abs/2505.12682v1>
- *ProFLingo* (arXiv 2405.02466). <https://arxiv.org/pdf/2405.02466v2>
- Related: *A Fingerprint for Large Language Models* (arXiv 2407.01235), *Hide and Seek* (arXiv 2408.02871), *The Challenge of Identifying the Origin of Black-Box LLMs* (arXiv 2503.04332).

## Extending

- **More reference tokenizers**: add `@lenml/tokenizer-*` packages to `lib/tokenizers.mjs`, or drop `tokenizer.json` files into `tokenizers/`. Then run `npm run refs`.
- **More probes**: edit `lib/probe-pool.mjs`, then `npm run refs -- --probes 10` to pick a larger default set.
- **Next steps not yet implemented**: truncation-boundary probing, and single-token answer distributions to tell models apart within a tokenizer family.
