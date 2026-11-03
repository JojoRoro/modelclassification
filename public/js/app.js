import {
  classify, isFree, expectedFamily, stealthSignals,
  mergeSignatures, signatureFromObservations, signatureFromTokenizer, clusterByTokenizer,
} from './classify.js';

const API = 'https://openrouter.ai/api/v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

// ---------- persistence (all optional; page works without storage) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('tf.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tf.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const state = {
  catalog: [], byId: new Map(), ref: null,
  selected: new Set(store.get('selected', [])),
  probes: new Set(store.get('probes', [])),
  vendors: new Set(), toks: new Set(),
  cache: store.get('cache', {}),      // modelId -> probeId -> {t, provider, at}
  errors: store.get('errors', {}),    // modelId -> last error summary (string)
  errlog: store.get('errlog', {}),    // modelId -> [{at, probe, http, code, message, provider, raw, hint, variant}]
  variant: store.get('variant', {}),  // modelId -> index into REQUEST_VARIANTS that worked
  deep: new Set(store.get('deep', [])), // models to probe with the whole probe pool
  sigBundled: [], sigUser: store.get('signatures', []), refEff: null,
  running: null, detailId: null,
};
const saveSel = () => store.set('selected', [...state.selected]);
const saveCache = () => {
  store.set('cache', state.cache); store.set('errors', state.errors);
  store.set('errlog', state.errlog); store.set('variant', state.variant);
};

// ---------- API key ----------
const keyInput = $('#apiKey');
keyInput.value = store.get('key', '');
keyInput.addEventListener('change', () => store.set('key', keyInput.value.trim()));
$('#toggleKey').onclick = () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; };
const key = () => keyInput.value.trim();

async function keyInfo() {
  const r = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key()}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j.data;
}
$('#checkKey').onclick = async () => {
  store.set('key', key());
  const el = $('#keyInfo');
  if (!key()) { el.textContent = 'Paste a key first.'; return; }
  el.textContent = 'Checking…';
  try {
    const d = await keyInfo();
    el.innerHTML = `✓ ${esc(d.label || 'key')} · used $${Number(d.usage ?? 0).toFixed(4)}` +
      (d.limit != null ? ` of $${Number(d.limit).toFixed(2)}` : '') +
      (d.is_free_tier ? ' · free tier (≈50 free req/day)' : '') +
      (d.rate_limit ? ` · ${esc(d.rate_limit.requests)}/${esc(d.rate_limit.interval)}` : '');
  } catch (e) { el.textContent = '✗ ' + e.message; }
};

// ---------- catalog ----------
const vendorOf = (m) => m.id.split('/')[0];
const isText = (m) => (m.architecture?.output_modalities ?? ['text']).includes('text');
const isStealth = (m) => { const s = stealthSignals(m); return s.some((x) => x.startsWith('openrouter/stealth')) || s.length >= 2; };

async function loadCatalog() {
  try {
    const r = await fetch(`${API}/models`);
    const j = await r.json();
    state.catalog = j.data.map((m) => ({ ...m, _free: isFree(m), _stealth: isStealth(m), _sig: stealthSignals(m) }));
    state.byId = new Map(state.catalog.map((m) => [m.id, m]));
    for (const id of state.selected) if (!state.byId.has(id)) state.selected.delete(id); // delisted
    saveSel();
    const nf = state.catalog.filter((m) => m._free).length;
    $('#catalogInfo').textContent = `${state.catalog.length} models · ${nf} free`;
  } catch (e) {
    $('#catalogInfo').textContent = 'Could not load catalog: ' + e.message;
  }
  renderFacets(); renderModels(); renderResults();
}

async function loadRef() {
  const r = await fetch('data/reference.json');
  state.ref = await r.json();
  try { state.sigBundled = (await (await fetch('data/signatures.json')).json()).signatures || []; } catch { state.sigBundled = []; }
  rebuildRef();
  if (!state.probes.size) state.ref.defaultProbeIds.forEach((id) => state.probes.add(id));
  renderProbes();
}

// ---------- filters ----------
const F = {
  q: $('#q'), free: $('#fFree'), stealth: $('#fStealth'), sel: $('#fSelected'), text: $('#fText'),
  age: $('#fAge'), sort: $('#sort'),
};
for (const el of Object.values(F)) el.addEventListener('input', () => { renderFacets(); renderModels(); });

function baseFilter(m) {
  if (F.free.checked && !m._free) return false;
  if (F.text.checked && !isText(m)) return false;
  if (F.stealth.checked && !m._stealth) return false;
  if (F.sel.checked && !state.selected.has(m.id)) return false;
  const age = Number(F.age.value);
  if (age && (!m.created || Date.now() / 1000 - m.created > age * 86400)) return false;
  const q = F.q.value.trim().toLowerCase();
  if (q && !`${m.id} ${m.name} ${m.description}`.toLowerCase().includes(q)) return false;
  return true;
}
const tokName = (m) => m.architecture?.tokenizer || 'none';
function visibleModels() {
  const list = state.catalog.filter((m) => baseFilter(m)
    && (!state.vendors.size || state.vendors.has(vendorOf(m)))
    && (!state.toks.size || state.toks.has(tokName(m))));
  const s = F.sort.value;
  const cmp = {
    new: (a, b) => (b.created || 0) - (a.created || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    vendor: (a, b) => a.id.localeCompare(b.id),
    ctx: (a, b) => (b.context_length || 0) - (a.context_length || 0),
  }[s];
  return list.sort(cmp);
}

function chipGroup(el, counts, set, countEl) {
  el.innerHTML = '';
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [name, n] of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (set.has(name) ? ' on' : '');
    b.innerHTML = `${esc(name)}<span class="n">${n}</span>`;
    b.onclick = () => { set.has(name) ? set.delete(name) : set.add(name); renderFacets(); renderModels(); };
    el.appendChild(b);
  }
  countEl.textContent = set.size ? `${set.size} selected` : `${entries.length}`;
}
function renderFacets() {
  const base = state.catalog.filter(baseFilter);
  const vc = new Map(), tc = new Map();
  for (const m of base) {
    if (!state.toks.size || state.toks.has(tokName(m))) vc.set(vendorOf(m), (vc.get(vendorOf(m)) || 0) + 1);
    if (!state.vendors.size || state.vendors.has(vendorOf(m))) tc.set(tokName(m), (tc.get(tokName(m)) || 0) + 1);
  }
  for (const v of state.vendors) if (!vc.has(v)) vc.set(v, 0);
  for (const t of state.toks) if (!tc.has(t)) tc.set(t, 0);
  chipGroup($('#vendorChips'), vc, state.vendors, $('#vendorCount'));
  chipGroup($('#tokChips'), tc, state.toks, $('#tokCount'));
}

// ---------- model list ----------
const fmtDate = (s) => s ? new Date(s * 1000).toISOString().slice(0, 10) : '';
const price = (m, k) => Math.max(0, Number(m.pricing?.[k]) || 0); // $ per token (or per request)
const perM = (x) => { const v = x * 1e6; return v >= 10 ? v.toFixed(0) : v >= 0.1 ? v.toFixed(2) : v.toPrecision(2); };
const fmtUsd = (x) => x === 0 ? '$0.00' : x < 0.0001 ? '<$0.0001' : '$' + x.toFixed(4);
const PAID_MAX_TOKENS = 16; // paid models never get the larger retry shapes
/** Upper-bound cost of one probe request (prompt ~ probe + 40 template tokens, completion = max_tokens). */
function requestCost(m, probe) {
  if (!m || m._free) return 0;
  const counts = probe ? Object.values(probe.counts) : [60];
  const promptTok = Math.max(...counts) + 40;
  return promptTok * price(m, 'prompt') + PAID_MAX_TOKENS * (price(m, 'completion') + price(m, 'internal_reasoning')) + price(m, 'request');
}
function paidTag(m) {
  const t = `$${perM(price(m, 'prompt'))}/M in · $${perM(price(m, 'completion'))}/M out` + (price(m, 'request') ? ` · $${price(m, 'request')}/req` : '');
  return `<span class="tag paid" title="Costs money: ${esc(t)}">paid · ${esc(t)}</span>`;
}
function renderModels() {
  const list = visibleModels();
  const ul = $('#modelList');
  const frag = document.createDocumentFragment();
  for (const m of list.slice(0, 600)) {
    const li = document.createElement('li');
    const tags = [
      m._free ? '<span class="tag free">free</span>' : paidTag(m),
      m._stealth ? `<span class="tag stealth" title="${esc(m._sig.join('; '))}">stealth?</span>` : '',
      `<span class="tag">${esc(tokName(m))}</span>`,
      m.context_length ? `<span class="tag">${Math.round(m.context_length / 1000)}k ctx</span>` : '',
      m.created ? `<span class="tag">${fmtDate(m.created)}</span>` : '',
    ].join('');
    li.innerHTML = `<input type="checkbox" ${state.selected.has(m.id) ? 'checked' : ''} aria-label="select ${esc(m.id)}">
      <div><div>${esc(m.name)}</div><div class="mid muted">${esc(m.id)}</div><div class="meta">${tags}</div></div>`;
    li.querySelector('input').onchange = (e) => {
      e.target.checked ? state.selected.add(m.id) : state.selected.delete(m.id);
      saveSel(); renderSelInfo();
    };
    frag.appendChild(li);
  }
  ul.replaceChildren(frag);
  if (list.length > 600) ul.insertAdjacentHTML('beforeend', `<li class="muted small">…${list.length - 600} more. Narrow the filters.</li>`);
  renderSelInfo(list.length);
}
function renderSelInfo(nVisible) {
  const n = nVisible ?? visibleModels().length;
  $('#selInfo').textContent = `${state.selected.size} selected · ${n} visible`;
  renderEstimate();
}

document.querySelectorAll('[data-mass]').forEach((b) => b.addEventListener('click', () => {
  const vis = visibleModels();
  switch (b.dataset.mass) {
    case 'allFree': state.catalog.filter((m) => m._free && (!F.text.checked || isText(m))).forEach((m) => state.selected.add(m.id)); break;
    case 'visible': vis.forEach((m) => state.selected.add(m.id)); break;
    case 'stealth': vis.filter((m) => m._stealth).forEach((m) => state.selected.add(m.id)); break;
    case 'perVendor': {
      const seen = new Set();
      [...vis].sort((a, c) => (c.created || 0) - (a.created || 0)).forEach((m) => {
        if (!seen.has(vendorOf(m))) { seen.add(vendorOf(m)); state.selected.add(m.id); }
      });
      break;
    }
    case 'invert': vis.forEach((m) => state.selected.has(m.id) ? state.selected.delete(m.id) : state.selected.add(m.id)); break;
    case 'none': state.selected.clear(); break;
  }
  saveSel(); renderModels();
}));

// ---------- probes ----------
function renderProbes() {
  const ul = $('#probeList');
  ul.innerHTML = '';
  for (const p of state.ref.probes) {
    const li = document.createElement('li');
    li.innerHTML = `<input type="checkbox" ${state.probes.has(p.id) ? 'checked' : ''}>
      <div><b>${esc(p.id)}</b> <span class="muted">· ${esc(p.why)}</span><div class="ptext" title="${esc(p.text)}">${esc(JSON.stringify(p.text))}</div></div>`;
    li.querySelector('input').onchange = (e) => {
      e.target.checked ? state.probes.add(p.id) : state.probes.delete(p.id);
      store.set('probes', [...state.probes]); renderProbeCount();
    };
    ul.appendChild(li);
  }
  renderProbeCount();
}
function renderProbeCount() { $('#probeCount').textContent = `${state.probes.size} selected`; renderEstimate(); }
$('#probeDefault').onclick = () => { state.probes = new Set(state.ref.defaultProbeIds); store.set('probes', [...state.probes]); renderProbes(); };
$('#probeAll').onclick = () => { state.probes = new Set(state.ref.probes.map((p) => p.id)); store.set('probes', [...state.probes]); renderProbes(); };

// ---------- settings ----------
const S = { source: $('#tokenSource'), delay: $('#delay'), budget: $('#dailyBudget'), maxSpend: $('#maxSpend') };
const savedS = store.get('settings', {});
for (const [k, el] of Object.entries(S)) {
  if (savedS[k] !== undefined) el.type === 'checkbox' ? (el.checked = savedS[k]) : (el.value = savedS[k]);
  el.addEventListener('change', () => {
    store.set('settings', Object.fromEntries(Object.entries(S).map(([kk, e]) => [kk, e.type === 'checkbox' ? e.checked : e.value])));
    renderEstimate();
  });
}

function pendingTasks() {
  const tasks = [];
  for (const id of state.selected) {
    const m = state.byId.get(id);
    if (!m) continue;
    const probes = state.deep.has(id) ? state.ref.probes.map((p) => p.id) : [...state.probes];
    for (const pid of probes) if (!state.cache[id]?.[pid]) tasks.push({ id, pid, paid: !m._free });
  }
  return tasks;
}
function estimateCost(tasks) {
  const probeById = new Map(state.ref.probes.map((p) => [p.id, p]));
  return tasks.reduce((a, t) => a + (t.paid ? requestCost(state.byId.get(t.id), probeById.get(t.pid)) : 0), 0);
}
function renderEstimate() {
  if (!state.ref) return;
  const tasks = pendingTasks();
  const n = tasks.length;
  const nPaid = tasks.filter((t) => t.paid).length;
  const nFree = n - nPaid;
  const cost = estimateCost(tasks);
  const cap = Number(S.maxSpend.value) || 0;
  const extra = S.source.value === 'generation' ? ' (+ the same number of free /generation lookups)' : '';
  const budget = Number(S.budget.value) || 50;
  const mins = Math.ceil((n * Number(S.delay.value)) / 60000);
  const warns = [];
  if (nFree > budget) warns.push(`⚠ ${nFree} free requests is more than your daily free budget (${budget}). The run will stop when OpenRouter returns a daily-limit 429. Cached results are kept, so you can resume tomorrow.`);
  if (nPaid && cost > cap) warns.push(`⚠ Estimated paid cost (up to ${fmtUsd(cost)}) is above your max spend per run (${fmtUsd(cap)}). The run will stop once actual spend reaches the cap.`);
  const el = $('#estimate');
  el.className = 'estimate' + (warns.length ? ' warn' : '');
  el.innerHTML = `<b>${n}</b> uncached requests (${nFree} free, <b>${nPaid} paid</b>)${extra} · ~${mins} min · ` +
    `estimated cost <b>${nPaid ? 'up to ' + fmtUsd(cost) : '$0.00'}</b>` + (warns.length ? '<br>' + warns.join('<br>') : '');
}

// ---------- runner ----------
class Fatal extends Error {}

// Request shapes tried in order when a provider rejects one. Prompt tokens don't
// depend on max_tokens, so any variant gives the same fingerprint. All are free.
const REQUEST_VARIANTS = [
  { label: 'max_tokens=1, temperature=0', body: { max_tokens: 1, temperature: 0 } },
  { label: 'max_tokens=16', body: { max_tokens: 16 } },
  { label: 'max_tokens=256', body: { max_tokens: 256 } },
  { label: 'max_tokens=1024', body: { max_tokens: 1024 } },
];

async function callModel(model, text, signal, variant = 0) {
  // HARD SPENDING GUARD: re-check right before every request.
  const m = state.byId.get(model);
  if (!m) throw new Fatal(`refusing unlisted model ${model}`);
  if (!isFree(m) && REQUEST_VARIANTS[variant].body.max_tokens > PAID_MAX_TOKENS) throw new Fatal(`refusing max_tokens > ${PAID_MAX_TOKENS} on paid model ${model}`);
  const r = await fetch(`${API}/chat/completions`, {
    method: 'POST', signal,
    headers: {
      Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json',
      'HTTP-Referer': location.origin, 'X-Title': 'Tokenizer Fingerprinter',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], ...REQUEST_VARIANTS[variant].body }),
  });
  const rawText = await r.text().catch(() => '');
  let j = {};
  try { j = JSON.parse(rawText); } catch { j = rawText ? { error: { message: 'Non-JSON response', metadata: { raw: rawText } } } : {}; }
  return { status: r.status, headers: r.headers, body: j };
}

async function nativeTokens(genId, signal) {
  for (let i = 0; i < 6; i++) {
    await sleep(1200 + i * 800, signal);
    const r = await fetch(`${API}/generation?id=${encodeURIComponent(genId)}`, { headers: { Authorization: `Bearer ${key()}` }, signal });
    if (r.ok) {
      const d = (await r.json()).data;
      if (Number.isFinite(d?.native_tokens_prompt)) return d.native_tokens_prompt;
    }
  }
  return null;
}

const clip = (x, n = 1500) => { const t = typeof x === 'string' ? x : JSON.stringify(x); return t && t.length > n ? t.slice(0, n) + '…' : t; };

/** Best-effort plain-language explanation of an OpenRouter / provider error. */
function errorHint(http, msg, raw) {
  const t = `${msg} ${raw}`.toLowerCase();
  if (/data policy|privacy|training|publication|logging/.test(t)) return 'Model needs a privacy opt-in: enable free-model training/logging in OpenRouter Settings → Privacy (stealth models usually require this).';
  if (/no endpoints found|not a valid model|model not found|does not exist/.test(t) || http === 404) return 'No available endpoint for this model (removed, renamed, or blocked by your provider/privacy settings).';
  if (/max_tokens|max_completion|max_output|minimum|at least \d+/.test(t)) return 'Provider rejects this max_tokens value; retried with larger values.';
  if (/temperature/.test(t)) return 'Provider rejects the temperature parameter; retried without it.';
  if (/moderation|flagged|safety|content policy/.test(t) || http === 403) return 'Prompt was blocked by moderation. Try deselecting this probe.';
  if (/context|too long|token limit/.test(t)) return 'Prompt too long for this endpoint.';
  if (/timeout|timed out/.test(t) || http === 408) return 'Provider timed out.';
  if (/overloaded|capacity|unavailable|busy/.test(t) || http === 502 || http === 503) return 'Provider overloaded or down. Retry later.';
  if (/rate|quota|limit/.test(t)) return 'Rate or quota limit on the upstream provider.';
  if (/provider returned error/.test(t)) return 'Generic upstream error; see the raw provider message.';
  return '';
}

function logError(id, rec) {
  const log = (state.errlog[id] ||= []);
  log.push(rec);
  if (log.length > 20) log.splice(0, log.length - 20);
  console.warn('[fingerprinter]', id, rec);
}

async function probeOnce(id, probe, signal, status) {
  let variant = state.variant[id] ?? 0;
  let lastErr = null;
  for (let attempt = 0; attempt < 7; attempt++) {
    let res;
    try {
      res = await callModel(id, probe.text, signal, variant);
    } catch (e) {
      if (e instanceof Fatal || e.name === 'AbortError') throw e;
      // fetch() itself failed: network, CORS, DNS, blocked by extension…
      const rec = { at: Date.now(), probe: probe.id, http: 0, code: null, message: `Network error: ${e.message}`, provider: null, raw: '', variant: REQUEST_VARIANTS[variant].label, hint: 'Request never reached OpenRouter (offline, ad-blocker, or network policy).' };
      logError(id, rec);
      lastErr = rec;
      if (attempt < 2) { await sleep(3000, signal); continue; }
      break;
    }
    const { status: code, headers, body } = res;
    const err = body?.error || body?.choices?.[0]?.error;
    const pt = body?.usage?.prompt_tokens;
    if (code === 200 && Number.isFinite(pt) && pt > 0) {
      // Even if the completion failed, the prompt was tokenised and billed (at $0): usable.
      let t = pt;
      if (S.source.value === 'generation' && body.id) {
        const n = await nativeTokens(body.id, signal);
        if (n != null) t = n;
      }
      state.variant[id] = variant;
      return { t, provider: body.provider || null, at: Date.now(), variant };
    }
    const md = err?.metadata || {};
    const msg = err?.message || (code === 200 ? 'Response had no usage data' : `HTTP ${code}`);
    const raw = clip(md.raw ?? (md.reasons ? { reasons: md.reasons, flagged_input: md.flagged_input } : '') ?? '');
    const rec = {
      at: Date.now(), probe: probe.id, http: code, code: err?.code ?? null, message: msg,
      provider: md.provider_name || body?.provider || null, raw, variant: REQUEST_VARIANTS[variant].label,
      hint: errorHint(code, msg, raw || ''), id: body?.id || null,
    };
    logError(id, rec);
    lastErr = rec;

    if (code === 429) {
      if (/per-day|per day|daily/i.test(msg + raw)) throw new Fatal('Daily free-model limit reached: ' + msg);
      const reset = Number(headers.get('x-ratelimit-reset'));
      const wait = Number.isFinite(reset) && reset > Date.now() ? Math.min(90000, reset - Date.now() + 500) : 15000 * (attempt + 1);
      status(`rate limited${rec.provider ? ` by ${rec.provider}` : ''}, waiting ${Math.round(wait / 1000)}s…`);
      await sleep(wait, signal);
      continue;
    }
    if (code === 402) throw new Fatal('402 Payment required. Stopping to protect the budget.');
    if (code === 401) throw new Fatal('401 Invalid API key.');
    if (code === 404 || /data policy|no endpoints found/i.test(msg)) break; // retrying won't help
    // Parameter problems or opaque provider errors: try the next request shape.
    const maxVariant = state.byId.get(id)?._free ? REQUEST_VARIANTS.length - 1 : REQUEST_VARIANTS.findLastIndex((v) => v.body.max_tokens <= PAID_MAX_TOKENS);
    if (variant < maxVariant && (code === 400 || code === 422 || code === 200 || /provider returned error/i.test(msg))) {
      variant++;
      status(`${id}: ${msg}${rec.provider ? ` (${rec.provider})` : ''}. Retrying with ${REQUEST_VARIANTS[variant].label}…`);
      await sleep(1500, signal);
      continue;
    }
    if (code >= 500 && attempt < 3) { await sleep(4000 * (attempt + 1), signal); continue; }
    break;
  }
  const e = new Error(summarize(lastErr));
  e.rec = lastErr;
  throw e;
}

function summarize(rec) {
  if (!rec) return 'gave up after retries';
  const parts = [rec.http ? `HTTP ${rec.http}` : null, rec.provider, rec.message].filter(Boolean);
  return parts.join(' · ');
}

async function run() {
  if (!key()) { $('#status').textContent = 'Enter your OpenRouter key first.'; return; }
  const tasks = pendingTasks();
  if (!tasks.length) { $('#status').textContent = 'Nothing to do. Everything selected is cached.'; renderResults(); return; }
  const ctl = new AbortController();
  state.running = ctl;
  $('#run').disabled = true; $('#stop').disabled = false;
  const status = (s) => { $('#status').textContent = s; };
  const probeById = new Map(state.ref.probes.map((p) => [p.id, p]));
  const cap = Math.max(0, Number(S.maxSpend.value) || 0);
  const est = estimateCost(tasks);
  if (est > cap && !confirm(`Estimated paid cost is up to ${fmtUsd(est)}, above your max spend per run (${fmtUsd(cap)}).\n\nThe run will stop once actual spend reaches the cap. Continue?`)) { stopUi(); return; }
  const hasPaid = tasks.some((x) => x.paid);
  let usage0 = null;
  try { usage0 = Number((await keyInfo()).usage); } catch (e) { status('Key check failed: ' + e.message); stopUi(); return; }
  const spent = async () => Number((await keyInfo()).usage) - usage0;
  let lastSpent = 0;
  const failedModels = new Map();
  let done = 0;
  try {
    for (const t of tasks) {
      if (ctl.signal.aborted) break;
      if (failedModels.get(t.id)) { done++; continue; } // every request shape already failed once; retry on the next run
      if (t.paid) {
        // Don't start a paid request that could push spend past the cap.
        const next = requestCost(state.byId.get(t.id), probeById.get(t.pid));
        if (lastSpent + next > cap) throw new Fatal(`Next paid request (up to ${fmtUsd(next)}) would exceed the max spend per run (${fmtUsd(cap)}; spent ${fmtUsd(lastSpent)}). Stopped by the spend guard.`);
      }
      status(`${t.id} ← ${t.pid} (${done + 1}/${tasks.length})`);
      try {
        const obs = await probeOnce(t.id, probeById.get(t.pid), ctl.signal, status);
        (state.cache[t.id] ||= {})[t.pid] = obs;
        delete state.errors[t.id];
      } catch (e) {
        if (e instanceof Fatal || e.name === 'AbortError') throw e;
        failedModels.set(t.id, (failedModels.get(t.id) || 0) + 1);
        state.errors[t.id] = e.message;
        // If every request shape failed, start from the first one again next run.
        delete state.variant[t.id];
      }
      done++;
      saveCache();
      $('#bar').style.width = `${(100 * done) / tasks.length}%`;
      renderResults();
      // Spend guard: checked after every paid request, and every 10 free ones (free should never cost).
      if (t.paid || done % 10 === 0) {
        const d = await spent();
        lastSpent = Math.max(lastSpent, d);
        if (!hasPaid && d > 1e-9) throw new Fatal(`Key usage rose by ${fmtUsd(d)} on a free-only run. Aborted by the spend guard.`);
        if (d > 1e-9 && d >= cap) throw new Fatal(`Spent ${fmtUsd(d)} this run, reaching the max spend per run (${fmtUsd(cap)}). Stopped by the spend guard.`);
      }
      await sleep(Number(S.delay.value) || 3200, ctl.signal);
    }
    status(`Done. ${done} requests.`);
  } catch (e) {
    status(e.name === 'AbortError' ? 'Stopped.' : '⛔ ' + e.message);
  } finally {
    if (usage0 != null) {
      spent().then((d) => { if (d > 1e-9) $('#status').textContent += ` · spent ${fmtUsd(d)} this run`; }).catch(() => {});
    }
    stopUi(); saveCache(); renderResults(); renderEstimate();
  }
}
function stopUi() { state.running = null; $('#run').disabled = false; $('#stop').disabled = true; }
$('#run').onclick = run;
$('#stop').onclick = () => state.running?.abort();
$('#clearCache').onclick = () => {
  if (!confirm('Forget all cached observations? Re-running will spend free requests again.')) return;
  state.cache = {}; state.errors = {}; state.errlog = {}; state.variant = {}; saveCache(); renderResults(); renderEstimate();
};

// ---------- results ----------
const FAMILY_NAMES = {
  'openai-o200k': 'OpenAI o200k', 'openai-cl100k': 'OpenAI cl100k', llama3: 'Llama 3', llama2: 'Llama 2 / SPM-32k',
  gemma: 'Gemma / Gemini', qwen: 'Qwen', deepseek: 'DeepSeek', 'mistral-tekken': 'Mistral Tekken',
  'claude-legacy': 'Claude (legacy)', 'glm-legacy': 'ChatGLM3',
};
Object.assign(FAMILY_NAMES, { glm: 'GLM (Zhipu)', mimo: 'MiMo (Xiaomi)', 'meta-muse': 'Muse (Meta)', kimi: 'Kimi (Moonshot)', minimax: 'MiniMax' });
const famName = (f) => FAMILY_NAMES[f] || state.refEff?.references.find((r) => r.family === f)?.label || f;

// ---------- signatures ----------
const allSignatures = () => [...state.sigBundled, ...state.sigUser];
function rebuildRef() {
  state.refEff = mergeSignatures(state.ref, allSignatures());
  const nSig = allSignatures().length;
  $('#refInfo').textContent = `${state.ref.references.length} reference tokenizers + ${nSig} signatures`;
  renderSignatures();
}
function saveUserSignatures() { store.set('signatures', state.sigUser); rebuildRef(); renderResults(); }
/** Existing reference/signature with identical counts on every shared probe (≥ 8), if any. */
function identicalReference(sig) {
  for (const r of state.refEff.references) {
    const shared = state.ref.probes.filter((p) => Number.isFinite(sig.counts[p.id]) && Number.isFinite(state.refEff.probes.find((q) => q.id === p.id).counts[r.id]));
    if (shared.length >= 8 && shared.every((p) => state.refEff.probes.find((q) => q.id === p.id).counts[r.id] === sig.counts[p.id])) return r;
  }
  return null;
}
function addSignature(sig) {
  if (sig.source === 'tokenizer') {
    const same = identicalReference(sig);
    if (same && same.id !== sig.id) {
      $('#sigStatus').textContent = `Not added: "${sig.label}" gives exactly the same counts as the existing reference "${same.label}" on all probes. It's the same tokenizer (family ${famName(same.family)}).`;
      return false;
    }
  }
  state.sigUser = state.sigUser.filter((s) => s.id !== sig.id);
  state.sigUser.push(sig);
  saveUserSignatures();
  return true;
}
function renderSignatures() {
  const ul = $('#sigList');
  if (!ul) return;
  const sigs = allSignatures();
  $('#sigInfo').textContent = `${sigs.length} (${state.sigBundled.length} bundled)`;
  ul.innerHTML = sigs.length ? '' : '<li class="muted small">No signatures yet.</li>';
  for (const sg of sigs) {
    const bundled = state.sigBundled.includes(sg);
    const li = document.createElement('li');
    li.innerHTML = `<div><b>${esc(sg.label)}</b> <span class="tag src-${esc(sg.source)}">${esc(sg.source)}</span>
        <span class="tag">${Object.keys(sg.counts || {}).length} probes</span>${bundled ? ' <span class="tag">bundled</span>' : ''}
        <div class="small muted">family <code>${esc(sg.family)}</code>${sg.model ? ` · from <code>${esc(sg.model)}</code>` : ''}${sg.note ? ` · ${esc(sg.note)}` : ''} · ${esc(sg.created || '')}</div></div>
      ${bundled ? '' : '<button type="button" class="ghost small-btn">Remove</button>'}`;
    li.querySelector('button')?.addEventListener('click', () => {
      if (!confirm(`Remove signature "${sg.label}"?`)) return;
      state.sigUser = state.sigUser.filter((x) => x !== sg); saveUserSignatures();
    });
    ul.appendChild(li);
  }
}
const slug = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

/** Offer to save one model's (or a cluster's) observations as an observed signature. */
function saveObservedSignature(modelIds) {
  const best = [...modelIds].sort((a, b) => Object.keys(observations(b)).length - Object.keys(observations(a)).length)[0];
  const vendor = best.split('/')[0];
  const exp = state.byId.get(best) ? expectedFamily(state.byId.get(best)) : null;
  const fam = prompt(`Family name for the tokenizer of:\n${modelIds.join('\n')}\n\nModels matching it will be reported under this name. Use the lab or model-family name, e.g. glm, mimo, kimi.`, exp || slug(vendor));
  if (!fam) return;
  const label = prompt('Display label:', `${fam} (observed from ${best})`) || fam;
  const sig = signatureFromObservations(observations(best), {
    id: 'sig:' + slug(fam) + ':' + slug(best), family: slug(fam), label, model: best,
    note: modelIds.length > 1 ? `cluster of ${modelIds.length}: ${modelIds.join(', ')}` : null,
  });
  addSignature(sig);
  $('#sigStatus').textContent = `Saved signature "${label}" (${Object.keys(sig.counts).length} probes). Probe this model deeper to make it more specific.`;
}

// Tokenizer library (vendored browser build of @lenml/tokenizers, loaded on demand).
let tokLib = null;
function loadTokenizerLib() {
  if (tokLib) return tokLib;
  tokLib = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/lenml-tokenizers-3.7.2.global.js';
    sc.onload = () => (window.Tokenizers?.TokenizerLoader ? res(window.Tokenizers) : rej(new Error('tokenizer library failed to initialise')));
    sc.onerror = () => { tokLib = null; rej(new Error('could not load tokenizer library')); };
    document.head.appendChild(sc);
  });
  return tokLib;
}
async function signatureFromTokenizerJSON(tokenizerJSON, tokenizerConfig, { family, label, note }) {
  const lib = await loadTokenizerLib();
  const warn = console.warn; console.warn = () => {};
  let tok;
  try { tok = lib.TokenizerLoader.fromPreTrained({ tokenizerJSON, tokenizerConfig: tokenizerConfig || {} }); } finally { console.warn = warn; }
  const sig = signatureFromTokenizer((t) => tok.encode(t, { add_special_tokens: false }).length, state.ref.probes, { family, label, note });
  sig.id = 'tok:' + slug(family) + ':' + slug(label);
  return sig;
}
const hfToken = $('#hfToken');
hfToken.value = store.get('hfToken', '');
hfToken.addEventListener('change', () => store.set('hfToken', hfToken.value.trim()));
$('#hfAdd').onclick = async () => {
  const repo = $('#hfRepo').value.trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/(tree|blob|resolve)\/.*$/, '');
  const st = $('#sigStatus');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { st.textContent = 'Enter a repo id like owner/name.'; return; }
  const headers = hfToken.value.trim() ? { Authorization: `Bearer ${hfToken.value.trim()}` } : {};
  st.textContent = `Downloading ${repo}/tokenizer.json…`;
  try {
    const r = await fetch(`https://huggingface.co/${repo}/resolve/main/tokenizer.json`, { headers });
    if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status}: gated or private repo. Accept the licence on huggingface.co and add an HF token, or upload the file.`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: no tokenizer.json in this repo (some models ship only tiktoken/sentencepiece files, which aren't supported here).`);
    const json = await r.json();
    let cfg = {};
    try { const c = await fetch(`https://huggingface.co/${repo}/resolve/main/tokenizer_config.json`, { headers }); if (c.ok) cfg = await c.json(); } catch { /* optional */ }
    st.textContent = 'Tokenising probes…';
    const fam = slug($('#sigFamily').value) || slug(repo.split('/')[1]);
    const sig = await signatureFromTokenizerJSON(json, cfg, { family: fam, label: repo, note: 'huggingface.co/' + repo });
    if (addSignature(sig)) st.textContent = `Added exact signature for ${repo} (family "${fam}"). All results were re-scored.`;
  } catch (e) { st.textContent = '✗ ' + e.message; }
};
$('#tokFile').onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const st = $('#sigStatus');
  try {
    st.textContent = `Reading ${f.name}…`;
    const json = JSON.parse(await f.text());
    const fam = slug($('#sigFamily').value) || slug(f.name.replace(/\.json$/, '').replace(/tokenizer/i, '')) || 'custom';
    const sig = await signatureFromTokenizerJSON(json, {}, { family: fam, label: `${fam} (${f.name})`, note: 'uploaded file' });
    if (addSignature(sig)) st.textContent = `Added exact signature "${fam}" from ${f.name}.`;
  } catch (e) { st.textContent = '✗ ' + e.message; }
  ev.target.value = '';
};
$('#sigImport').onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const list = (Array.isArray(j) ? j : j.signatures || []).filter((x) => x?.id && x?.counts && x?.family);
    for (const sg of list) addSignature({ label: sg.family, source: 'observed', ...sg });
    $('#sigStatus').textContent = `Imported ${list.length} signature(s).`;
  } catch (e) { $('#sigStatus').textContent = '✗ ' + e.message; }
  ev.target.value = '';
};
$('#sigExport').onclick = () => download('signatures.json', JSON.stringify({ signatures: state.sigUser }, null, 2), 'application/json');

function observations(id) {
  return Object.fromEntries(Object.entries(state.cache[id] || {}).map(([pid, o]) => [pid, o.t]));
}
function resultFor(id) {
  const obs = observations(id);
  const res = Object.keys(obs).length ? classify(obs, state.refEff) : null;
  const m = state.byId.get(id);
  const exp = m ? expectedFamily(m) : null;
  const log = state.errlog[id] || [];
  return { id, m, obs, res, exp, err: state.errors[id], lastErr: state.errors[id] ? log[log.length - 1] : null, log };
}
function allResults() {
  const ids = new Set([...state.selected, ...Object.keys(state.cache), ...Object.keys(state.errors)]);
  return [...ids].map(resultFor).filter((r) => r.res || r.err);
}

function renderResults() {
  if (!state.ref) return;
  const rows = allResults();
  const tb = $('#results tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const v = r.res?.verdict ?? (r.err ? 'error' : 'pending');
    const best = r.res?.best;
    const agree = r.exp && best && ['match', 'likely', 'variant'].includes(r.res.verdict) ? (best.family === r.exp) : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${esc(r.id)}${r.m?._stealth ? ' <span class="tag stealth">stealth?</span>' : ''}${r.m && !r.m._free ? ' <span class="tag paid">paid</span>' : ''}${r.err ? errorSnippet(r) : ''}</td>
      <td><span class="badge b-${v}">${v}</span>${r.res?.confidence ? `<div class="small muted">${Math.round(r.res.confidence * 100)}%</div>` : ''}</td>
      <td>${best ? (v === 'unknown' ? `<span class="muted">nearest:</span> ${esc(famName(best.family))}` : v === 'variant' ? `<span class="muted">variant of</span> <b>${esc(famName(best.family))}</b>` : `<b>${esc(famName(best.family))}</b>`) + (best.source === 'observed' ? ' <span class="tag src-observed">observed sig</span>' : '') + `<div class="small muted">err ${(best.relErr * 100).toFixed(1)}%, ${best.within1}/${best.n} probes ±1` +
        (r.res.runnerUp ? ` · next: ${esc(famName(r.res.runnerUp.family))} (Δ${r.res.runnerUp.score - best.score})` : '') + '</div>' : '—'}</td>
      <td>${best ? best.offset : '—'}</td>
      <td>${esc(r.m?.architecture?.tokenizer || '—')}${r.exp ? ` → ${esc(famName(r.exp))}` : ''}${agree === true ? ' <span class="agree">✓</span>' : agree === false ? ' <span class="disagree">✗</span>' : ''}</td>
      <td>${Object.keys(r.obs).length}</td>`;
    tr.onclick = () => showDetail(r.id);
    tb.appendChild(tr);
  }
  if (!rows.length) tb.innerHTML = '<tr><td colspan="6" class="muted">No results yet. Select free models and press Run.</td></tr>';

  // Calibration: how often does the classifier agree with known families?
  // Calibration: only models whose expected family has a reference or signature.
  const fams = new Set(state.refEff.references.map((x) => x.family));
  const known = rows.filter((r) => r.exp && fams.has(r.exp) && r.res && r.res.verdict !== 'insufficient');
  const agreeN = known.filter((r) => ['match', 'likely'].includes(r.res.verdict) && r.res.best.family === r.exp).length;
  const unknownN = rows.filter((r) => r.res?.verdict === 'unknown').length;
  const stealthN = rows.filter((r) => r.m?._stealth && r.res).length;
  $('#calib').innerHTML = `
    <div class="stat"><b>${rows.filter((r) => r.res).length}</b><span class="small muted">models probed</span></div>
    <div class="stat"><b>${known.length ? Math.round((100 * agreeN) / known.length) + '%' : '—'}</b><span class="small muted">agree w/ known (${agreeN}/${known.length})</span></div>
    <div class="stat"><b>${unknownN}</b><span class="small muted">unknown tokenizer</span></div>
    <div class="stat"><b>${stealthN}</b><span class="small muted">stealth candidates</span></div>`;
  renderClusters(rows);
  if (state.detailId) showDetail(state.detailId, true);
}

function renderClusters(rows) {
  const cand = rows.filter((r) => r.res && ['unknown', 'variant'].includes(r.res.verdict));
  const card = $('#clustersCard');
  card.hidden = !cand.length;
  if (!cand.length) { $('#clusters').innerHTML = ''; return; }
  const groups = clusterByTokenizer(cand.map((r) => ({ id: r.id, obs: r.obs, r })));
  $('#clusterInfo').textContent = `${groups.length} type(s) from ${cand.length} model(s)`;
  $('#clusters').innerHTML = '';
  groups.forEach((g, i) => {
    const vendors = [...new Set(g.map((x) => x.id.split('/')[0]))];
    const near = g[0].r.res.best;
    const nProbes = Math.max(...g.map((x) => Object.keys(x.obs).length));
    const div = document.createElement('div');
    div.className = 'cluster';
    div.innerHTML = `<div class="row wrap"><b>Type ${i + 1}</b>
        <span class="tag">${g.length} model${g.length > 1 ? 's' : ''}</span>
        <span class="tag">labs: ${esc(vendors.join(', '))}</span>
        <span class="tag">${g[0].r.res.verdict === 'variant' ? 'variant of' : 'nearest'} ${esc(famName(near.family))} (${(near.relErr * 100).toFixed(1)}% err)</span></div>
      <div class="members">${g.map((x) => esc(x.id)).join('<br>')}</div>
      ${g.length > 1 ? '<div class="small muted">These models agree with each other probe-by-probe, so they share a tokenizer that is not in the reference set.</div>' : ''}
      <div class="row wrap"><button type="button" class="small-btn save">Save as signature</button>
      <button type="button" class="ghost small-btn deep">Probe deeper (${state.ref.probes.length} probes${nProbes >= state.ref.probes.length ? ', done' : ''})</button></div>`;
    div.querySelector('.save').onclick = () => saveObservedSignature(g.map((x) => x.id));
    div.querySelector('.deep').onclick = () => { g.forEach((x) => { state.deep.add(x.id); state.selected.add(x.id); }); store.set('deep', [...state.deep]); saveSel(); renderModels(); $('#status').textContent = `Queued all probes for ${g.length} model(s). Press Run.`; };
    $('#clusters').appendChild(div);
  });
}

function errorSnippet(r) {
  const e = r.lastErr;
  const raw = e?.raw ? `<div class="small muted mono-wrap">${esc(e.raw.slice(0, 180))}${e.raw.length > 180 ? '…' : ''}</div>` : '';
  const hint = e?.hint ? `<div class="small">💡 ${esc(e.hint)}</div>` : '';
  return `<div class="small disagree">${esc(r.err)}</div>${raw}${hint}`;
}

function errorDetail(r) {
  if (!r.log?.length) return '';
  const rows = [...r.log].reverse().map((e) => `<tr>
      <td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.probe)}</td><td>${e.http || 'net'}</td>
      <td>${esc(e.provider || '—')}</td><td>${esc(e.variant)}</td>
      <td>${esc(e.message)}${e.code != null && e.code !== e.http ? ` <span class="muted">(code ${esc(e.code)})</span>` : ''}${e.hint ? `<div class="muted">💡 ${esc(e.hint)}</div>` : ''}</td></tr>`).join('');
  const last = r.log[r.log.length - 1];
  return `<h3 class="small">Errors (${r.log.length}${r.log.length >= 20 ? ', last 20' : ''})</h3>
    <div class="table-wrap"><table class="err-table"><thead><tr><th>time</th><th>probe</th><th>HTTP</th><th>provider</th><th>request</th><th>message</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${last.raw ? `<p class="small muted">Raw provider response (latest):</p><pre class="raw">${esc(last.raw)}</pre>` : ''}
    <div class="row"><button type="button" class="ghost small-btn" id="copyErr">Copy error log JSON</button>
    <button type="button" class="ghost small-btn" id="clearErr">Clear errors for this model</button></div>`;
}

document.addEventListener('click', (ev) => {
  const id = state.detailId;
  if (!id) return;
  if (ev.target.id === 'copyErr') {
    navigator.clipboard?.writeText(JSON.stringify({ model: id, errors: state.errlog[id] || [] }, null, 2))
      .then(() => { ev.target.textContent = 'Copied ✓'; }, () => { ev.target.textContent = 'Copy failed'; });
  } else if (ev.target.id === 'saveSig') {
    saveObservedSignature([id]);
  } else if (ev.target.id === 'deepProbe') {
    state.deep.add(id); state.selected.add(id); store.set('deep', [...state.deep]); saveSel(); renderModels(); showDetail(id, true);
    $('#status').textContent = `Queued all probes for ${id}. Press Run.`;
  } else if (ev.target.id === 'clearErr') {
    delete state.errlog[id]; delete state.errors[id]; delete state.variant[id];
    saveCache(); renderResults(); showDetail(id, true);
  }
});

function showDetail(id, quiet) {
  state.detailId = id;
  const r = resultFor(id);
  $('#detailCard').hidden = false;
  $('#detailTitle').textContent = id;
  if (!r.res) { $('#detail').innerHTML = errorDetail(r) || '<p class="muted">No observations yet.</p>'; return; }
  const top = r.res.rows.slice(0, 6);
  const probes = state.ref.probes.filter((p) => Number.isFinite(r.obs[p.id]));
  const cell = (e) => e === undefined ? '<td class="muted">·</td>' : `<td class="${e === 0 ? 'r0' : Math.abs(e) <= 1 ? 'r1' : 'rN'}">${e > 0 ? '+' : ''}${e}</td>`;
  const providers = [...new Set(Object.values(state.cache[id] || {}).map((o) => o.provider).filter(Boolean))];
  $('#detail').innerHTML = `
    <p class="small">${r.m?.description ? esc(r.m.description.slice(0, 400)) + (r.m.description.length > 400 ? '…' : '') : ''}</p>
    <p class="small muted">Provider(s) that served the requests: ${esc(providers.join(', ') || 'n/a')}. Stealth signals: ${esc(r.m?._sig?.join('; ') || 'none')}.</p>
    <div class="table-wrap"><table class="detail-table">
      <thead><tr><th>probe</th><th>observed</th>${top.map((t) => `<th title="${esc(t.label)}">${esc(t.source === 'observed' ? t.family + '*' : t.id)}<br><span class="muted">ovh ${t.offset}</span></th>`).join('')}</tr></thead>
      <tbody>${probes.map((p) => {
        return `<tr><td>${esc(p.id)}</td><td>${r.obs[p.id]}</td>${top.map((t) => cell(t.resid[p.id])).join('')}</tr>`;
      }).join('')}
      <tr><td><b>Σ|resid|</b></td><td></td>${top.map((t) => `<td><b>${t.absErr}</b></td>`).join('')}</tr></tbody>
    </table></div>
    <div class="row wrap" style="margin-top:8px">
      <button type="button" class="small-btn" id="saveSig">Save as signature</button>
      <button type="button" class="ghost small-btn" id="deepProbe">${state.deep.has(id) ? 'Deep probing queued ✓' : `Probe deeper (all ${state.ref.probes.length} probes)`}</button>
    </div>
    ${errorDetail(r)}
    <p class="small muted">Cells are residuals after fitting the template overhead (observed − reference − overhead). The true tokenizer has a column of zeros. ±1 can come from token merges at the template boundary. * = observed signature (its overhead is relative); · = probe not in that signature.</p>`;
  if (!quiet) $('#detailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#closeDetail').onclick = () => { state.detailId = null; $('#detailCard').hidden = true; };

// ---------- export ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#exportJson').onclick = () => download('fingerprints.json', JSON.stringify(allResults().map((r) => ({
  model: r.id, declared_tokenizer: r.m?.architecture?.tokenizer ?? null, expected_family: r.exp,
  verdict: r.res?.verdict ?? null, family: r.res?.best?.family ?? null, reference: r.res?.best?.id ?? null,
  rel_err: r.res?.best?.relErr ?? null, overhead: r.res?.best?.offset ?? null,
  runner_up: r.res?.runnerUp?.family ?? null, confidence: r.res?.confidence ?? null,
  observations: r.obs, error: r.err ?? null, error_log: r.log, stealth_signals: r.m?._sig ?? [],
})), null, 2), 'application/json');
$('#exportCsv').onclick = () => {
  const head = ['model', 'verdict', 'family', 'reference', 'rel_err', 'overhead', 'runner_up', 'declared_tokenizer', 'expected_family', 'n_probes', ...state.ref.probes.map((p) => p.id)];
  const lines = [head.join(',')];
  for (const r of allResults()) {
    const b = r.res?.best;
    lines.push([r.id, r.res?.verdict, b?.family, b?.id, b?.relErr?.toFixed(4), b?.offset, r.res?.runnerUp?.family,
      r.m?.architecture?.tokenizer, r.exp, Object.keys(r.obs).length, ...state.ref.probes.map((p) => r.obs[p.id] ?? '')]
      .map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
  }
  download('fingerprints.csv', lines.join('\n'), 'text/csv');
};

// ---------- boot ----------
loadRef().then(loadCatalog);
