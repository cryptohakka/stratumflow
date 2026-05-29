require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { detectRegime }   = require('./regime');
const {
  executeRebalance,
  getPortfolio,
  getBestAaveStableApy,
  getAllAaveStableApys,
  getAaveBalances,
  loadPositions,
  getLastRegime,
} = require('./agent');

const app  = express();
const PORT = parseInt(process.env.STRATUM_PORT) || 5004;

const REGIME_PATH    = path.join(__dirname, 'regime.json');
const SNAPSHOTS_PATH = path.join(__dirname, 'snapshots.json');

app.use(express.json());

// ── SSE ───────────────────────────────────────────────────────────────────────
const clients   = new Set();
const logBuffer = []; // [{ id, line, ts }]
let   logSeq    = 0;

function broadcast(obj) {
  if (obj.type === 'log') {
    logSeq++;
    logBuffer.push({ ...obj, id: logSeq, ts: new Date().toISOString() });
    if (logBuffer.length > 300) logBuffer.shift();
  }
  const payload = 'data: ' + JSON.stringify(obj) + '\n\n';
  clients.forEach(res => res.write(payload));
}
global._broadcast = broadcast;

app.get('/events', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();

  // replay missed events
  const lastId = parseInt(req.headers['last-event-id'] || '0');
  const missed = lastId > 0 ? logBuffer.filter(e => e.id > lastId) : logBuffer.slice(-50);
  for (const entry of missed) {
    res.write('id: ' + entry.id + '\ndata: ' + JSON.stringify(entry) + '\n\n');
  }
  res.write(': heartbeat\n\n');

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ── Internal log (from agent.js notify()) ────────────────────────────────────
app.post('/internal/log', (req, res) => {
  const { line } = req.body || {};
  if (line) broadcast({ type: 'log', line });
  res.json({ ok: true });
});

// ── Inline runner ─────────────────────────────────────────────────────────────
let running = false;

async function runInline(fn, label) {
  if (running) {
    broadcast({ type: 'error', message: 'Already running' });
    return;
  }
  running = true;
  broadcast({ type: 'start', script: label });

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => {
    const line = args.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    origLog(line);
    broadcast({ type: 'log', line });
  };
  console.error = (...args) => {
    const line = args.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    origErr(line);
    broadcast({ type: 'log', line: '⚠️ ' + line });
  };

  try {
    await fn();
    broadcast({ type: 'done', code: 0 });
  } catch (e) {
    broadcast({ type: 'log',  line: '❌ ' + e.message });
    broadcast({ type: 'done', code: 1 });
  } finally {
    console.log = origLog;
    console.error = origErr;
    running = false;
    // push latest regime after run
    try { broadcast({ type: 'regime', data: JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')) }); } catch {}
  }
}

// ── GET endpoints ─────────────────────────────────────────────────────────────
app.get('/api/regime', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8'))); }
  catch { res.json({}); }
});

app.get('/api/snapshots', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, 'utf8'))); }
  catch { res.json([]); }
});

app.get('/api/positions', (req, res) => {
  res.json(loadPositions());
});

// Mantle portfolio balances for WALLET_ADDRESS
app.get('/api/balances', async (req, res) => {
  try {
    const wallet = process.env.WALLET_ADDRESS;
    if (!wallet) return res.status(400).json({ error: 'WALLET_ADDRESS not set' });
    const [holdings, aaveHoldings] = await Promise.all([
      getPortfolio(wallet),
      getAaveBalances(wallet),
    ]);
    res.json({ wallet, holdings: holdings.map(({raw, ...h}) => h), aaveHoldings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/aave-apy', async (req, res) => {
  try {
    const best = await getBestAaveStableApy();
    res.json(best);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST endpoints ────────────────────────────────────────────────────────────
app.post('/api/regime-check', (req, res) => {
  res.json({ ok: true });
  runInline(() => detectRegime(), 'regime-check');
});

app.post('/api/rebalance', (req, res) => {
  res.json({ ok: true });
  runInline(async () => {
    let regime;
    try { regime = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')); }
    catch { throw new Error('No regime data — run regime-check first'); }
    await executeRebalance(regime, { force: true });
  }, 'rebalance');
});

// Manual override: force a specific regime and rebalance
app.post('/api/force-regime', (req, res) => {
  const { regime: forceRegime } = req.body || {};
  const valid = ['risk_on', 'neutral', 'risk_off'];
  if (!valid.includes(forceRegime)) {
    return res.status(400).json({ error: `regime must be one of: ${valid.join(', ')}` });
  }
  res.json({ ok: true });
  runInline(async () => {
    let base;
    try { base = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')); } catch { base = {}; }
    const overridden = {
      ...base,
      regime:    forceRegime,
      rebalance: true,
      reasoning: `Manual override to ${forceRegime}`,
    };
    broadcast({ type: 'log', line: `[manual] force-regime: ${forceRegime}` });
    fs.writeFileSync(REGIME_PATH, JSON.stringify(overridden, null, 2));
    broadcast({ type: "regime", data: overridden });
    await executeRebalance(overridden, { force: true });
  }, `force-${forceRegime}`);
});

// ── Static frontend ───────────────────────────────────────────────────────────
app.get('/rwa', (req, res) => res.sendFile(path.join(__dirname, 'public/rwa.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Boot ──────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('[ui-server] :' + PORT);
  // push cached regime on start
  setTimeout(() => {
    try { broadcast({ type: 'regime', data: JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')) }); } catch {}
  }, 500);
});

server.on('error', e => console.error('[server error]', e.message));
process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

// ── Yields (DefiLlama + Aave merged) ─────────────────────────────────────────
let yieldsCache = null;
let yieldsCacheTs = 0;
const YIELDS_TTL = 3_600_000; // 1h

app.get('/api/yields', async (req, res) => {
  try {
    const now = Date.now();
    if (!yieldsCache || now - yieldsCacheTs > YIELDS_TTL) {
      // DefiLlama: mETH yield
      const r = await fetch('https://yields.llama.fi/pools');
      const data = await r.json();
      const pools = data.data;
      const meth = pools.find(p => p.project === 'meth-protocol' && p.chain === 'Ethereum' && p.symbol === 'METH');
      // Aave all stables
      let aaveAll = {};
      try { aaveAll = await getAllAaveStableApys(); } catch {}
      yieldsCache = {
        meth_apy:   meth?.apy ?? 2.1,
        cmeth_apy:  meth?.apy ?? 2.1,
        aave_usdc:  aaveAll.USDC  ?? null,
        aave_usde:  aaveAll.USDE  ?? null,
        aave_usdt0: aaveAll.USDT0 ?? null,
        aave_gho:   aaveAll.GHO   ?? null,
      };
      yieldsCacheTs = now;
    }
    // best aave for legacy compat
    let best = { apy: null, symbol: null };
    const aaveEntries = [
      { sym: 'USDC',  val: yieldsCache.aave_usdc  },
      { sym: 'USDe',  val: yieldsCache.aave_usde  },
      { sym: 'USDT0', val: yieldsCache.aave_usdt0 },
      { sym: 'GHO',   val: yieldsCache.aave_gho   },
    ].filter(e => e.val != null);
    if (aaveEntries.length) {
      const top = aaveEntries.reduce((a, b) => b.val > a.val ? b : a);
      best = { apy: top.val, symbol: top.sym };
    }
    res.json({ ...yieldsCache, aave_apy: best.apy, aave_symbol: best.sym });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/liquidity  (Odos price impact, 1h cache) ─────────────────────────
let liquidityCache = null;
let liquidityCacheTs = 0;
const LIQUIDITY_TTL = 60 * 60 * 1000;

const LIQUIDITY_SIZES = [
  { label: '$100K', amount: '30000000000000000000' },
  { label: '$500K', amount: '150000000000000000000' },
];

async function odosImpact(tokenAddress, amount) {
  const res = await fetch('https://enterprise-api.odos.xyz/sor/quote/v3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ODOS_API_KEY },
    body: JSON.stringify({
      chainId: 5000,
      inputTokens: [{ tokenAddress, amount }],
      outputTokens: [{ tokenAddress: process.env.USDC, proportion: 1 }],
      userAddr: process.env.WALLET,
      slippageLimitPercent: 50,
    }),
  });
  const d = await res.json();
  return { impact: d.priceImpact ?? null, inValue: d.inValues?.[0] ?? null };
}


// ── liquidity history (24h, persisted to JSON) ────────────────────────────
const HISTORY_FILE = path.join(__dirname, 'data/liquidity_history.json');
const HISTORY_MAX  = 96; // 24h @ 15min intervals max

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(entry) {
  let h = loadHistory();
  h.push(entry);
  if (h.length > HISTORY_MAX) h = h.slice(-HISTORY_MAX);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h));
}

app.get('/api/liquidity/history', (req, res) => {
  res.json(loadHistory());
});

app.get('/api/liquidity', async (req, res) => {
  try {
    const now = Date.now();
    if (liquidityCache && now - liquidityCacheTs < LIQUIDITY_TTL) {
      return res.json(liquidityCache);
    }
    const tokens = { cmETH: process.env.CMETH, mETH: process.env.METH };
    const result = {};
    for (const [symbol, addr] of Object.entries(tokens)) {
      result[symbol] = [];
      for (const { label, amount } of LIQUIDITY_SIZES) {
        await new Promise(r => setTimeout(r, 3000));
        const { impact, inValue } = await odosImpact(addr, amount);
        result[symbol].push({ label, inValue, impact });
      }
    }
    result.updatedAt = new Date().toISOString();
    // save to history
    saveHistory({
      ts: result.updatedAt,
      cmETH_100k: result.cmETH.find(r => r.label === '$100K')?.impact ?? null,
      cmETH_500k: result.cmETH.find(r => r.label === '$500K')?.impact ?? null,
      mETH_100k:  result.mETH.find(r =>  r.label === '$100K')?.impact ?? null,
      mETH_500k:  result.mETH.find(r =>  r.label === '$500K')?.impact ?? null,
    });
    liquidityCache = result;
    liquidityCacheTs = now;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── /api/rwa-risk ─────────────────────────────────────────────────────────────
const RWA_RISK_FILE = path.join(__dirname, 'data/rwa_risk.json');
app.get('/api/rwa-risk', (req, res) => {
  if (fs.existsSync(RWA_RISK_FILE)) {
    return res.json(JSON.parse(fs.readFileSync(RWA_RISK_FILE, 'utf8')));
  }
  res.status(503).json({ error: 'RWA risk data not yet available — agent not running?' });
});

