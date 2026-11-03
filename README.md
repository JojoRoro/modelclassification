# Tokenizer Fingerprinter

A static web app that classifies new and **stealth LLMs** on OpenRouter by their **tokenizer**. It sends a handful of carefully chosen probe strings, reads the prompt-token counts the API reports, and matches them against ten reference tokenizer families. **It only ever calls free models.**

See [RESEARCH.md](RESEARCH.md) for the method, validation and caveats.

## Run

```bash
npm start
```

Then open <http://localhost:5173>. Any static host also works, because the app is plain files in `public/`. The included GitHub Actions workflow deploys `public/` to GitHub Pages once Pages is enabled with source "GitHub Actions".

1. Paste your OpenRouter key and press **Check**. The key is kept in your browser's localStorage and sent only to `openrouter.ai`. It is never committed or sent anywhere else.
2. Pick models. Filter by search text, free only, stealth candidates, vendor, declared tokenizer, age or output modality. Mass-select with **Select all free**, **Select visible**, **Select stealth**, **1 per vendor**, **Invert visible** or **Clear**.
3. Press **Run fingerprint**. Results are cached per model and probe, so re-runs and re-scoring are free.

## Budget safety

- Paid models are shown but can't be selected. Before **every** request the app re-checks that *every* price field of the model is `0`, and refuses otherwise.
- Requests use `max_tokens: 1` and `temperature: 0`.
- **Spend guard** (on by default): the app reads your key's `usage` before the run and every 10 requests, and aborts if it ever increases. It also stops on HTTP 402.
- Free-tier limits: about 20 req/min (the default delay is 3.2 s) and about 50 req/day on keys with less than $10 of credit purchased. A daily-limit 429 stops the run cleanly. With the default 8 probes, that's about 6 models per day; the estimate box shows the count before you start.

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

To add a tokenizer family, such as a new open-weights release you suspect is behind a stealth model, drop its HuggingFace `tokenizer.json` into `tokenizers/<name>.json` and run `npm run refs`.

```
public/            the web app (index.html, js/app.js, js/classify.js, data/reference.json)
lib/               probe pool + reference tokenizer loader (build time)
scripts/           build-refs.mjs, serve.mjs
test/              node:test suite
```
