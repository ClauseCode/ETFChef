// ── ETFChef ────────────────────────────────────────────────
// Alpha Vantage free tier (25 calls/day):
//   ETF holdings: ?function=ETF_PROFILE&symbol=QQQ&apikey=...
//   Quote:        ?function=GLOBAL_QUOTE&symbol=QQQ&apikey=...

const API_BASE      = 'https://www.alphavantage.co/query';
const CACHE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_PREFIX  = 'etf_holdings_';

// ── State ──────────────────────────────────────────────────
let positions    = [];
let allRows      = [];
let activeFilter = 'all';
let nextId       = 1;
const priceCache = {};
let publicMode   = false;
const tickerCaps = {}; // ticker → max absolute exposure fraction (per-stock override)
let lastOptLegs  = null; // last optimization result legs for porting to Historical tab

// ── DOM refs ───────────────────────────────────────────────
const apiKeyInput       = document.getElementById('apiKey');
const saveApiKeyBtn     = document.getElementById('saveApiKey');
const addPositionBtn    = document.getElementById('addPosition');
const positionsList     = document.getElementById('positionsList');
const calculateBtn      = document.getElementById('calculate');
const clearAllBtn       = document.getElementById('clearAll');
const resultsSection    = document.getElementById('resultsSection');
const resultsMeta       = document.getElementById('resultsMeta');
const summaryCards      = document.getElementById('summaryCards');
const resultsChart      = document.getElementById('resultsChart');
const errorBanner       = document.getElementById('errorBanner');
const successBanner     = document.getElementById('successBanner');
const loadingOverlay    = document.getElementById('loadingOverlay');
const loadingMessage    = document.getElementById('loadingMessage');
const stockSearch       = document.getElementById('stockSearch');
const filterTabs        = document.querySelectorAll('.filter-tab');
const cacheBadge        = document.getElementById('cacheBadge');
const cachePanel        = document.getElementById('cachePanel');
const toggleCacheBtn    = document.getElementById('toggleCachePanel');
const exportCacheBtn    = document.getElementById('exportCache');
const importCacheInput  = document.getElementById('importCacheInput');

// ── API key ────────────────────────────────────────────────
function getApiKey() { return localStorage.getItem('av_api_key') || ''; }
function setApiKey(k) { localStorage.setItem('av_api_key', k.trim()); }

apiKeyInput.value = getApiKey();

saveApiKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) return showError('Please enter an API key.');
  setApiKey(key);
  saveApiKeyBtn.textContent = 'Saved ✓';
  setTimeout(() => { saveApiKeyBtn.textContent = 'Save'; }, 2000);
  clearMessages();
});

// ── Holdings cache ─────────────────────────────────────────
function cacheKey(ticker)      { return CACHE_PREFIX + ticker.toUpperCase(); }
function isFresh(entry)        { return entry && (Date.now() - new Date(entry.fetchedAt).getTime()) < CACHE_TTL_MS; }

// Normalize holdings from raw AV format {symbol, description, weight}
// to the processed format {asset, name, weightPercentage} the rest of the
// code depends on.  The bundled holdings-cache.json stores raw AV format,
// so this must be called whenever holdings are read back from localStorage.
function normalizeHoldings(holdings) {
  if (!Array.isArray(holdings) || !holdings.length) return holdings;
  if (holdings[0].asset !== undefined) return holdings; // already processed
  return holdings.map(h => ({
    asset:            (h.symbol || '').toUpperCase(),
    name:             h.description || '',
    weightPercentage: (parseFloat(h.weight) || 0) * 100,
  }));
}

function getCached(ticker)     {
  try {
    const entry = JSON.parse(localStorage.getItem(cacheKey(ticker)));
    if (!entry) return null;
    if (entry.holdings) entry.holdings = normalizeHoldings(entry.holdings);
    return entry;
  } catch { return null; }
}
function setCached(ticker, holdings) {
  localStorage.setItem(cacheKey(ticker), JSON.stringify({ holdings, fetchedAt: new Date().toISOString() }));
  renderCachePanel();
  renderOptEtfList();
}
function deleteCached(ticker)  { localStorage.removeItem(cacheKey(ticker)); }

function getAllCachedTickers() {
  const tickers = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) tickers.push(k.slice(CACHE_PREFIX.length));
  }
  return tickers.sort();
}

// ── Cache panel ────────────────────────────────────────────
function renderCachePanel() {
  const tickers = getAllCachedTickers();
  cacheBadge.textContent = `${tickers.length} ETF${tickers.length !== 1 ? 's' : ''}`;

  if (tickers.length === 0) {
    cachePanel.innerHTML = '<p class="empty-state" style="padding:1rem 0">No ETFs cached yet. Run Calculate Exposure to start building your cache.</p>';
    return;
  }

  const rows = tickers.map(ticker => {
    const entry   = getCached(ticker);
    const fresh   = isFresh(entry);
    const count   = entry?.holdings?.length ?? 0;
    const age     = entry?.fetchedAt ? relativeTime(new Date(entry.fetchedAt)) : '—';
    const cls     = fresh ? 'status-fresh' : 'status-stale';
    const label   = fresh ? 'fresh' : 'stale';
    return `
      <tr data-ticker="${escHtml(ticker)}">
        <td class="ticker-cell">${escHtml(ticker)}</td>
        <td>${count} holdings</td>
        <td>${age}</td>
        <td><span class="badge ${cls}">${label}</span></td>
        ${publicMode ? '' : `<td class="cache-row-actions">
          <button class="btn btn-ghost btn-xs cache-refresh" title="Re-fetch (costs 1 API call)">↻</button>
          <button class="btn btn-remove btn-xs cache-delete" title="Remove from cache">✕</button>
        </td>`}
      </tr>`;
  }).join('');

  cachePanel.innerHTML = `
    <table class="cache-table">
      <thead><tr><th>Ticker</th><th>Holdings</th><th>Cached</th><th>Status</th>${publicMode ? '' : '<th></th>'}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Wire up per-row buttons
  cachePanel.querySelectorAll('.cache-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const ticker = btn.closest('tr').dataset.ticker;
      deleteCached(ticker);
      renderCachePanel();
      refreshAllCacheIndicators();
    });
  });

  cachePanel.querySelectorAll('.cache-refresh').forEach(btn => {
    btn.addEventListener('click', async () => {
      const apiKey = getApiKey();
      if (!apiKey) { showError('Save your API key first.'); return; }
      const ticker = btn.closest('tr').dataset.ticker;
      btn.textContent = '…';
      btn.disabled = true;
      try {
        await fetchHoldings(ticker, apiKey, true);
        renderCachePanel();
        refreshAllCacheIndicators();
      } catch (e) {
        showError(`Refresh failed for ${ticker}: ${e.message}`);
      }
    });
  });
}

function relativeTime(date) {
  const diff = Date.now() - date.getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)   return 'just now';
  if (mins  < 60)  return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  return `${days}d ago`;
}

// ── Cache toggle ───────────────────────────────────────────
let cachePanelOpen = false;
toggleCacheBtn.addEventListener('click', () => {
  cachePanelOpen = !cachePanelOpen;
  cachePanel.classList.toggle('hidden', !cachePanelOpen);
  toggleCacheBtn.textContent = cachePanelOpen ? 'Hide ▴' : 'Show ▾';
});

// ── Export cache ───────────────────────────────────────────
exportCacheBtn.addEventListener('click', () => {
  const tickers = getAllCachedTickers();
  if (tickers.length === 0) { showError('Nothing in cache to export.'); return; }
  const holdings = {};
  tickers.forEach(t => { const e = getCached(t); if (e) holdings[t] = e; });
  const json = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), holdings }, null, 2);
  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([json], { type: 'application/json' })),
    download: `etfchef-cache-${new Date().toISOString().split('T')[0]}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Import cache ───────────────────────────────────────────
importCacheInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.holdings || typeof data.holdings !== 'object') throw new Error('Bad format');
      let imported = 0, skipped = 0;
      for (const [ticker, entry] of Object.entries(data.holdings)) {
        if (!entry.holdings || !entry.fetchedAt) continue;
        const existing = getCached(ticker);
        if (!existing || new Date(entry.fetchedAt) > new Date(existing.fetchedAt)) {
          localStorage.setItem(cacheKey(ticker), JSON.stringify(entry));
          imported++;
        } else {
          skipped++;
        }
      }
      renderCachePanel();
      refreshAllCacheIndicators();
      showSuccess(`Imported ${imported} ETF${imported !== 1 ? 's' : ''}${skipped ? ` (${skipped} skipped — existing data was newer)` : ''}.`);
    } catch {
      showError('Could not parse cache file. Make sure it was exported from ETFChef.');
    }
    importCacheInput.value = '';
  };
  reader.readAsText(file);
});

// ── Position management ────────────────────────────────────
function createPositionRow(id) {
  const row = document.createElement('div');
  row.className = 'position-row';
  row.dataset.id = id;

  row.innerHTML = `
    <div class="ticker-wrap">
      <input type="text" class="ticker-input" placeholder="e.g. SPY" maxlength="10" autocomplete="off" />
      <span class="cache-dot" title=""></span>
    </div>
    <select class="direction-select">
      <option value="long">↑ Long</option>
      <option value="short">↓ Short</option>
    </select>
    <div class="price-wrap">
      <span class="price-prefix">$</span>
      <input type="number" class="price-input" placeholder="Price" min="0" step="0.01" />
    </div>
    <input type="number" class="shares-input" placeholder="Shares" min="0" step="any" />
    <input type="number" class="value-input" placeholder="$ Value" min="0" step="any" />
    <button class="btn btn-remove" title="Remove">✕</button>
  `;

  const tickerInput = row.querySelector('.ticker-input');
  const direction   = row.querySelector('.direction-select');
  const priceInput  = row.querySelector('.price-input');
  const sharesInput = row.querySelector('.shares-input');
  const valueInput  = row.querySelector('.value-input');
  const removeBtn   = row.querySelector('.btn-remove');

  tickerInput.addEventListener('input', () => {
    tickerInput.value = tickerInput.value.toUpperCase();
    priceInput.value = '';
    valueInput.value = '';
    syncPosition(id);
    updateCacheDot(row, tickerInput.value.trim());
  });

  tickerInput.addEventListener('blur', async () => {
    const t = tickerInput.value.trim().toUpperCase();
    if (!t) return;
    await fetchPrice(t);
    if (priceCache[t]) {
      priceInput.value = priceCache[t].toFixed(2);
      syncPosition(id);
    }
    recalcPosition(id);
  });

  direction.addEventListener('change', () => syncPosition(id));

  sharesInput.addEventListener('input', () => {
    const pos = positions.find(p => p.id === id);
    if (pos) pos.lastEdited = 'shares';
    syncPosition(id);
    recalcPosition(id);
  });

  valueInput.addEventListener('input', () => {
    const pos = positions.find(p => p.id === id);
    if (pos) pos.lastEdited = 'value';
    syncPosition(id);
    recalcPosition(id);
  });

  priceInput.addEventListener('input', () => {
    syncPosition(id);
    recalcPosition(id);
  });

  removeBtn.addEventListener('click', () => removePosition(id));

  return row;
}

function recalcPosition(id) {
  const row = positionsList.querySelector(`[data-id="${id}"]`);
  if (!row) return;
  const pos = positions.find(p => p.id === id);
  if (!pos) return;
  const sharesEl = row.querySelector('.shares-input');
  const valueEl  = row.querySelector('.value-input');
  const priceEl  = row.querySelector('.price-input');

  // Auto-fill price input from cache whenever it's empty and cache has a value
  if (!priceEl.value && pos.ticker && priceCache[pos.ticker]) {
    priceEl.value = priceCache[pos.ticker].toFixed(2);
    pos.price = priceCache[pos.ticker];
  }

  const price = parseFloat(priceEl.value) || 0;

  if (pos.lastEdited === 'value') {
    const value = parseFloat(valueEl.value) || 0;
    if (price > 0 && value > 0) {
      sharesEl.value = (value / price).toFixed(4);
      pos.shares = parseFloat(sharesEl.value) || 0;
    } else {
      sharesEl.value = '';
      pos.shares = 0;
    }
  } else {
    const shares = parseFloat(sharesEl.value) || 0;
    if (price > 0 && shares > 0) {
      valueEl.value = (shares * price).toFixed(2);
    } else {
      valueEl.value = '';
    }
  }
}

function updateCacheDot(row, ticker) {
  const dot = row.querySelector('.cache-dot');
  if (!dot) return;
  if (!ticker) { dot.className = 'cache-dot'; dot.title = ''; return; }
  const entry = getCached(ticker);
  if (!entry) { dot.className = 'cache-dot dot-none'; dot.title = 'Not cached'; }
  else if (isFresh(entry)) { dot.className = 'cache-dot dot-fresh'; dot.title = `Cached ${relativeTime(new Date(entry.fetchedAt))}`; }
  else { dot.className = 'cache-dot dot-stale'; dot.title = `Stale cache (${relativeTime(new Date(entry.fetchedAt))})`; }
}

function updateAllPriceInputs() {
  positionsList.querySelectorAll('.position-row').forEach(row => {
    const id = parseInt(row.dataset.id);
    const pos = positions.find(p => p.id === id);
    if (!pos || !pos.ticker) return;
    const priceEl = row.querySelector('.price-input');
    if (!priceEl.value && priceCache[pos.ticker]) {
      priceEl.value = priceCache[pos.ticker].toFixed(2);
      syncPosition(id);
      recalcPosition(id);
    }
  });
}

function refreshAllCacheIndicators() {
  positionsList.querySelectorAll('.position-row').forEach(row => {
    const t = row.querySelector('.ticker-input')?.value.trim();
    if (t) updateCacheDot(row, t);
  });
}

function syncPosition(id) {
  const row       = positionsList.querySelector(`[data-id="${id}"]`);
  const ticker    = row.querySelector('.ticker-input').value.trim().toUpperCase();
  const direction = row.querySelector('.direction-select').value;
  const shares    = parseFloat(row.querySelector('.shares-input').value) || 0;
  const price     = parseFloat(row.querySelector('.price-input').value) || null;
  const pos = positions.find(p => p.id === id);
  if (pos) { pos.ticker = ticker; pos.direction = direction; pos.shares = shares; pos.price = price; }
}

function addPosition() {
  const id = nextId++;
  positions.push({ id, ticker: '', direction: 'long', shares: 0, price: null, lastEdited: 'shares' });
  const row = createPositionRow(id);
  positionsList.appendChild(row);
  row.querySelector('.ticker-input').focus();
}

function removePosition(id) {
  positions = positions.filter(p => p.id !== id);
  positionsList.querySelector(`[data-id="${id}"]`)?.remove();
}

function clearAll() {
  positions = [];
  positionsList.innerHTML = '';
  resultsSection.classList.add('hidden');
  clearMessages();
  allRows = [];
}

addPositionBtn.addEventListener('click', addPosition);
clearAllBtn.addEventListener('click', clearAll);
addPosition();

// ── Price fetch (Yahoo Finance) ─────────────────────────────
// Production: Netlify serverless function (server-to-server, no CORS issues)
// Local dev:  corsproxy.io CORS proxy fallback
const YF_BASE    = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YF_PROXY   = 'https://corsproxy.io/?';
const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';

async function fetchPrice(ticker) {
  if (priceCache[ticker] !== undefined) return priceCache[ticker];
  try {
    const yfUrl = `${YF_BASE}${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const fetchUrl = isLocalDev
      ? YF_PROXY + encodeURIComponent(yfUrl)
      : `/.netlify/functions/price?ticker=${encodeURIComponent(ticker)}`;
    const res   = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
    priceCache[ticker] = price;
    return price;
  } catch {
    priceCache[ticker] = null;
    return null;
  }
}


function fmtDollar(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMoney(n, showPlus = false) {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '−$' : (showPlus ? '+$' : '$');
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000)     return sign + (abs / 1_000).toFixed(1) + 'K';
  return sign + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Holdings fetch (cache-first) ───────────────────────────
async function fetchHoldings(ticker, apiKey, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = getCached(ticker);
    if (cached && isFresh(cached)) return cached.holdings;
  }

  const url  = `${API_BASE}?function=ETF_PROFILE&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${ticker}`);
  } catch (err) {
    // Network / HTTP failure — fall back to stale cache rather than losing data entirely
    const stale = getCached(ticker);
    if (stale?.holdings?.length) return stale.holdings;
    throw err;
  }
  const data = await res.json();

  if (data['Error Message'] || data['Information']) {
    // API-level error (rate limit, bad key, etc.) — fall back to stale cache
    const stale = getCached(ticker);
    if (stale?.holdings?.length) return stale.holdings;
    throw new Error(data['Error Message'] || data['Information']);
  }
  if (!data.holdings || !Array.isArray(data.holdings))
    throw new Error(`No holdings data returned for ${ticker}`);

  const holdings = data.holdings.map(h => ({
    asset:            (h.symbol || '').toUpperCase(),
    name:             h.description || '',
    weightPercentage: (parseFloat(h.weight) || 0) * 100,
  }));

  setCached(ticker, holdings);
  return holdings;
}

// ── Calculation ────────────────────────────────────────────
function calcExposure(holdingsMap, positions) {
  const exposure = {};
  for (const pos of positions) {
    const { ticker: etf, direction, shares } = pos;
    if (!holdingsMap[etf]) continue;
    const mult     = direction === 'long' ? 1 : -1;
    const etfPrice = pos.price ?? priceCache[etf] ?? 0;
    for (const h of holdingsMap[etf]) {
      const underlying = (h.asset || '').toUpperCase();
      if (!underlying || underlying === 'N/A') continue; // skip non-tradeable / no-symbol entries
      const weight       = parseFloat(h.weightPercentage) || 0;
      const contribution = mult * shares * etfPrice * (weight / 100);
      if (!exposure[underlying]) exposure[underlying] = { name: h.name || '', netDollars: 0, sources: [] };
      exposure[underlying].netDollars += contribution;
      exposure[underlying].sources.push({ etf, direction, contribution, shares, weight });
    }
  }
  return exposure;
}

// ── Render results ─────────────────────────────────────────
function renderResults(exposure) {
  allRows = Object.entries(exposure)
    .map(([ticker, d]) => ({ ticker, name: d.name, netDollars: d.netDollars, direction: d.netDollars >= 0 ? 'long' : 'short', sources: d.sources }))
    .sort((a, b) => Math.abs(b.netDollars) - Math.abs(a.netDollars));

  const totalLong  = allRows.filter(r => r.netDollars > 0).reduce((s, r) => s + r.netDollars, 0);
  const totalShort = allRows.filter(r => r.netDollars < 0).reduce((s, r) => s + r.netDollars, 0);
  const gross      = totalLong + Math.abs(totalShort);
  const net        = totalLong + totalShort;

  summaryCards.innerHTML = `
    <div class="card"><div class="card-label">Total Long Exposure</div><div class="card-value long">${fmtMoney(totalLong, true)}</div></div>
    <div class="card"><div class="card-label">Total Short Exposure</div><div class="card-value short">${fmtMoney(totalShort)}</div></div>
    <div class="card"><div class="card-label">Gross Exposure</div><div class="card-value">${fmtMoney(gross)}</div></div>
    <div class="card"><div class="card-label">Net Exposure</div><div class="card-value ${net >= 0 ? 'long' : 'short'}">${fmtMoney(net, net >= 0)}</div></div>`;

  const posCount = positions.filter(p => p.ticker).length;
  resultsMeta.textContent = `${allRows.length} unique stocks · ${posCount} ETF position${posCount !== 1 ? 's' : ''}`;
  resultsSection.classList.remove('hidden');
  applyFilterAndSearch();
}

function fmt(n) {
  const abs = Math.abs(n), sign = n < 0 ? '−' : '';
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000)     return sign + (abs / 1_000).toFixed(1) + 'K';
  return sign + abs.toFixed(2);
}

function applyFilterAndSearch() {
  const q = stockSearch.value.trim().toLowerCase();
  let rows = allRows;
  if (activeFilter === 'long')  rows = rows.filter(r => r.netDollars >  0);
  if (activeFilter === 'short') rows = rows.filter(r => r.netDollars <  0);
  if (q) rows = rows.filter(r => r.ticker.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  rows = [...rows].sort((a, b) => b.netDollars - a.netDollars);
  renderChart(rows);
}

function renderChart(rows) {
  if (rows.length === 0) {
    resultsChart.innerHTML = '<div class="empty-state">No results found.</div>';
    return;
  }
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.netDollars)));
  resultsChart.innerHTML = rows.map(r => {
    const cls    = r.netDollars >= 0 ? 'long' : 'short';
    const barW   = (Math.abs(r.netDollars) / maxAbs * 100).toFixed(1);
    const sources = [...new Set(r.sources.map(s => s.etf))].map(e => `<span class="source-tag">${e}</span>`).join('');
    return `
    <div class="exp-bar-row">
      <div class="exp-bar-ticker" title="${escHtml(r.name)}">${escHtml(r.ticker)}</div>
      <div class="exp-bar-track">
        <div class="exp-bar-fill ${cls}" style="width:${barW}%"></div>
      </div>
      <div class="exp-bar-value ${cls}">${fmtMoney(r.netDollars, r.netDollars >= 0)}</div>
      <div class="exp-bar-sources">${sources}</div>
    </div>`;
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Filter / search ────────────────────────────────────────
filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    filterTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeFilter = tab.dataset.filter;
    applyFilterAndSearch();
  });
});

stockSearch.addEventListener('input', applyFilterAndSearch);

// ── Calculate ──────────────────────────────────────────────
calculateBtn.addEventListener('click', async () => {
  clearMessages();

  const apiKey = getApiKey();
  if (!publicMode && !apiKey) { showError('Please enter and save your Alpha Vantage API key above.'); return; }

  const validPositions = positions.filter(p => p.ticker && p.shares > 0);
  if (validPositions.length === 0) { showError('Add at least one position with a ticker and share count.'); return; }

  const uniqueTickers = [...new Set(validPositions.map(p => p.ticker))];

  // Split into three buckets: no data at all / stale (usable) / fresh
  const missing   = uniqueTickers.filter(t => !getCached(t));
  const stale     = uniqueTickers.filter(t => { const c = getCached(t); return c && !isFresh(c); });
  const fromCache = uniqueTickers.filter(t => { const c = getCached(t); return c && isFresh(c); });
  const toFetch   = missing; // stale data is still usable; only truly missing needs an API call

  if (publicMode && missing.length > 0) {
    showError(`Holdings data not available for: ${missing.join(', ')}.\nThis site uses pre-loaded ETF data. Only the ETFs listed in the cache panel are supported.`);
    return;
  }

  const staleNote = stale.length > 0 ? ` · ${stale.join(', ')} using cached data (>7 days old)` : '';
  if (toFetch.length === 0) {
    showSuccess(`All ${uniqueTickers.length} ETF${uniqueTickers.length !== 1 ? 's' : ''} served from cache — 0 API calls used.${staleNote}`);
  } else {
    showLoading(`Fetching ${toFetch.join(', ')}… (${fromCache.length + stale.length} from cache)`);
  }

  try {
    const holdingsMap = {};
    const errors = [];

    for (const ticker of uniqueTickers) {
      const cached = getCached(ticker);
      if (cached?.holdings?.length) {
        // Use any cached data (fresh or stale) — avoids unnecessary API calls
        holdingsMap[ticker] = cached.holdings;
        continue;
      }
      try {
        updateLoadingMessage(`Fetching ${ticker}…`);
        holdingsMap[ticker] = await fetchHoldings(ticker, apiKey);
      } catch (err) {
        errors.push(`${ticker}: ${err.message}`);
        holdingsMap[ticker] = [];
      }
    }

    // Ensure prices are fetched for all ETFs (needed for dollar exposure)
    const missingPrices = uniqueTickers.filter(t => priceCache[t] === undefined);
    for (const ticker of missingPrices) {
      updateLoadingMessage(`Fetching price for ${ticker}…`);
      await fetchPrice(ticker);
    }
    const noPrices = uniqueTickers.filter(t => !priceCache[t]);
    if (noPrices.length > 0)
      showError(`Could not fetch price for: ${noPrices.join(', ')} — enter the price manually in the position row, or dollar exposure will be $0.`);

    updateAllPriceInputs();

    hideLoading();
    renderCachePanel();
    refreshAllCacheIndicators();

    if (errors.length > 0) showError(`Errors:\n${errors.join('\n')}`);

    const diagnostics  = uniqueTickers.map(t => `${t}: ${holdingsMap[t]?.length ?? 0}`);
    const emptyTickers = uniqueTickers.filter(t => !holdingsMap[t]?.length);
    const exposure     = calcExposure(holdingsMap, validPositions);

    if (Object.keys(exposure).length === 0) {
      showError(publicMode
        ? `No holdings data returned (${diagnostics.join(' · ')}).\nMake sure your ETF tickers match ones in the pre-loaded cache (e.g. SPY, QQQ, IWM).`
        : `No holdings data returned (${diagnostics.join(' · ')}).\n\nPossible causes:\n• Invalid or missing Alpha Vantage API key\n• Daily limit reached (25 calls/day on free tier)\n• Ticker not recognised as an ETF by Alpha Vantage (e.g. try SPY, QQQ, IWM)`
      );
      return;
    }

    if (emptyTickers.length > 0)
      showError(`No holdings found for: ${emptyTickers.join(', ')} — those positions were skipped.`);

    const cachedCount  = fromCache.length + stale.length;
    const fetchedCount = toFetch.length - errors.length;
    if (toFetch.length > 0 && !errors.length)
      showSuccess(`${fetchedCount > 0 ? `Fetched ${fetchedCount} ETF${fetchedCount !== 1 ? 's' : ''} from API · ` : ''}${cachedCount > 0 ? `${cachedCount} from cache · ` : ''}${fetchedCount} API call${fetchedCount !== 1 ? 's' : ''} used today.${staleNote}`);

    renderResults(exposure);
    renderNaNotice(document.getElementById('basketNaNotice'), uniqueTickers);

  } catch (err) {
    hideLoading();
    showError(`Unexpected error: ${err.message}`);
  }
});

// ── Helpers ────────────────────────────────────────────────
function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove('hidden');
}

function showSuccess(msg) {
  successBanner.textContent = msg;
  successBanner.classList.remove('hidden');
}

function clearMessages() {
  errorBanner.textContent = '';
  errorBanner.classList.add('hidden');
  successBanner.textContent = '';
  successBanner.classList.add('hidden');
}

function showLoading(msg) {
  loadingMessage.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}

function updateLoadingMessage(msg) { loadingMessage.textContent = msg; }
function hideLoading()             { loadingOverlay.classList.add('hidden'); }

// ── Exposure Optimization ──────────────────────────────────
let optSelectedEtfs = new Set();

function renderOptEtfList() {
  const listEl  = document.getElementById('optEtfList');
  const badgeEl = document.getElementById('optCacheBadge');
  const tickers = getAllCachedTickers(); // already alphabetical

  badgeEl.textContent = `${tickers.length} ETF${tickers.length !== 1 ? 's' : ''}`;

  if (tickers.length === 0) {
    listEl.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;text-align:left">No ETFs cached yet. Add holdings via the Custom Basket Exposure tab.</p>';
    optSelectedEtfs.clear();
    return;
  }

  // Keep previously selected ones; auto-select any new tickers
  tickers.forEach(t => optSelectedEtfs.add(t));
  // Remove any that were deleted from cache
  for (const t of optSelectedEtfs) { if (!tickers.includes(t)) optSelectedEtfs.delete(t); }

  listEl.innerHTML = tickers.map(t => {
    const count = getCached(t)?.holdings?.length ?? 0;
    const sel   = optSelectedEtfs.has(t);
    return `<button class="opt-etf-chip${sel ? ' selected' : ''}" data-ticker="${escHtml(t)}" title="${count} holdings">${escHtml(t)}</button>`;
  }).join('');

  listEl.querySelectorAll('.opt-etf-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const t = chip.dataset.ticker;
      if (optSelectedEtfs.has(t)) { optSelectedEtfs.delete(t); chip.classList.remove('selected'); }
      else                         { optSelectedEtfs.add(t);    chip.classList.add('selected');    }
    });
  });

  renderNaNotice(document.getElementById('optNaNotice'), tickers);
}

// ── N/A holdings notice ────────────────────────────────────
// Returns ETFs (from the given list) that contain holdings with no US
// ticker symbol (symbol = "n/a" in raw AV data → asset = "N/A" after
// normalization), along with the total excluded weight.
function getNaExcludedInfo(etfList) {
  const affected = [];
  for (const ticker of etfList) {
    const entry = getCached(ticker);
    if (!entry?.holdings) continue;
    const naEntries = entry.holdings.filter(h => h.asset === 'N/A' && h.weightPercentage > 0);
    if (!naEntries.length) continue;
    const totalWeight = naEntries.reduce((s, h) => s + h.weightPercentage, 0);
    affected.push({ ticker, entries: naEntries, totalWeight });
  }
  return affected.sort((a, b) => b.totalWeight - a.totalWeight);
}

function renderNaNotice(containerEl, etfList) {
  if (!containerEl) return;
  const affected = getNaExcludedInfo(etfList || []);
  if (!affected.length) { containerEl.classList.add('hidden'); return; }

  const lines = affected.map(({ ticker, entries, totalWeight }) => {
    const detail = entries.map(e => `${escHtml(e.name)} ${e.weightPercentage.toFixed(2)}%`).join(', ');
    return `<li><strong>${escHtml(ticker)}</strong> — ${totalWeight.toFixed(2)}% excluded (${detail})</li>`;
  }).join('');

  containerEl.innerHTML = `
    <div class="na-notice-title">⚠ International &amp; non-equity holdings excluded</div>
    The following ETFs contain holdings without a US ticker symbol that are not incorporated into calculations:
    <ul>${lines}</ul>`;
  containerEl.classList.remove('hidden');
}

// ── Continuous-weight optimizer ────────────────────────────
// Leg sizes are continuous weights solved by a small linear program rather
// than the old fixed equal-weight (±1/k) enumeration. ETF selection is
// greedy forward selection, so cost grows linearly with the number of
// selected ETFs instead of exponentially with max legs.
//
//   absolute mode:  max targetExp  s.t. |exp_j| ≤ cap_j (j ≠ target),
//                                       Σ|w_i| ≤ 1
//   relative mode:  max targetExp  s.t. |exp_j| ≤ 1 — the ratio
//                   targetExp/maxOther is scale-invariant, so maximizing
//                   with "other" normalized to 1 maximizes the ratio; the
//                   solution is then rescaled to respect gross ≤ 1 and
//                   the absolute caps.

// Primal simplex for  max c·x  s.t.  A·x ≤ b, x ≥ 0  with all b ≥ 0
// (slack basis is feasible, so no phase-1 needed). Bland's rule — immune
// to cycling; problems here are tiny so its slower pivoting cost is moot.
// Returns the solution vector x, or null if unbounded.
function simplexMax(c, A, b) {
  const m = A.length, n = c.length, W = n + m + 1;
  const T = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(W);
    row.set(A[i]);
    row[n + i] = 1;
    row[W - 1] = b[i];
    T.push(row);
  }
  const obj = new Float64Array(W);
  for (let j = 0; j < n; j++) obj[j] = -c[j];
  T.push(obj);

  const basis = new Int32Array(m);
  for (let i = 0; i < m; i++) basis[i] = n + i;

  const EPS = 1e-9;
  for (let iter = 0; iter < 600; iter++) {
    let col = -1;
    for (let j = 0; j < W - 1; j++) if (T[m][j] < -EPS) { col = j; break; }
    if (col === -1) break; // optimal

    let row = -1, minRatio = Infinity;
    for (let i = 0; i < m; i++) {
      const a = T[i][col];
      if (a > EPS) {
        const r = T[i][W - 1] / a;
        if (r < minRatio - EPS || (r < minRatio + EPS && row !== -1 && basis[i] < basis[row])) {
          minRatio = r; row = i;
        }
      }
    }
    if (row === -1) return null; // unbounded

    const pr = T[row], pv = pr[col];
    for (let j = 0; j < W; j++) pr[j] /= pv;
    for (let i = 0; i <= m; i++) {
      if (i === row) continue;
      const f = T[i][col];
      if (f !== 0) for (let j = 0; j < W; j++) T[i][j] -= f * pr[j];
    }
    basis[row] = col;
  }

  const x = new Float64Array(n);
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][W - 1];
  return x;
}

// Solve optimal continuous weights for a fixed set of ETFs (the "support").
// Residual caps are enforced lazily (cutting planes): solve with the rows
// found so far, sweep the full exposure vector for violations, add the
// worst offenders as new rows, repeat. The final active set is tiny, so
// each LP stays a few dozen rows regardless of how many tickers the ETFs
// hold. Weights are free-sign via the u−v split, so long/short directions
// come out of the solve — no sign enumeration.
function solveSupport(ctx, support) {
  const k = support.length, n = 2 * k;
  const vecs = support.map(e => ctx.etfVecs[e]);
  const { N, targetI, lims, scratch: exp } = ctx;
  const relative = ctx.mode === 'relative';
  // Relative solve is scale-free: the ratio optimum is where the maxOther
  // normalization (|exp_j| ≤ 1) binds, not the gross bound. Start gross
  // small and escalate if it binds first (well-hedged combos have tiny
  // residuals per unit of gross, so the normalization can sit far out).
  let grossMax = relative ? 10 : 1;

  // objective: maximize target exposure; w_i split as u_i − v_i (both ≥ 0)
  const c = new Float64Array(n);
  for (let i = 0; i < k; i++) { c[i] = vecs[i][targetI]; c[k + i] = -vecs[i][targetI]; }

  const A = [], b = [];
  const addRow = (coef, rhs) => {
    const row = new Float64Array(n);
    for (let i = 0; i < k; i++) { const a = coef(i); row[i] = a; row[k + i] = -a; }
    A.push(row); b.push(rhs);
  };
  A.push(new Float64Array(n).fill(1)); // gross: Σ(u+v) ≤ grossMax
  b.push(grossMax);

  const capAdded = new Set(), reqAdded = new Set();
  const w = new Float64Array(k);

  for (let round = 0; round < 24; round++) {
    const x = simplexMax(c, A, b);
    if (!x) return null;
    for (let i = 0; i < k; i++) w[i] = x[i] - x[k + i];

    exp.fill(0);
    for (let i = 0; i < k; i++) {
      const wi = w[i];
      if (wi === 0) continue;
      const v = vecs[i];
      for (let j = 0; j < N; j++) exp[j] += wi * v[j];
    }
    const targetExp = exp[targetI];

    const viols = [];
    for (let j = 0; j < N; j++) {
      if (j === targetI) continue;
      const a = Math.abs(exp[j]);
      const lim = relative ? 1 : lims[j];
      if (a > lim + 1e-7 && !capAdded.has(j)) viols.push([j, a - lim, false]);
      if (ctx.requireMax && a > targetExp + 1e-7 && !reqAdded.has(j)) viols.push([j, a - targetExp, true]);
    }

    if (viols.length === 0) {
      let gross = 0;
      for (let i = 0; i < k; i++) gross += Math.abs(w[i]);
      let maxOther = 0;
      for (let j = 0; j < N; j++) {
        if (j !== targetI && Math.abs(exp[j]) > maxOther) maxOther = Math.abs(exp[j]);
      }
      // Relative mode: if the gross bound bound the solve instead of the
      // maxOther normalization, the answer isn't ratio-optimal yet — widen
      // the gross bound and continue (cut rows carry over).
      if (relative && gross > grossMax * 0.999 && maxOther < 0.999 && grossMax < 1e7) {
        grossMax *= 100;
        b[0] = grossMax;
        continue;
      }
      const out = { w: Float64Array.from(w), exp: Float64Array.from(exp), targetExp, gross, maxOther };
      if (relative) rescaleRelative(ctx, out);
      out.ratio = out.maxOther > 1e-12 ? out.targetExp / out.maxOther : Infinity;
      return out;
    }

    viols.sort((p, q) => q[1] - p[1]);
    for (const [j, , isReq] of viols.slice(0, 12)) {
      if (isReq) {
        reqAdded.add(j);
        addRow(i => vecs[i][j] - vecs[i][targetI], 0);
        addRow(i => -vecs[i][j] - vecs[i][targetI], 0);
      } else {
        capAdded.add(j);
        const lim = relative ? 1 : lims[j];
        addRow(i => vecs[i][j], lim);
        addRow(i => -vecs[i][j], lim);
      }
    }
  }
  return null; // didn't converge — caller skips this support
}

// Relative-mode solutions come out normalized to maxOther = 1; scale the
// whole position (ratio is unchanged along the ray) to the largest size
// that respects the gross budget, the global cap, and per-ticker caps.
function rescaleRelative(ctx, out) {
  let scale = out.gross > 1e-12 ? 1 / out.gross : 1;
  if (out.maxOther > 1e-12) scale = Math.min(scale, ctx.cap / out.maxOther);
  for (const [tk, lim] of Object.entries(tickerCaps)) {
    const j = ctx.tickerIdx[tk];
    if (j !== undefined && j !== ctx.targetI) {
      const a = Math.abs(out.exp[j]);
      if (a > 1e-12) scale = Math.min(scale, lim / a);
    }
  }
  if (scale === 1) return;
  for (let i = 0; i < out.w.length; i++) out.w[i] *= scale;
  for (let j = 0; j < out.exp.length; j++) out.exp[j] *= scale;
  out.targetExp *= scale;
  out.gross     *= scale;
  out.maxOther  *= scale;
}

// Greedy forward selection: start from the best seed, then repeatedly add
// the ETF whose optimal re-solve improves the objective most. Stops at
// maxLegs or when the best addition improves the objective by <1% — the
// anti-degeneracy guard that keeps answers tradeable instead of piling on
// sliver legs for the last decimal.
function optimizeContinuous(ctx, available, targetEtfs, maxLegs) {
  const MIN_IMPROVE = 0.01;
  const scoreOf = r => ctx.mode === 'relative' ? r.ratio : r.targetExp;

  const evalBest = (supports) => {
    let best = null, bestSup = null;
    for (const sup of supports) {
      const res = solveSupport(ctx, sup);
      if (!res || res.targetExp <= 1e-9) continue;
      if (!best || scoreOf(res) > scoreOf(best)) { best = res; bestSup = sup; }
    }
    return best ? { res: best, sup: bestSup } : null;
  };

  // Seed with the best single ETF; with "target must be max exposure" a
  // single ETF is often infeasible (another holding outweighs the target),
  // so fall back to seeding with the best (target ETF, hedge) pair.
  let seed = evalBest(targetEtfs.map(e => [e]));
  if (!seed && maxLegs >= 2) {
    const pairs = [];
    for (const t of targetEtfs) {
      for (const e of available) if (e !== t) pairs.push([t, e]);
    }
    seed = evalBest(pairs);
  }

  // "Target must be max exposure" is scale-free, so for mid-weight stocks
  // no support smaller than 3-4 legs is feasible at ANY size and the seeds
  // above all fail. Bootstrap: grow a support on the unconstrained ratio
  // objective — ratio > 1 is exactly "the requirement is satisfiable" —
  // then hand that support to the real constrained solve.
  if (!seed && ctx.requireMax && maxLegs >= 2) {
    const feasCtx = { ...ctx, mode: 'relative', requireMax: false };
    let sup = null, ratio = -Infinity;
    for (const t of targetEtfs) {
      const r = solveSupport(feasCtx, [t]);
      if (r && r.ratio > ratio) { ratio = r.ratio; sup = [t]; }
    }
    while (sup && ratio <= 1 + 1e-6 && sup.length < maxLegs) {
      let bSup = null, bRatio = ratio;
      for (const e of available) {
        if (sup.includes(e)) continue;
        const r = solveSupport(feasCtx, sup.concat(e));
        if (r && r.ratio > bRatio) { bRatio = r.ratio; bSup = sup.concat(e); }
      }
      if (!bSup) break;
      sup = bSup;
      ratio = bRatio;
    }
    if (sup && ratio > 1 + 1e-6) {
      const res = solveSupport(ctx, sup);
      if (res && res.targetExp > 1e-9) seed = { res, sup };
    }
  }
  if (!seed) return null;

  let support = seed.sup, cur = seed.res;

  while (support.length < maxLegs) {
    const cands = available.filter(e => !support.includes(e)).map(e => support.concat(e));
    const nxt = evalBest(cands);
    if (!nxt || !(scoreOf(nxt.res) > scoreOf(cur) * (1 + MIN_IMPROVE))) break;
    support = nxt.sup;
    cur = nxt.res;
  }

  // Prune untradeable slivers (<0.5% of capital) and re-solve once
  const keep = support.filter((_, i) => Math.abs(cur.w[i]) >= 0.005);
  if (keep.length > 0 && keep.length < support.length) {
    const pruned = solveSupport(ctx, keep);
    if (pruned && pruned.targetExp > 1e-9 && scoreOf(pruned) >= scoreOf(cur) * 0.99) {
      support = keep;
      cur = pruned;
    }
  }

  return { support, w: cur.w, exp: cur.exp, targetExp: cur.targetExp,
           gross: cur.gross, maxOther: cur.maxOther, ratio: cur.ratio };
}

function runOptimization() {
  const target        = document.getElementById('optTarget').value.trim().toUpperCase();
  const maxOtherPct   = parseFloat(document.getElementById('optMaxExp').value) || 5;
  const maxLegs       = Math.max(1, parseInt(document.getElementById('optMaxLegs').value) || 4);
  const portfolio     = parseFloat(document.getElementById('optPortfolio').value) || 100000;
  const requireMaxExp  = document.getElementById('optRequireMax').checked;
  const optimizeMode   = document.querySelector('input[name="optMode"]:checked').value;
  const errEl      = document.getElementById('optError');
  const resEl      = document.getElementById('optResults');

  errEl.classList.add('hidden');
  resEl.classList.add('hidden');

  if (!target) { errEl.textContent = 'Enter a target ticker.'; errEl.classList.remove('hidden'); return; }

  const etfList = [...optSelectedEtfs];
  if (etfList.length === 0) { errEl.textContent = 'No ETFs selected.'; errEl.classList.remove('hidden'); return; }

  // Build holdings map from cache
  const holdingsMap = {};
  for (const etf of etfList) {
    const cached = getCached(etf);
    if (cached?.holdings?.length) holdingsMap[etf] = cached.holdings;
  }

  const available = Object.keys(holdingsMap);
  if (available.length === 0) { errEl.textContent = 'No cached holdings found for selected ETFs.'; errEl.classList.remove('hidden'); return; }

  const targetInAny = available.some(etf => holdingsMap[etf].some(h => h.asset.toUpperCase() === target));
  if (!targetInAny) {
    errEl.textContent = `${target} not found in any cached ETF holdings. Make sure it's a constituent of one of the selected ETFs.`;
    errEl.classList.remove('hidden');
    return;
  }

  const cap = maxOtherPct / 100;

  // ── Pre-compute typed arrays for fast inner-loop arithmetic ───────────
  // JS dict hash-map ops are ~10× slower than typed-array indexing.
  // Build a global ticker → integer index map, then store each ETF's
  // holding weights as Float64Array.  The inner loop becomes pure array
  // arithmetic and a single linear sweep for feasibility.
  const tickerSet = new Set();
  for (const etf of available) {
    for (const h of holdingsMap[etf]) {
      if (h.asset && h.asset !== 'N/A') tickerSet.add(h.asset);
    }
  }
  const tickers   = [...tickerSet];
  const tickerIdx = {};
  tickers.forEach((t, i) => { tickerIdx[t] = i; });
  const N         = tickers.length;
  const targetI   = tickerIdx[target]; // integer index of target ticker

  const etfVecs = {}; // etf → Float64Array(N) of (weight/100) values
  for (const etf of available) {
    const vec = new Float64Array(N);
    for (const h of holdingsMap[etf]) {
      const idx = tickerIdx[h.asset];
      if (idx !== undefined) vec[idx] = h.weightPercentage / 100;
    }
    etfVecs[etf] = vec;
  }

  // ETFs that contain the target — the greedy search must seed from one
  const targetEtfs = available.filter(etf => etfVecs[etf][targetI] > 0);

  // Per-ticker exposure limits: global cap, tightened by user overrides
  const lims = new Float64Array(N).fill(cap);
  for (const [tk, v] of Object.entries(tickerCaps)) {
    const j = tickerIdx[tk];
    if (j !== undefined) lims[j] = Math.min(cap, v);
  }

  const ctx = {
    etfVecs, tickers, tickerIdx, N, targetI, lims,
    mode: optimizeMode, cap, requireMax: requireMaxExp,
    scratch: new Float64Array(N),
  };

  const result = optimizeContinuous(ctx, available, targetEtfs, maxLegs);

  if (!result || result.targetExp <= 1e-9) {
    errEl.textContent = `No feasible portfolio found for ${target} with those constraints. Try increasing "Max Other Exposure" or "Max Legs".`;
    errEl.classList.remove('hidden');
    return;
  }

  const legs = result.support
    .map((etf, i) => ({ etf, dir: result.w[i] >= 0 ? 1 : -1, weight: Math.abs(result.w[i]) }))
    .filter(l => l.weight > 1e-9);
  const exp = {};
  for (let j = 0; j < N; j++) {
    if (Math.abs(result.exp[j]) > 1e-9) exp[tickers[j]] = result.exp[j];
  }

  renderOptResults(
    { legs, exp, targetExp: result.targetExp, ratio: result.ratio, gross: result.gross },
    target, maxOtherPct, portfolio
  );
}

function renderOptResults(result, target, maxOtherPct, portfolio) {
  const legsData = result.legs.map(l => ({ ...l, dollars: l.weight * portfolio }));

  // Store for porting to Historical Spread tab
  lastOptLegs = legsData.map(l => ({ etf: l.etf, dir: l.dir > 0 ? 'long' : 'short', dollars: l.dollars }));

  const legsHtml = legsData.map(l => {
    const dir      = l.dir > 0 ? 'long' : 'short';
    const dirLabel = l.dir > 0 ? '↑ Long' : '↓ Short';
    const price    = priceCache[l.etf];
    const shares   = price ? Math.round(l.dollars / price) : null;
    const sharesStr = shares !== null
      ? `<span class="opt-leg-shares">≈ ${shares.toLocaleString()} shares @ $${price.toFixed(2)}</span>`
      : '';
    return `
    <div class="opt-leg ${dir}">
      <div class="opt-leg-top">
        <span class="opt-leg-dir">${dirLabel}</span>
        <span class="opt-leg-ticker">${escHtml(l.etf)}</span>
      </div>
      <div class="opt-leg-amount">${fmtMoney(l.dollars)}</div>
      <span class="opt-leg-weight">${(l.weight * 100).toFixed(1)}% of capital</span>
      ${sharesStr}
    </div>`;
  }).join('');

  // Cash chip when the solver leaves capital undeployed (caps bind first)
  const cash = Math.max(0, 1 - (result.gross ?? 1));
  const cashHtml = cash > 0.005 ? `
    <div class="opt-leg cash">
      <div class="opt-leg-top">
        <span class="opt-leg-dir">◦ Uninvested</span>
        <span class="opt-leg-ticker">CASH</span>
      </div>
      <div class="opt-leg-amount">${fmtMoney(cash * portfolio)}</div>
      <span class="opt-leg-weight">${(cash * 100).toFixed(1)}% of capital</span>
    </div>` : '';

  const targetPct  = (result.targetExp * 100).toFixed(2);
  const ratioLabel = result.ratio != null && isFinite(result.ratio)
    ? `<div class="card-ratio">${result.ratio.toFixed(2)}× nearest holding</div>`
    : '';

  // Residual summary — how much of the result is the thing asked for
  const unwanted = Object.entries(result.exp)
    .reduce((s, [t, v]) => t === target ? s : s + Math.abs(v), 0);
  const purity = result.targetExp + unwanted > 0
    ? result.targetExp / (result.targetExp + unwanted)
    : 0;
  const summaryHtml = `
    <div class="opt-summary">
      <div class="opt-summary-item">
        <div class="v">${(purity * 100).toFixed(0)}%</div>
        <div class="l">purity — share of gross stock exposure that is ${escHtml(target)}</div>
      </div>
      <div class="opt-summary-item">
        <div class="v">${(unwanted * 100).toFixed(2)}%</div>
        <div class="l">unwanted — all off-target exposure combined</div>
      </div>
      ${cash > 0.005 ? `
      <div class="opt-summary-item">
        <div class="v">${(cash * 100).toFixed(1)}%</div>
        <div class="l">cash — undeployed, caps bind before capital runs out</div>
      </div>` : ''}
    </div>`;

  const rows = Object.entries(result.exp)
    .map(([ticker, v]) => ({ ticker, pct: v * 100 }))
    .sort((a, b) => b.pct - a.pct);

  const maxAbs = Math.max(...rows.map(r => Math.abs(r.pct)));

  const chartRows = rows.map(r => {
    const isTarget = r.ticker === target;
    const cls      = r.pct >= 0 ? 'long' : 'short';
    const sign     = r.pct >= 0 ? '+' : '';
    const barW     = (Math.abs(r.pct) / maxAbs * 100).toFixed(1);
    return `
    <div class="exp-bar-row${isTarget ? ' target-row' : ''}">
      <div class="exp-bar-ticker">${escHtml(r.ticker)}${isTarget ? ' ★' : ''}</div>
      <div class="exp-bar-track">
        <div class="exp-bar-fill ${cls}" style="width:${barW}%"></div>
      </div>
      <div class="exp-bar-value ${cls}">${sign}${r.pct.toFixed(2)}%</div>
    </div>`;
  }).join('');

  document.getElementById('optResultsContent').innerHTML = `
    <div class="opt-legs-row">${legsHtml}${cashHtml}</div>
    <div class="opt-target-card">
      <div class="card-label">${escHtml(target)} Exposure (optimized weights)</div>
      <div class="card-value">+${targetPct}%</div>
      ${ratioLabel}
    </div>
    ${summaryHtml}
    <p class="opt-constraint-note">${rows.length - 1} other stock${rows.length - 1 !== 1 ? 's' : ''} capped at ≤${maxOtherPct}% · ${result.legs.length} leg${result.legs.length !== 1 ? 's' : ''}</p>
    <div class="exp-chart">${chartRows}</div>
    <button class="btn btn-secondary" id="portToHistBtn" style="margin-top:1.25rem">→ Simulate in Historical Spread</button>`;

  document.getElementById('optResults').classList.remove('hidden');
  document.getElementById('portToHistBtn').addEventListener('click', portOptToHistorical);
}

// ── Port optimization result to Historical Spread ──────────
function portOptToHistorical() {
  if (!lastOptLegs || lastOptLegs.length === 0) return;

  // Clear existing hist legs from DOM and state
  const list = document.getElementById('histLegsList');
  list.innerHTML = '';
  histLegs = [];
  histNextId = 1;

  // Add one row per optimized leg
  lastOptLegs.forEach(l => {
    const id = histNextId++;
    histLegs.push({ id, ticker: l.etf, direction: l.dir, amount: Math.round(l.dollars) });
    const row = createHistLegRow(id);
    list.appendChild(row);
    row.querySelector('.hist-leg-ticker').value = l.etf;
    row.querySelector('.hist-leg-dir').value    = l.dir;
    row.querySelector('.hist-leg-amount').value = Math.round(l.dollars);
  });

  // Switch to Historical Spread tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const histBtn = document.querySelector('.tab-btn[data-tab="historical"]');
  histBtn.classList.add('active');
  document.getElementById('tab-historical').classList.remove('hidden');
  histBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Per-ticker caps ────────────────────────────────────────
function renderTickerCaps() {
  const el = document.getElementById('optTickerCaps');
  const caps = Object.entries(tickerCaps);
  if (caps.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = caps.map(([t, v]) =>
    `<span class="cap-tag">↓ ${escHtml(t)} ≤${(v * 100).toFixed(1)}% <button class="cap-remove" data-t="${escHtml(t)}">✕</button></span>`
  ).join('');
  el.querySelectorAll('.cap-remove').forEach(btn => {
    btn.addEventListener('click', () => { delete tickerCaps[btn.dataset.t]; renderTickerCaps(); });
  });
}

// ── Bar popup ──────────────────────────────────────────────
const barPopup       = document.getElementById('barPopup');
const barPopupTicker = document.getElementById('barPopupTicker');
const barPopupPct    = document.getElementById('barPopupPct');
const barPopupCapInput = document.getElementById('barPopupCapInput');
let barPopupCurrentTicker = null;

function showBarPopup(ticker, pctText, anchorEl) {
  barPopupCurrentTicker = ticker;
  barPopupTicker.textContent = ticker;
  barPopupPct.textContent = pctText;
  barPopup.classList.remove('hidden');

  // Position below the clicked row
  const rect = anchorEl.getBoundingClientRect();
  const popupW = 260;
  let left = rect.left;
  if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
  barPopup.style.top  = (rect.bottom + 6) + 'px';
  barPopup.style.left = Math.max(8, left) + 'px';
}

document.getElementById('barPopupClose').addEventListener('click', () => barPopup.classList.add('hidden'));

document.getElementById('barPopupIncrease').addEventListener('click', () => {
  if (!barPopupCurrentTicker) return;
  document.getElementById('optTarget').value = barPopupCurrentTicker;
  barPopup.classList.add('hidden');
});

document.getElementById('barPopupDecrease').addEventListener('click', () => {
  if (!barPopupCurrentTicker) return;
  const cap = parseFloat(barPopupCapInput.value) || 5;
  tickerCaps[barPopupCurrentTicker] = cap / 100;
  renderTickerCaps();
  barPopup.classList.add('hidden');
});

// Close popup when clicking outside
document.addEventListener('click', e => {
  if (!barPopup.classList.contains('hidden') && !barPopup.contains(e.target) && !e.target.closest('.exp-bar-row')) {
    barPopup.classList.add('hidden');
  }
});

// Click handler on optimization result bars
document.getElementById('optResultsContent').addEventListener('click', e => {
  const row = e.target.closest('.exp-bar-row');
  if (!row) return;
  const ticker = row.querySelector('.exp-bar-ticker').textContent.replace(/\s*★\s*/, '').trim();
  const pct    = row.querySelector('.exp-bar-value').textContent;
  showBarPopup(ticker, pct, row);
});

document.getElementById('optRun').addEventListener('click', runOptimization);
document.getElementById('optTarget').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

// Refresh ETF chips whenever switching to optimization tab
document.querySelector('.tab-btn[data-tab="optimization"]').addEventListener('click', renderOptEtfList);

// ── Tab switching ──────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
  });
});

// ── Bundled cache loader ────────────────────────────────────
async function loadBundledCache() {
  try {
    const res = await fetch('./holdings-cache.json');
    if (!res.ok) return; // file not present — silently skip
    const data = await res.json();
    if (!data.holdings || typeof data.holdings !== 'object') return;
    let loaded = 0;
    for (const [ticker, entry] of Object.entries(data.holdings)) {
      if (!entry.holdings || !entry.fetchedAt) continue;
      const existing = getCached(ticker);
      // Only seed if visitor has no entry, or bundled data is newer
      if (!existing || new Date(entry.fetchedAt) > new Date(existing.fetchedAt)) {
        // Normalize to processed format before storing so all code paths
        // receive {asset, name, weightPercentage} regardless of source.
        const normalized = { holdings: normalizeHoldings(entry.holdings), fetchedAt: entry.fetchedAt };
        localStorage.setItem(cacheKey(ticker), JSON.stringify(normalized));
        loaded++;
      }
    }
    if (loaded > 0) {
      renderCachePanel();
      renderOptEtfList();
    }
  } catch { /* network error or bad JSON — ignore */ }
}

// ── Config / public mode ───────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch('./config.json');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.publicMode !== true) return;
    publicMode = true;

    // Hide API key section
    const apiSection = document.querySelector('.api-key-section');
    if (apiSection) apiSection.style.display = 'none';

    // Hide export / import buttons
    if (exportCacheBtn) exportCacheBtn.style.display = 'none';
    const importLabel = importCacheInput?.closest('label');
    if (importLabel) importLabel.style.display = 'none';

    // Re-render cache panel without action buttons
    renderCachePanel();
  } catch { /* config.json absent or bad JSON — remain in private mode */ }
}

// ── Historical Spread ───────────────────────────────────────
let histLegs       = [];
let histNextId     = 1;
let histSeriesData = null; // cached for window resize redraws

const HIST_COLORS = ['#3ecf8e','#f25c6e','#5b9cf6','#f7c059','#c17af6','#38bdf8','#f59e42','#e879f9'];

function createHistLegRow(id) {
  const row = document.createElement('div');
  row.className = 'hist-leg-row';
  row.dataset.legId = id;
  row.innerHTML = `
    <input type="text" class="hist-leg-ticker" placeholder="e.g. SPY" maxlength="10" autocomplete="off" />
    <select class="hist-leg-dir">
      <option value="long">↑ Long</option>
      <option value="short">↓ Short</option>
    </select>
    <div class="input-prefix-wrap">
      <span class="input-prefix">$</span>
      <input type="number" class="hist-leg-amount" placeholder="Amount" min="0" step="1000" style="padding-left:1.4rem" />
    </div>
    <button class="btn btn-remove" title="Remove">✕</button>
  `;
  const leg = histLegs.find(l => l.id === id);
  row.querySelector('.hist-leg-ticker').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
    if (leg) leg.ticker = e.target.value.trim();
  });
  row.querySelector('.hist-leg-dir').addEventListener('change', e => {
    if (leg) leg.direction = e.target.value;
  });
  row.querySelector('.hist-leg-amount').addEventListener('input', e => {
    if (leg) leg.amount = parseFloat(e.target.value) || 0;
  });
  row.querySelector('.btn-remove').addEventListener('click', () => {
    histLegs = histLegs.filter(l => l.id !== id);
    row.remove();
  });
  return row;
}

function addHistLeg() {
  const id = histNextId++;
  histLegs.push({ id, ticker: '', direction: 'long', amount: 10000 });
  const row = createHistLegRow(id);
  document.getElementById('histLegsList').appendChild(row);
  row.querySelector('.hist-leg-amount').value = 10000;
  row.querySelector('.hist-leg-ticker').focus();
}

// Default date range: last 1 year
(function setHistDates() {
  const today = new Date();
  const start = new Date(today);
  start.setFullYear(today.getFullYear() - 1);
  document.getElementById('histEnd').value   = today.toISOString().split('T')[0];
  document.getElementById('histStart').value = start.toISOString().split('T')[0];
})();

async function fetchHistoricalPrices(ticker, startDate, endDate) {
  const period1  = Math.floor(new Date(startDate).getTime() / 1000);
  const period2  = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;
  const yfPath   = `${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;
  const fetchUrl = isLocalDev
    ? YF_PROXY + encodeURIComponent(YF_BASE + yfPath)
    : `/.netlify/functions/history?ticker=${encodeURIComponent(ticker)}&period1=${period1}&period2=${period2}`;
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${ticker}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data returned for ${ticker}`);
  const ts = result.timestamp;
  const cl = result.indicators.quote[0].close;
  return ts
    .map((t, i) => ({ date: new Date(t * 1000), close: cl[i] }))
    .filter(d => d.close !== null && d.close !== undefined);
}

function alignSeries(allSeries) {
  const sets   = allSeries.map(s => new Set(s.map(p => p.date.toISOString().split('T')[0])));
  const common = [...sets[0]].filter(d => sets.every(set => set.has(d))).sort();
  return allSeries.map(s => {
    const m = {};
    s.forEach(p => { m[p.date.toISOString().split('T')[0]] = p.close; });
    return common.map(d => ({ date: new Date(d), close: m[d] }));
  });
}

function drawHistChart(canvas, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.offsetWidth || 800;
  const H   = opts.height || 260;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width  = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad   = { top: 18, right: opts.showCallouts ? 58 : 16, bottom: 44, left: 62 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top  - pad.bottom;

  // Y range
  const allY = series.flatMap(s => s.points.map(p => p.y));
  let minY = Math.min(...allY), maxY = Math.max(...allY);
  const ySpan = maxY - minY || 10;
  minY -= ySpan * 0.06; maxY += ySpan * 0.06;

  // X range
  const allX = series[0].points.map(p => p.x);
  const minX = allX[0], maxX = allX[allX.length - 1];
  const xRange = maxX - minX || 1;

  const xS = x => pad.left + ((x - minX) / xRange) * plotW;
  const yS = y => pad.top  + plotH - ((y - minY) / (maxY - minY)) * plotH;

  // Background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // Y grid + labels
  ctx.font = `10px 'SF Mono', Consolas, monospace`;
  for (let i = 0; i <= 5; i++) {
    const v = minY + (maxY - minY) * (i / 5);
    const y = yS(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle  = 'rgba(255,255,255,0.28)';
    ctx.textAlign  = 'right';
    ctx.fillText(opts.yFormat ? opts.yFormat(v) : v.toFixed(1), pad.left - 5, y + 3.5);
  }

  // Baseline
  if (opts.baseline !== undefined) {
    const bY = yS(opts.baseline);
    if (bY > pad.top && bY < pad.top + plotH) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, bY); ctx.lineTo(W - pad.right, bY); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // X labels
  ctx.fillStyle  = 'rgba(255,255,255,0.28)';
  ctx.textAlign  = 'center';
  ctx.font       = `10px 'SF Mono', Consolas, monospace`;
  const nX = Math.min(7, allX.length);
  for (let i = 0; i <= nX; i++) {
    const idx = Math.round((allX.length - 1) * i / nX);
    if (idx < 0 || idx >= allX.length) continue;
    const d   = new Date(allX[idx]);
    const lbl = `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
    ctx.fillText(lbl, xS(allX[idx]), H - pad.bottom + 14);
  }

  // Lines
  series.forEach(s => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.beginPath();
    s.points.forEach((p, i) => {
      i === 0 ? ctx.moveTo(xS(p.x), yS(p.y)) : ctx.lineTo(xS(p.x), yS(p.y));
    });
    ctx.stroke();
  });

  // End-of-line callouts
  if (opts.showCallouts) {
    ctx.font      = `bold 10px 'SF Mono', Consolas, monospace`;
    ctx.textAlign = 'left';
    const callouts = series.map(s => {
      const last  = s.points[s.points.length - 1];
      const delta = opts.baseline !== undefined ? last.y - opts.baseline : last.y;
      const label = (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%';
      return { s, x: xS(last.x) + 6, y: yS(last.y), label };
    }).sort((a, b) => a.y - b.y);
    // Nudge overlapping labels apart (min 13px gap)
    for (let i = 1; i < callouts.length; i++) {
      if (callouts[i].y - callouts[i - 1].y < 13) callouts[i].y = callouts[i - 1].y + 13;
    }
    callouts.forEach(c => {
      ctx.fillStyle = c.s.color;
      ctx.fillText(c.label, c.x, c.y + 3.5);
    });
  }

  // Store metadata for tooltip
  canvas._meta = { series, xS, yS, pad, allX, plotW, W, H, opts };
}

function setupHistTooltip(canvas, tooltipEl) {
  canvas.addEventListener('mousemove', e => {
    const m = canvas._meta;
    if (!m) return;
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    if (mx < m.pad.left || mx > m.W - m.pad.right) { tooltipEl.classList.add('hidden'); return; }
    const frac = (mx - m.pad.left) / m.plotW;
    const idx  = Math.max(0, Math.min(m.allX.length - 1, Math.round(frac * (m.allX.length - 1))));
    const d    = new Date(m.allX[idx]);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const rows = m.series.map(s => {
      const v   = s.points[idx]?.y;
      const val = v !== undefined ? (m.opts.yFormat ? m.opts.yFormat(v) : v.toFixed(2)) : '—';
      return `<div class="hist-tip-row">
        <span class="hist-tip-dot" style="background:${s.color}"></span>
        <span class="hist-tip-lbl">${escHtml(s.label)}</span>
        <span class="hist-tip-val">${escHtml(val)}</span>
      </div>`;
    }).join('');
    tooltipEl.innerHTML = `<div class="hist-tip-date">${escHtml(dateStr)}</div>${rows}`;
    tooltipEl.classList.remove('hidden');
    const tW = tooltipEl.offsetWidth;
    let left = mx + 14;
    if (left + tW > m.W - 8) left = mx - tW - 14;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top  = (m.pad.top + 8) + 'px';
  });
  canvas.addEventListener('mouseleave', () => tooltipEl.classList.add('hidden'));
}

function renderHistLegend(legendEl, series) {
  legendEl.innerHTML = series.map(s =>
    `<span class="hist-legend-chip">
       <span class="hist-legend-dot" style="background:${s.color}"></span>
       ${escHtml(s.label)}
     </span>`
  ).join('');
}

function renderHistCharts() {
  if (!histSeriesData) return;
  const { indexedSeries, portfolioSeries, totalInvested } = histSeriesData;

  const c1 = document.getElementById('histChart1');
  drawHistChart(c1, indexedSeries, { baseline: 100, height: 260, showCallouts: true });
  setupHistTooltip(c1, document.getElementById('histTooltip1'));
  renderHistLegend(document.getElementById('histLegend1'), indexedSeries);

  const c2 = document.getElementById('histChart2');
  drawHistChart(c2, portfolioSeries, {
    baseline: 0,
    height: 260,
    showCallouts: true,
    yFormat: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
  });
  setupHistTooltip(c2, document.getElementById('histTooltip2'));
  renderHistLegend(document.getElementById('histLegend2'), portfolioSeries);
}

async function runHistSimulation() {
  clearMessages();
  const startDate = document.getElementById('histStart').value;
  const endDate   = document.getElementById('histEnd').value;
  if (!startDate || !endDate)                           { showError('Select start and end dates.');            return; }
  if (new Date(startDate) >= new Date(endDate))         { showError('Start must be before end date.');         return; }
  const validLegs = histLegs.filter(l => l.ticker && l.amount > 0);
  if (!validLegs.length)                                { showError('Add at least one leg with a ticker and dollar amount.'); return; }

  showLoading('Fetching historical prices…');
  try {
    const rawSeries = [];
    for (const leg of validLegs) {
      updateLoadingMessage(`Fetching ${leg.ticker}…`);
      const prices = await fetchHistoricalPrices(leg.ticker, startDate, endDate);
      if (prices.length < 2) throw new Error(`Not enough price data returned for ${leg.ticker}`);
      rawSeries.push(prices);
    }

    const aligned = alignSeries(rawSeries);
    if (!aligned[0].length) throw new Error('No overlapping trading days found across the selected tickers and date range.');

    // Chart 1: raw ETF price performance indexed to 100 (direction-agnostic)
    const indexedSeries = validLegs.map((leg, i) => {
      const prices = aligned[i], base = prices[0].close;
      return {
        label:  `${leg.direction === 'short' ? '↓' : '↑'} ${leg.ticker}`,
        color:  HIST_COLORS[i % HIST_COLORS.length],
        points: prices.map(p => ({ x: p.date.getTime(), y: 100 + ((p.close / base) - 1) * 100 }))
      };
    });

    // Chart 2: aggregate portfolio $ value
    const nDays    = aligned[0].length;
    const aggPts   = [];
    for (let j = 0; j < nDays; j++) {
      let total = 0;
      validLegs.forEach((leg, i) => {
        const base = aligned[i][0].close;
        const mult = leg.direction === 'short' ? -1 : 1;
        total += leg.amount * (1 + mult * ((aligned[i][j].close / base) - 1));
      });
      aggPts.push({ x: aligned[0][j].date.getTime(), y: total });
    }
    const totalInvested = validLegs.reduce((s, l) => s + l.amount, 0);
    const pctPts    = aggPts.map(p => ({ x: p.x, y: ((p.y / totalInvested) - 1) * 100 }));
    const finalColor = pctPts[pctPts.length - 1].y >= 0 ? '#3ecf8e' : '#f25c6e';
    const portfolioSeries = [{ label: 'Portfolio', color: finalColor, points: pctPts }];

    hideLoading();
    histSeriesData = { indexedSeries, portfolioSeries, totalInvested };
    document.getElementById('histResults').classList.remove('hidden');
    renderHistCharts();
  } catch (err) {
    hideLoading();
    showError(`Error: ${err.message}`);
  }
}

document.getElementById('histAddLeg').addEventListener('click', addHistLeg);
document.getElementById('histRun').addEventListener('click', runHistSimulation);
window.addEventListener('resize', () => { if (histSeriesData) renderHistCharts(); });

// Start with 2 default legs
addHistLeg();
addHistLeg();

// ── Init ───────────────────────────────────────────────────
renderCachePanel();
renderOptEtfList();
loadConfig();
loadBundledCache();
