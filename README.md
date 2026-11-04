# Tokenizer Fingerprinter

A static web app that classifies new and **stealth LLMs** on OpenRouter by their **tokenizer**. It sends a handful of carefully chosen probe strings, reads the prompt-token counts the API reports, and matches them against ten reference tokenizer families. Free models cost nothing; paid models are marked with their price and capped by a per-run spend limit.

See [RESEARCH.md](RESEARCH.md) for the method, validation and caveats.

## Run

```bash
npm start
```

Then open <http://localhost:5173>. Any static host also works, because the app is plain files in `public/`. The included GitHub Actions workflow deploys `public/` to GitHub Pages once Pages is enabled with source "GitHub Actions".

1. Paste your OpenRouter key and press **Check**. The key is kept in your browser's localStorage and sent only to `openrouter.ai`. It is never committed or sent anywhere else.
2. Pick models. Filter by search text, free only, stealth candidates, vendor, declared tokenizer, age or output modality. Mass-select with **Select all free**, **Select visible**, **Select stealth**, **1 per vendor**, **Invert visible** or **Clear**.
3. Press **Run fingerprint**. Results are cached per model and probe, so re-runs and re-scoring are free.
4. Models that match no reference appear under **New tokenizer types**, grouped when they share a tokenizer. Save a group as a **signature**, or add an exact signature from a HuggingFace `tokenizer.json`, and future models with that tokenizer are recognised. See [RESEARCH.md](RESEARCH.md#detecting-new-model-types-signatures).

## LiteLLM proxy backend

Pick **LiteLLM proxy (custom URL)** in the *Backend* dropdown to fingerprint the models behind your own [LiteLLM](https://docs.litellm.ai/) proxy instead of OpenRouter.

1. Enter the proxy URL (with or without `/v1`) and a LiteLLM key, then press **Check**. URL and key stay in your browser and are sent only to that URL.
2. Every model id the key can use is listed, from `/v1/models` (wildcard routes expanded) enriched with `/model/info`. Each row shows its **provider** (`litellm_provider`, e.g. `openai`, `anthropic`, `bedrock`, `ollama`), the upstream model and the price the proxy reports.
3. Filter by search text (matches id, provider and upstream model), **Provider** chips, **Mode** chips (chat, embedding, …), *Chat models*, *Free only* (price 0, e.g. self-hosted) or *Selected only*. **1 per provider** picks one model per provider.
4. Results, exports and clusters show the provider too. Selection, cache and settings are kept separately per backend; signatures are shared.

Spend: the run reads `spend` from `/key/info` before and during the run, and also sums each response's `x-litellm-response-cost` header (or the upper-bound estimate). The larger of the two is checked against *Max spend per run*. Models with no price on the proxy are marked **price unknown** and are not in the estimate. The proxy must allow CORS from the page's origin (LiteLLM allows all origins by default).

Caveat: LiteLLM passes through the provider's `usage.prompt_tokens`. If a provider returns no usage, LiteLLM counts tokens itself (usually with tiktoken), and such a model will look like an OpenAI tokenizer.

## Costs and budget safety

- **Free models** (every price field `0`) cost nothing and are tagged `free`.
- **Paid models** can be selected too. They're tagged with their price (e.g. `paid · $1.25/M in · $10/M out`). The run estimate shows free vs. paid requests and an upper-bound cost. One probe on a typical paid model costs a fraction of a cent.
- Requests use `max_tokens: 1`. Paid models are never retried with more than 16 output tokens.
- **Max spend per run** (Settings, default $0.01): the app reads your key's `usage` before the run and after every paid request. It won't start a paid request that could push spend past the cap. A free-only run aborts if usage rises at all. HTTP 402 always stops the run. OpenRouter may update `usage` with a short delay, so treat the cap as best-effort. A spending limit on the key itself is the hard backstop.
- Free-model limits: about 20 req/min (the default delay is 3.2 s). About 50 req/day if you've bought less than $10 of credits in total, about 1,000/day otherwise. A daily-limit 429 stops the run cleanly and cached results are kept.

## Develop

```bash
npm install
```

This installs the reference tokenizers (`optionalDependencies`, about 1.2 GB). It's only needed to rebuild the reference data.

```bash
npm run refs
```

Regenerates `public/data/reference.json` (probe × tokenizer counts, plus the greedy default probe set).

```bash
npm test
```

Runs simulation tests: exact recovery with arbitrary overheads, ±1 noise, and leave-one-family-out.

```bash
node scripts/add-signature.mjs fingerprints.json <model-id> --family <name>
```

Bundles an observed signature from a results export into `public/data/signatures.json`.

To add a tokenizer family, such as a new open-weights release you suspect is behind a stealth model, drop its HuggingFace `tokenizer.json` into `tokenizers/<name>.json` and run `npm run refs`.

```
public/            the web app (index.html, js/app.js, js/classify.js, data/reference.json)
lib/               probe pool + reference tokenizer loader (build time)
scripts/           build-refs.mjs, serve.mjs
test/              node:test suite
```
