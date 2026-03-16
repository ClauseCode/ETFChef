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
function getCached(ticker)     {
  try   { return JSON.parse(localStorage.getItem(cacheKey(ticker))); }
  catch { return null; }
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
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${ticker}`);
  const data = await res.json();

  if (data['Error Message']) throw new Error(data['Error Message']);
  if (data['Information'])   throw new Error(data['Information']);
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
      if (!underlying) continue;
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

  // Split into cached vs needs-fetch
  const toFetch  = uniqueTickers.filter(t => { const c = getCached(t); return !c || !isFresh(c); });
  const fromCache = uniqueTickers.filter(t => { const c = getCached(t); return c && isFresh(c); });

  if (publicMode && toFetch.length > 0) {
    showError(`Holdings data not available for: ${toFetch.join(', ')}.\nThis site uses pre-loaded ETF data. Only the ETFs listed in the cache panel are supported.`);
    return;
  }

  if (toFetch.length === 0) {
    showSuccess(`All ${uniqueTickers.length} ETF${uniqueTickers.length !== 1 ? 's' : ''} served from cache — 0 API calls used.`);
  } else {
    showLoading(`Fetching ${toFetch.join(', ')}… (${fromCache.length} from cache)`);
  }

  try {
    const holdingsMap = {};
    const errors = [];

    for (const ticker of uniqueTickers) {
      const cached = getCached(ticker);
      if (cached && isFresh(cached)) {
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

    const cachedCount  = fromCache.length;
    const fetchedCount = toFetch.length - errors.length;
    if (toFetch.length > 0 && !errors.length)
      showSuccess(`${fetchedCount > 0 ? `Fetched ${fetchedCount} ETF${fetchedCount !== 1 ? 's' : ''} from API · ` : ''}${cachedCount > 0 ? `${cachedCount} from cache · ` : ''}${fetchedCount} API call${fetchedCount !== 1 ? 's' : ''} used today.`);

    renderResults(exposure);

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
}

// Generate all k-combinations from array
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const out = [];
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) out.push([arr[i], ...rest]);
  }
  return out;
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
  let best = null, bestScore = -Infinity;

  const kMax = Math.min(maxLegs, available.length);
  for (let k = 1; k <= kMax; k++) {
    for (const combo of combinations(available, k)) {
      const totalDirs = 1 << k;
      for (let mask = 0; mask < totalDirs; mask++) {
        const dirs = combo.map((_, i) => ((mask >> i) & 1) ? 1 : -1);

        // Equal-weighted: each leg contributes 1/k
        const exp = {};
        for (let i = 0; i < k; i++) {
          for (const h of holdingsMap[combo[i]]) {
            const s = h.asset.toUpperCase();
            if (!s) continue;
            exp[s] = (exp[s] || 0) + dirs[i] * (h.weightPercentage / 100) / k;
          }
        }

        const targetExp = exp[target] || 0;
        if (targetExp <= 0) continue; // target must be positive
        if (optimizeMode === 'absolute' && targetExp <= bestScore) continue; // prune for absolute mode

        let feasible = true;
        for (const [s, v] of Object.entries(exp)) {
          if (s === target) continue;
          if (Math.abs(v) > cap + 1e-9) { feasible = false; break; }
          if (requireMaxExp && Math.abs(v) > targetExp + 1e-9) { feasible = false; break; }
          if (tickerCaps[s] !== undefined && Math.abs(v) > tickerCaps[s] + 1e-9) { feasible = false; break; }
        }

        if (feasible) {
          let score, ratio;
          if (optimizeMode === 'relative') {
            const maxOther = Math.max(0, ...Object.entries(exp).filter(([s]) => s !== target).map(([, v]) => Math.abs(v)));
            ratio = maxOther > 1e-9 ? targetExp / maxOther : Infinity;
            score = maxOther > 1e-9 ? targetExp / maxOther : 1e9;
          } else {
            score = targetExp;
            ratio = null;
          }
          if (score > bestScore) {
            bestScore = score;
            best = { legs: combo.map((etf, i) => ({ etf, dir: dirs[i] })), exp, targetExp, ratio };
          }
        }
      }
    }
  }

  if (!best) {
    errEl.textContent = `No feasible portfolio found for ${target} with those constraints. Try increasing "Max Other Exposure" or "Max Legs".`;
    errEl.classList.remove('hidden');
    return;
  }

  renderOptResults(best, target, maxOtherPct, portfolio);
}

function renderOptResults(result, target, maxOtherPct, portfolio) {
  const k = result.legs.length;
  const legDollars = portfolio / k;

  // Store for porting to Historical Spread tab
  lastOptLegs = result.legs.map(l => ({ etf: l.etf, dir: l.dir > 0 ? 'long' : 'short', dollars: legDollars }));

  const legsHtml = result.legs.map(l => {
    const dir      = l.dir > 0 ? 'long' : 'short';
    const dirLabel = l.dir > 0 ? '↑ Long' : '↓ Short';
    const price    = priceCache[l.etf];
    const shares   = price ? Math.round(legDollars / price) : null;
    const sharesStr = shares !== null
      ? `<span class="opt-leg-shares">≈ ${shares.toLocaleString()} shares @ $${price.toFixed(2)}</span>`
      : '';
    return `
    <div class="opt-leg ${dir}">
      <div class="opt-leg-top">
        <span class="opt-leg-dir">${dirLabel}</span>
        <span class="opt-leg-ticker">${escHtml(l.etf)}</span>
      </div>
      <div class="opt-leg-amount">${fmtMoney(legDollars)}</div>
      ${sharesStr}
    </div>`;
  }).join('');

  const targetPct  = (result.targetExp * 100).toFixed(2);
  const ratioLabel = result.ratio != null && isFinite(result.ratio)
    ? `<div class="card-ratio">${result.ratio.toFixed(2)}× nearest holding</div>`
    : '';

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
    <div class="opt-legs-row">${legsHtml}</div>
    <div class="opt-target-card">
      <div class="card-label">${escHtml(target)} Exposure (equal-weighted)</div>
      <div class="card-value">+${targetPct}%</div>
      ${ratioLabel}
    </div>
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
        localStorage.setItem(cacheKey(ticker), JSON.stringify(entry));
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
