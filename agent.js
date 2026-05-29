require('dotenv').config();
const fs    = require('fs');
const axios = require('axios');
const { ethers } = require('ethers');
const { detectRegime } = require('./regime');

// ── RebalanceRecorder (on-chain audit trail) ──────────────────────────────────
const RECORDER_ABI = [
  'function recordRebalance(string regime, string fromAsset, string toAsset, uint256 amount, uint256 rwaScore) external',
  'function recordRegimeChange(string oldRegime, string newRegime, uint256 confidence) external',
];
const RECORDER_ADDRESS = process.env.RECORDER_ADDRESS || '0x3d99E72229BF6DD14697751971C81D93529BeEff';
function getRecorder() {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.mantle.xyz');
    const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    return new ethers.Contract(RECORDER_ADDRESS, RECORDER_ABI, wallet);
  } catch { return null; }
}

const POSITIONS_PATH = './positions.json';
const INTERVAL_MS    = parseInt(process.env.REGIME_CHECK_INTERVAL) || 15 * 60 * 1000;

// ── Token addresses (Mantle mainnet) ─────────────────────────────────────────
const TOKENS = {
  WMNT:  process.env.WMNT,
  MNT:   process.env.MNT,
  METH:  process.env.METH,
  CMETH: process.env.CMETH,
  USDY:  process.env.USDY,
  USDC:  process.env.USDC,
  USDE:  process.env.USDE,
  USDT0: process.env.USDT0,
  GHO:   process.env.GHO,
};

// ── Allocation targets per regime ─────────────────────────────────────────────
// risk_on  : cmETH 70% + Aave highest stable 30%
// neutral  : mETH 50% + USDY 50%
// risk_off : USDY 70% + USDC 30%
const ALLOCATIONS = {
  risk_on:  [{ token: 'CMETH', pct: 0.70 }, { token: 'USDC', pct: 0.30, inAave: true }],
  neutral:  [{ token: 'METH',  pct: 0.50 }, { token: 'USDC', pct: 0.50, inAave: true }],
  risk_off: [{ token: 'USDC',  pct: 1.00, inAave: true }],
};

// ── Rebalance guard thresholds ────────────────────────────────────────────────
const CONFIDENCE_THRESHOLD   = parseFloat(process.env.CONFIDENCE_THRESHOLD)   || 0.7;
const CONFIRMATION_COUNT     = parseInt(process.env.CONFIRMATION_COUNT)        || 2;

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const LB_ROUTER_ABI = [
  `function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    tuple(uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path,
    address to,
    uint256 deadline
  ) external returns (uint256 amountOut)`,
  `function swapExactNATIVEForTokens(
    uint256 amountOutMin,
    tuple(uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path,
    address to,
    uint256 deadline
  ) external payable returns (uint256 amountOut)`,
];

const MOE_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external returns (uint256[] amounts)',
];

const LB_QUOTER_ABI = [
  `function findBestPathFromAmountIn(
    address[] calldata route,
    uint256 amountIn
  ) external view returns (
    tuple(
      address[] route,
      address[] pairs,
      uint256[] binSteps,
      uint8[] versions,
      uint256[] amounts,
      uint256[] virtualAmountsWithoutSlippage,
      uint256[] fees
    ) quote
  )`,
];

const AAVE_POOL_ABI = [
  `function getReserveData(address asset) external view returns (
    tuple(
      uint256 configuration,
      uint128 liquidityIndex,
      uint128 currentLiquidityRate,
      uint128 variableBorrowIndex,
      uint128 currentVariableBorrowRate,
      uint128 currentStableBorrowRate,
      uint40 lastUpdateTimestamp,
      uint16 id,
      address aTokenAddress,
      address stableDebtTokenAddress,
      address variableDebtTokenAddress,
      address interestRateStrategyAddress,
      uint128 accruedToTreasury,
      uint128 unbacked,
      uint128 isolationModeTotalDebt
    ) data
  )`,
  `function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)`,
  `function withdraw(address asset, uint256 amount, address to) returns (uint256)`,
];

// ── Provider / Signer ─────────────────────────────────────────────────────────
function getProvider() {
  return new ethers.JsonRpcProvider(process.env.MANTLE_RPC);
}

function getSigner() {
  return new ethers.Wallet(process.env.PRIVATE_KEY, getProvider());
}

// ── Notify ────────────────────────────────────────────────────────────────────
async function notify(content) {
  fetch('http://localhost:' + (process.env.STRATUM_PORT || 5004) + '/internal/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line: content }),
  }).catch(() => {});

  const url = process.env.DISCORD_SYSTEM_WEBHOOK;
  if (!url) return;
  const chunks = content.replace(/\*\*/g, '**').match(/[\s\S]{1,1900}/g) || [content];
  for (const chunk of chunks) {
    await axios.post(url, { content: chunk, username: '🤖 StratumFlow' })
      .catch(e => console.error('[notify]', e.message));
  }
}

// ── Token balance ─────────────────────────────────────────────────────────────
async function getBalance(tokenSymbol, address) {
  const provider = getProvider();
  const addr = TOKENS[tokenSymbol];
  if (!addr) throw new Error(`Unknown token: ${tokenSymbol}`);
  const erc20 = new ethers.Contract(addr, ERC20_ABI, provider);
  const [raw, dec] = await Promise.all([erc20.balanceOf(address), erc20.decimals()]);
  return { raw, dec: Number(dec), amount: parseFloat(ethers.formatUnits(raw, dec)) };
}

// ── Aave V3 ───────────────────────────────────────────────────────────────────
const AAVE_TOKENS = {
  USDT0: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
  USDC:  '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
  GHO:   '0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73',
  USDE:  '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
};
const AAVE_POOL              = '0x458F293454fE0d67EC0655f3672301301DD51422';
const AAVE_UI_INCENTIVE      = '0x04EEC4892Ec41A056C66787211aE81A24460fF02';
const AAVE_ADDRESSES_PROVIDER = '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f';
const STABLE_TOKENS          = ['USDT0', 'USDC', 'GHO', 'USDE'];

async function getAaveBalances(walletAddress) {
  const provider = getProvider();
  const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider);
  const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
  const result = [];
  for (const sym of STABLE_TOKENS) {
    const addr = AAVE_TOKENS[sym];
    if (!addr) continue;
    try {
      const data = await pool.getReserveData(addr);
      const aTokenAddr = data.aTokenAddress;
      const aToken = new ethers.Contract(aTokenAddr, erc20Abi, provider);
      const [bal, dec] = await Promise.all([aToken.balanceOf(walletAddress), aToken.decimals()]);
      const amount = parseFloat(ethers.formatUnits(bal, dec));
      result.push({ symbol: 'a' + sym, amount, aTokenAddress: aTokenAddr, usd: amount });
    } catch(e) {
      result.push({ symbol: 'a' + sym, amount: 0, aTokenAddress: null });
    }
  }
  return result;
}

async function aaveDeposit(tokenSymbol, amount) {
  const signer    = getSigner();
  const pool      = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, signer);
  const addr      = AAVE_TOKENS[tokenSymbol];
  if (!addr) throw new Error(`Unknown Aave token: ${tokenSymbol}`);
  const token     = new ethers.Contract(addr, ERC20_ABI, signer);
  const dec       = Number(await token.decimals());
  const amountWei = ethers.parseUnits(parseFloat(amount.toFixed(dec)).toString(), dec);
  const allowance = await token.allowance(signer.address, AAVE_POOL);
  if (allowance < amountWei) {
    const tx = await token.approve(AAVE_POOL, ethers.MaxUint256);
    await tx.wait();
    console.log(`[aave] approved ${tokenSymbol}`);
  }
  const tx = await pool.supply(addr, amountWei, signer.address, 0);
  const receipt = await tx.wait();
  console.log(`[aave] deposited ${amount} ${tokenSymbol} — tx: ${receipt.hash}`);
  return receipt.hash;
}

async function aaveWithdraw(tokenSymbol, amount) {
  const signer    = getSigner();
  const pool      = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, signer);
  const addr      = AAVE_TOKENS[tokenSymbol];
  if (!addr) throw new Error(`Unknown Aave token: ${tokenSymbol}`);
  const token     = new ethers.Contract(addr, ERC20_ABI, signer);
  const dec       = Number(await token.decimals());
  const amountWei = amount === null
    ? ethers.MaxUint256
    : ethers.parseUnits(parseFloat(amount.toFixed(dec)).toString(), dec);
  const tx = await pool.withdraw(addr, amountWei, signer.address);
  const receipt = await tx.wait();
  console.log(`[aave] withdrew ${amount ?? 'ALL'} ${tokenSymbol} — tx: ${receipt.hash}`);
  return receipt.hash;
}

// ── Token USD prices via Odos pricing API ─────────────────────────────────────
async function getTokenPrices(addresses) {
  try {
    const keys = addresses.map(a => `mantle:${a}`).join(',');
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys}`);
    const d = await res.json();
    const priceMap = {};
    Object.entries(d.coins || {}).forEach(([k, v]) => {
      const addr = k.replace('mantle:', '').toLowerCase();
      priceMap[addr] = v.price;
    });
    return priceMap;
  } catch(e) {
    console.error('[prices] failed:', e.message);
    return {};
  }
}

// ── Portfolio snapshot ────────────────────────────────────────────────────────
async function getPortfolio(walletAddress) {
  const symbols = Object.keys(TOKENS);
  const results = await Promise.allSettled(
    symbols.map(s => getBalance(s, walletAddress).then(b => ({ symbol: s, ...b })))
  );
  const holdings = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(b => b.amount > 0);

  const addrs = holdings.map(h => TOKENS[h.symbol]).filter(Boolean);
  const prices = addrs.length ? await getTokenPrices(addrs) : {};
  const priceMap = {};
  Object.entries(prices).forEach(([k,v]) => { priceMap[k.toLowerCase()] = v; });

  return holdings.map(h => {
    const addr = (TOKENS[h.symbol] || '').toLowerCase();
    const price = priceMap[addr];
    const usd = price != null ? h.amount * price : null;
    return { ...h, usd };
  });
}

// ── Aave APY ──────────────────────────────────────────────────────────────────
async function getBestAaveStableApy() {
  const provider = getProvider();
  const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider);
  const RAY  = BigInt('1000000000000000000000000000');
  const baseApys = {};
  for (const sym of STABLE_TOKENS) {
    const addr = AAVE_TOKENS[sym];
    if (!addr) continue;
    try {
      const data = await pool.getReserveData(addr);
      const apy  = parseFloat((BigInt(data.currentLiquidityRate) * 10000n / RAY).toString()) / 100;
      baseApys[sym] = { addr, apy };
    } catch (e) { console.warn(`[aave] ${sym} base failed:`, e.message); }
  }
  const incentiveApys = {};
  try {
    const res = await axios.get('https://api.merkl.xyz/v4/opportunities', {
      params: { chainId: 5000, status: 'LIVE', items: 50 }, timeout: 8000,
    });
    for (const opp of res.data) {
      const name = opp.name || '';
      const apr  = parseFloat(opp.apr || 0);
      if (!name.startsWith('Lend') || apr <= 0) continue;
      let sym = null;
      if (name.includes('USDT0'))     sym = 'USDT0';
      else if (name.includes('USDC')) sym = 'USDC';
      else if (name.includes('GHO'))  sym = 'GHO';
      else if (name.includes('USDe') || name.includes('USDE')) sym = 'USDE';
      if (!sym) continue;
      incentiveApys[sym] = (incentiveApys[sym] || 0) + apr;
    }
  } catch (e) { console.warn('[merkl] fetch failed:', e.message); }
  let best = { symbol: 'USDC', apy: 0, effectiveScore: 0 };
  const stableScores = {};
  for (const sym of STABLE_TOKENS) {
    if (!baseApys[sym]) continue;
    const totalApy = baseApys[sym].apy + (incentiveApys[sym] || 0);
    // depeg/utilはfetchRwaRiskから渡されるが、ここでは利用不可なので暫定0
    const effectiveScore = totalApy;
    stableScores[sym] = { apy: totalApy, base: baseApys[sym].apy, incentive: incentiveApys[sym] || 0, effectiveScore };
    if (effectiveScore > best.effectiveScore) {
      best = { symbol: sym, apy: totalApy, base: baseApys[sym].apy, incentive: incentiveApys[sym] || 0, effectiveScore };
    }
  }
  best.stableScores = stableScores;
  return best;
}

async function getAllAaveStableApys() {
  const provider = getProvider();
  const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider);
  const RAY  = BigInt('1000000000000000000000000000');
  const baseApys = {};
  for (const sym of STABLE_TOKENS) {
    const addr = AAVE_TOKENS[sym];
    if (!addr) continue;
    try {
      const data = await pool.getReserveData(addr);
      baseApys[sym] = parseFloat((BigInt(data.currentLiquidityRate) * 10000n / RAY).toString()) / 100;
    } catch {}
  }
  const incentiveApys = {};
  try {
    const res = await axios.get('https://api.merkl.xyz/v4/opportunities', {
      params: { chainId: 5000, status: 'LIVE', items: 50 }, timeout: 8000,
    });
    for (const opp of res.data) {
      const name = opp.name || '';
      const apr  = parseFloat(opp.apr || 0);
      if (!name.startsWith('Lend') || apr <= 0) continue;
      let sym = null;
      if (name.includes('USDT0'))     sym = 'USDT0';
      else if (name.includes('USDC')) sym = 'USDC';
      else if (name.includes('GHO'))  sym = 'GHO';
      else if (name.includes('USDe') || name.includes('USDE')) sym = 'USDE';
      if (!sym) continue;
      incentiveApys[sym] = (incentiveApys[sym] || 0) + apr;
    }
  } catch {}
  const result = {};
  for (const sym of STABLE_TOKENS) {
    if (baseApys[sym] == null) continue;
    result[sym] = baseApys[sym] + (incentiveApys[sym] || 0);
  }
  return result;
}

// ── Merchant Moe quote / swap ─────────────────────────────────────────────────

// Odos aggregator swap (mETH↔cmETH, USDC↔mETH etc)
async function executeOdosSwap(fromSymbol, toSymbol, amountIn) {
  const signer = getSigner();
  const fromAddr = TOKENS[fromSymbol];
  const toAddr   = TOKENS[toSymbol];
  if (!fromAddr || !toAddr) throw new Error(`Unknown tokens: ${fromSymbol}→${toSymbol}`);
  const fromDec = fromSymbol === 'USDC' ? 6 : 18;
  const amountWei = ethers.parseUnits(parseFloat(amountIn.toFixed(fromDec)).toString(), fromDec).toString();

  // 1. Quote
  const quoteRes = await fetch('https://enterprise-api.odos.xyz/sor/quote/v3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ODOS_API_KEY },
    body: JSON.stringify({
      chainId: 5000,
      inputTokens:  [{ tokenAddress: fromAddr, amount: amountWei }],
      outputTokens: [{ tokenAddress: toAddr, proportion: 1 }],
      userAddr: signer.address,
      slippageLimitPercent: 0.5,
    }),
  });
  const quote = await quoteRes.json();
  if (!quote.pathId) throw new Error('Odos quote failed: ' + JSON.stringify(quote).slice(0,100));
  console.log(`[odos-quote] ${fromSymbol}→${toSymbol} out: ${ethers.formatUnits(quote.outAmounts[0], toSymbol==='USDC'?6:18)}`);

  // rate limit対策
  await new Promise(r => setTimeout(r, 1500));
  // 2. Assemble
  const asmRes = await fetch('https://enterprise-api.odos.xyz/sor/assemble', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ODOS_API_KEY },
    body: JSON.stringify({ userAddr: signer.address, pathId: quote.pathId }),
  });
  const asm = await asmRes.json();
  if (!asm.transaction) throw new Error('Odos assemble failed: ' + JSON.stringify(asm).slice(0,100));

  // 3. Approve if needed
  const fromToken = new ethers.Contract(fromAddr, ERC20_ABI, signer);
  const allowance = await fromToken.allowance(signer.address, asm.transaction.to);
  const amountWeiBI = BigInt(amountWei);
  if (allowance < amountWeiBI) {
    const approveTx = await fromToken.approve(asm.transaction.to, ethers.MaxUint256);
    await approveTx.wait();
  }

  // 4. Execute
  const tx = await signer.sendTransaction({
    to:       asm.transaction.to,
    data:     asm.transaction.data,
    value:    BigInt(asm.transaction.value || '0'),
    gasLimit: BigInt(800000),
  });
  const receipt = await tx.wait();
  console.log(`[odos-swap] tx: ${receipt.hash}`);
  return receipt.hash;
}

// USDC→METH/CMETH用ルート
const MOE_ROUTES = {
  'USDC→METH':  [process.env.USDC, process.env.WMNT, process.env.METH],
  'USDC→CMETH': [process.env.USDC, process.env.WMNT, process.env.METH, process.env.CMETH],
  'METH→USDC':  [process.env.METH, process.env.WMNT, process.env.USDC],
  'CMETH→USDC': [process.env.CMETH, process.env.METH, process.env.WMNT, process.env.USDC],
  'METH→CMETH': [process.env.METH, process.env.CMETH],
  'CMETH→METH': [process.env.CMETH, process.env.METH],
};

async function getMoeQuote(fromSymbol, toSymbol, amountIn) {
  const key = fromSymbol + '→' + toSymbol;
  const route = MOE_ROUTES[key];
  if (!route) return null;
  const provider = getProvider();
  const router = new ethers.Contract(process.env.MOE_ROUTER, MOE_ROUTER_ABI, provider);
  const fromDec = fromSymbol === 'USDC' ? 6 : 18;
  const amountInWei = ethers.parseUnits(parseFloat(amountIn.toFixed(fromDec)).toString(), fromDec);
  try {
    const amounts = await router.getAmountsOut(amountInWei, route);
    const toDec = toSymbol === 'USDC' ? 6 : 18;
    return {
      amountOut: parseFloat(ethers.formatUnits(amounts[amounts.length-1], toDec)),
      route,
      amountInWei,
    };
  } catch(e) {
    console.warn('[moe-quote]', key, 'failed:', e.message?.slice(0,60));
    return null;
  }
}

async function executeMoeSwap(fromSymbol, toSymbol, amountIn, slippagePct = 0.5) {
  const signer = getSigner();
  const router = new ethers.Contract(process.env.MOE_ROUTER, MOE_ROUTER_ABI, signer);
  const quote = await getMoeQuote(fromSymbol, toSymbol, amountIn);
  if (!quote) throw new Error(`No MoeRouter route for ${fromSymbol}→${toSymbol}`);
  const fromDec = fromSymbol === 'USDC' ? 6 : 18;
  const toDec   = toSymbol  === 'USDC' ? 6 : 18;
  // approve if needed
  const fromAddr = quote.route[0];
  const fromToken = new ethers.Contract(fromAddr, ERC20_ABI, signer);
  const allowance = await fromToken.allowance(signer.address, process.env.MOE_ROUTER);
  if (allowance < quote.amountInWei) {
    const tx = await fromToken.approve(process.env.MOE_ROUTER, ethers.MaxUint256);
    await tx.wait();
  }
  const amountOutMin = ethers.parseUnits(
    (quote.amountOut * (1 - slippagePct/100)).toFixed(toDec > 6 ? 8 : 6), toDec
  );
  const deadline = Math.floor(Date.now()/1000) + 300;
  const tx = await router.swapExactTokensForTokens(
    quote.amountInWei, amountOutMin, quote.route, signer.address, deadline
  );
  const receipt = await tx.wait();
  console.log(`[moe-swap] tx: ${receipt.hash}`);
  return receipt.hash;
}

async function getSwapQuote(fromSymbol, toSymbol, amountIn) {
  const provider = getProvider();
  const quoter   = new ethers.Contract(process.env.LB_QUOTER, LB_QUOTER_ABI, provider);
  const fromAddr = TOKENS[fromSymbol];
  const toAddr   = TOKENS[toSymbol];
  if (!fromAddr || !toAddr) throw new Error(`Unknown token pair: ${fromSymbol}→${toSymbol}`);
  const { dec } = await getBalance(fromSymbol, ethers.ZeroAddress).catch(() => ({ dec: 18 }));
  const amountInWei = ethers.parseUnits(parseFloat(amountIn.toFixed(dec)).toString(), dec);
  try {
    const quote       = await quoter.findBestPathFromAmountIn([fromAddr, toAddr], amountInWei);
    const amountsArr  = quote.amounts || quote[4];
    const outRaw      = amountsArr[amountsArr.length - 1];
    const { dec: outDec } = await getBalance(toSymbol, ethers.ZeroAddress).catch(() => ({ dec: 18 }));
    return {
      amountOut: parseFloat(ethers.formatUnits(outRaw, outDec)),
      binSteps:  quote.binSteps || quote[2],
      versions:  quote.versions || quote[3],
      route:     [fromAddr, toAddr],
    };
  } catch (e) {
    console.warn(`[quote] ${fromSymbol}→${toSymbol} failed:`, e.message);
    return null;
  }
}

async function executeSwap(fromSymbol, toSymbol, amountIn, slippagePct = 0.5) {
  const signer   = getSigner();
  const router   = new ethers.Contract(process.env.LB_ROUTER, LB_ROUTER_ABI, signer);
  const fromAddr = TOKENS[fromSymbol];
  const toAddr   = TOKENS[toSymbol];
  const fromToken = new ethers.Contract(fromAddr, ERC20_ABI, signer);
  const dec       = Number(await fromToken.decimals());
  const amountInWei = ethers.parseUnits(parseFloat(amountIn.toFixed(dec)).toString(), dec);
  const WMNT = '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8';
  const isMNT = fromSymbol === 'MNT';
  const quoteFrom = isMNT ? 'WMNT' : fromSymbol;
  if (isMNT && !TOKENS['WMNT']) TOKENS['WMNT'] = WMNT;
  const quote = await getSwapQuote(quoteFrom, toSymbol, amountIn);
  if (!quote) throw new Error(`No quote for ${fromSymbol}→${toSymbol}`);
  const slippageFactor = 1 - slippagePct / 100;
  const toToken  = new ethers.Contract(toAddr, ERC20_ABI, signer);
  const outDec   = Number(await toToken.decimals());
  const amountOutMin = ethers.parseUnits(
    (quote.amountOut * slippageFactor).toFixed(outDec > 6 ? 8 : 6), outDec
  );
  const deadline = Math.floor(Date.now() / 1000) + 300;
  let tx;
  if (isMNT) {
    // ネイティブMNT → swapExactNATIVEForTokens
    tx = await router.swapExactNATIVEForTokens(
      amountOutMin,
      { pairBinSteps: quote.binSteps, versions: quote.versions, tokenPath: [WMNT, toAddr] },
      signer.address, deadline,
      { value: amountInWei }
    );
  } else {
    const allowance = await fromToken.allowance(signer.address, process.env.LB_ROUTER);
    if (allowance < amountInWei) {
      const approveTx = await fromToken.approve(process.env.LB_ROUTER, ethers.MaxUint256);
      await approveTx.wait();
    }
    tx = await router.swapExactTokensForTokens(
      amountInWei, amountOutMin,
      { pairBinSteps: quote.binSteps, versions: quote.versions, tokenPath: quote.route },
      signer.address, deadline,
    );
  }
  const receipt = await tx.wait();
  console.log(`[swap] tx: ${receipt.hash}`);
  return receipt.hash;
}

// ── Positions ─────────────────────────────────────────────────────────────────
function loadPositions() {
  if (!fs.existsSync(POSITIONS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8')); }
  catch { return {}; }
}

function savePositions(pos) {
  fs.writeFileSync(POSITIONS_PATH, JSON.stringify(pos, null, 2));
}

// ── Regime history (SQLite) ───────────────────────────────────────────────────
let _db = null;
function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  _db = new Database('./stratum.db');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS regime_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      regime     TEXT,
      phase      TEXT,
      confidence REAL,
      btc_price  REAL,
      rebalance  INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return _db;
}

function getLastRegime() {
  const row = getDb()
    .prepare('SELECT regime FROM regime_history ORDER BY id DESC LIMIT 1')
    .get();
  return row?.regime || null;
}

// 直近n件のregimeを取得
function getRecentRegimes(n) {
  return getDb()
    .prepare('SELECT regime FROM regime_history ORDER BY id DESC LIMIT ?')
    .all(n)
    .map(r => r.regime);
}

// ── RWA Risk Score ────────────────────────────────────────────────────────────
const RWA_RISK_PATH = './data/rwa_risk.json';
const COINGECKO_IDS = {
  USDC:  'usd-coin',
  USDT0: 'tether',
  USDE:  'ethena-usde',
  GHO:   'gho',
};
const ETH_CG_ID = 'ethereum';
const EXIT_DEPTH_THRESHOLD = 200000;

async function fetchRwaRisk(regimeType = 'risk_on') {
  const provider = getProvider();
  const pool     = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, provider);

  // 1. Aave utilization
  const utilizationByToken = {};
  for (const sym of STABLE_TOKENS) {
    const addr = AAVE_TOKENS[sym];
    if (!addr) continue;
    try {
      const data = await pool.getReserveData(addr);
      const liq  = Number(data.currentLiquidityRate);
      const borr = Number(data.currentVariableBorrowRate);
      utilizationByToken[sym] = borr > 0 ? parseFloat((borr / (borr + liq) * 100).toFixed(2)) : 0;
    } catch (e) {
      console.warn(`[rwa] util ${sym}:`, e.message);
      utilizationByToken[sym] = 0;
    }
  }
  const avgUtil = Object.values(utilizationByToken).reduce((a,b)=>a+b,0) / STABLE_TOKENS.length;

  // 2. Depeg
  const depegByToken = {};
  try {
    const ids = [...Object.values(COINGECKO_IDS), ETH_CG_ID].join(',');
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { timeout: 8000 }
    );
    const ethPrice = res.data[ETH_CG_ID]?.usd ?? 3000;
    for (const [sym, cgId] of Object.entries(COINGECKO_IDS)) {
      const price = res.data[cgId]?.usd ?? 1.0;
      depegByToken[sym] = parseFloat((Math.abs(1.0 - price) * 100).toFixed(4));
    }
  } catch (e) {
    console.warn('[rwa] depeg:', e.message);
    for (const sym of STABLE_TOKENS) depegByToken[sym] = 0;
  }
  const maxDepeg = Math.max(...Object.values(depegByToken));

  // 3. Exit depth — Odos APIで取得してhistoryにも書き込む(1h cache)
  let exitDepthTotal = EXIT_DEPTH_THRESHOLD * 2;
  let cmETH_100k = null, cmETH_500k = null, mETH_100k = null, mETH_500k = null;
  try {
    const hFile = './data/liquidity_history.json';
    let h = [];
    try { h = JSON.parse(fs.readFileSync(hFile, 'utf8')); } catch {}
    const lastEntry = h.length > 0 ? h[h.length - 1] : null;
    const age = lastEntry ? Date.now() - new Date(lastEntry.ts).getTime() : Infinity;
    if (age < 60 * 60 * 1000) {
      // キャッシュ有効 — 再取得しない
      cmETH_100k = lastEntry.cmETH_100k; cmETH_500k = lastEntry.cmETH_500k;
      mETH_100k  = lastEntry.mETH_100k;  mETH_500k  = lastEntry.mETH_500k;
      console.log('[rwa] exit depth cache hit');
    } else {
    async function odosImpact(tokenAddress, amount) {
      const r = await axios.post('https://enterprise-api.odos.xyz/sor/quote/v3', {
        chainId: 5000,
        inputTokens: [{ tokenAddress, amount }],
        outputTokens: [{ tokenAddress: process.env.USDC, proportion: 1 }],
        userAddr: process.env.WALLET,
        slippageLimitPercent: 50,
      }, { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ODOS_API_KEY }, timeout: 12000 });
      return r.data.priceImpact ?? null;
    }
    // cmETH/mETH価格をDefiLlamaから取得
    const llamaRes = await axios.get(
      `https://coins.llama.fi/prices/current/mantle:${process.env.CMETH},mantle:${process.env.METH}`,
      { timeout: 8000 }
    );
    const cmethPrice = llamaRes.data.coins[`mantle:${process.env.CMETH}`]?.price ?? 2200;
    const methPrice  = llamaRes.data.coins[`mantle:${process.env.METH}`]?.price  ?? 2200;
    const cmAmt100k = BigInt(Math.round(100000 / cmethPrice * 1e18)).toString();
    const cmAmt500k = BigInt(Math.round(500000 / cmethPrice * 1e18)).toString();
    const meAmt100k = BigInt(Math.round(100000 / methPrice  * 1e18)).toString();
    const meAmt500k = BigInt(Math.round(500000 / methPrice  * 1e18)).toString();
    [cmETH_100k, cmETH_500k] = await Promise.all([odosImpact(process.env.CMETH, cmAmt100k), odosImpact(process.env.CMETH, cmAmt500k)]);
    [mETH_100k,  mETH_500k]  = await Promise.all([odosImpact(process.env.METH,  meAmt100k), odosImpact(process.env.METH,  meAmt500k)]);
    const hFile = './data/liquidity_history.json';
    let h = [];
    try { h = JSON.parse(fs.readFileSync(hFile, 'utf8')); } catch {}
    h.push({ ts: new Date().toISOString(), cmETH_100k, cmETH_500k, mETH_100k, mETH_500k });
    if (h.length > 96) h = h.slice(-96);
    fs.writeFileSync(hFile, JSON.stringify(h));
    console.log(`[rwa] exit depth fetched cmETH=${cmETH_100k?.toFixed(2)}% mETH=${mETH_100k?.toFixed(2)}%`);
    } // end else
  } catch (e) { console.warn('[rwa] exit depth:', e.message); }

  // regime別exit depth判定 (キャッシュヒット/ミス共通)
  const cmOk = cmETH_100k !== null && cmETH_100k > -2;
  const meOk = mETH_100k  !== null && mETH_100k  > -2;
  let monitoredToken = null;
  let reentryWarning = false;
  if (regimeType === 'risk_on') {
    monitoredToken = 'cmETH';
    exitDepthTotal = cmOk ? 200000 : 0;
  } else if (regimeType === 'neutral') {
    monitoredToken = 'mETH';
    exitDepthTotal = meOk ? 200000 : 0;
  } else {
    monitoredToken = null;
    exitDepthTotal = EXIT_DEPTH_THRESHOLD * 2;
    reentryWarning = !cmOk;
  }
  console.log(`[rwa] exit depth cmETH=${cmETH_100k?.toFixed(2)}% mETH=${mETH_100k?.toFixed(2)}% monitored=${monitoredToken}`);

  // 4. スコア統合 (0-100)
  // stableScores計算
  let stableScores = {};
  let selectedSym = 'USDC';
  try {
    const bestRaw = await getBestAaveStableApy();
    let bestEffScore = -1;
    for (const [sym, s] of Object.entries(bestRaw.stableScores || {})) {
      const depeg = depegByToken[sym] || 0;
      const util  = utilizationByToken[sym] || 0;
      const effectiveScore = s.apy * (1 - depeg / 2) * (1 - util / 150);
      stableScores[sym] = { apy: s.apy, base: s.base, incentive: s.incentive, depeg, util, effectiveScore };
      if (effectiveScore > bestEffScore) { bestEffScore = effectiveScore; selectedSym = sym; }
    }
  } catch (e) { console.warn('[rwa] stableScores:', e.message); }
  const selectedStable = stableScores[selectedSym] || { depeg: 0, util: 0 };
  // exitNorm: 1 - min(exitDepthTotal / 200K, 1.0)
  const exitNorm = 1 - Math.min(exitDepthTotal / 200000, 1.0);
  const depegNorm = Math.min(selectedStable.depeg / 2.0,  1.0);
  const utilNorm  = Math.min(selectedStable.util  / 90.0, 1.0);
  const score     = Math.round((exitNorm * 0.50 + depegNorm * 0.30 + utilNorm * 0.20) * 100);

  // 5. Override判定
  const override = exitDepthTotal < EXIT_DEPTH_THRESHOLD ? 'risk_off'
    : score >= 70 ? 'risk_off'
    : score >= 50 ? 'neutral_cap'
    : null;

  // 4b. mETH TVL (DefiLlama)
  let methTvl = null;
  try {
    const tvlRes = await axios.get('https://api.llama.fi/tvl/meth-protocol', { timeout: 6000 });
    methTvl = Math.round(tvlRes.data);
  } catch (e) { console.warn('[rwa] meth tvl:', e.message); }

  const result = {
    score, override, exitDepthTotal, exitDepthThreshold: EXIT_DEPTH_THRESHOLD, exitImpact100k: monitoredToken === 'cmETH' ? cmETH_100k : monitoredToken === 'mETH' ? mETH_100k : null,
    regimeContext: regimeType, monitoredToken, reentryWarning: reentryWarning || false,
    maxDepeg, depegByToken,
    avgUtilization: parseFloat(avgUtil.toFixed(2)),
    utilizationByToken, stableScores, methTvl, updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(RWA_RISK_PATH, JSON.stringify(result, null, 2));
  console.log(`[rwa] score=${score} override=${override} exitDepth=$${exitDepthTotal}`);
  return result;
}


function saveRegime(regime) {
  getDb()
    .prepare('INSERT INTO regime_history (regime, phase, confidence, btc_price, rebalance) VALUES (?,?,?,?,?)')
    .run(regime.regime, regime.phase, regime.confidence, regime.btc_price, regime.rebalance ? 1 : 0);
}

// ── Rebalance ─────────────────────────────────────────────────────────────────
async function executeRebalance(regime, { force = false } = {}) {
  const signer     = getSigner();
  const wallet     = signer.address;
  const regimeType = regime.regime;
  const targets    = ALLOCATIONS[regimeType];

  if (!targets) {
    await notify(`⚠️ Unknown regime type: ${regimeType}`);
    return;
  }

  // ── Guard 1: confidence閾値 ──────────────────────────────────────────────
  if (!force && (regime.confidence || 0) < CONFIDENCE_THRESHOLD) {
    await notify(
      `⏸️ **Low confidence (${regime.confidence}) — skipping rebalance**\n` +
      `Threshold: ${CONFIDENCE_THRESHOLD} | Regime: ${regimeType.toUpperCase()}`
    );
    return;
  }

  // ── Guard 2: regime確認 (2回連続同じregimeが出るまで待つ) ────────────────
  if (!force) {
    const recent = getRecentRegimes(CONFIRMATION_COUNT);
    const confirmed = recent.length >= CONFIRMATION_COUNT && recent.every(r => r === regimeType);
    if (!confirmed) {
      await notify(
        `⏸️ **Regime ${regimeType.toUpperCase()} not yet confirmed** (${recent.length}/${CONFIRMATION_COUNT} — waiting for next cycle)`
      );
      return;
    }
  }


  // ── Guard 3: RWAリスクチェック ───────────────────────────────────────────
  let rwaRisk = null;
  try {
    rwaRisk = await fetchRwaRisk(regimeType);
    if (rwaRisk.override === 'risk_off' && regimeType !== 'risk_off') {
      await notify(
        `🛡️ **RWA Override → RISK_OFF**\n` +
        `Score: ${rwaRisk.score}/100 | ExitDepth: $${rwaRisk.exitDepthTotal.toLocaleString()} (threshold: $${rwaRisk.exitDepthThreshold.toLocaleString()})\n` +
        `MaxDepeg: ${rwaRisk.maxDepeg}% | AvgUtil: ${rwaRisk.avgUtilization}%\n` +
        `Original regime: ${regimeType.toUpperCase()} → forced RISK_OFF`
      );
      regime = { ...regime, regime: 'risk_off', rwaOverride: true, rwaScore: rwaRisk.score };
      regimeType !== 'risk_off' && (regime.rebalance = true);
    } else if (rwaRisk.override === 'neutral_cap' && regimeType === 'risk_on') {
      await notify(
        `⚠️ **RWA Cap → NEUTRAL** (score ${rwaRisk.score}/100)\n` +
        `MaxDepeg: ${rwaRisk.maxDepeg}% | AvgUtil: ${rwaRisk.avgUtilization}%\n` +
        `risk_on blocked → downgraded to NEUTRAL`
      );
      regime = { ...regime, regime: 'neutral', rwaOverride: true, rwaScore: rwaRisk.score };
      regime.rebalance = true;
    } else {
      await notify(`✅ **RWA Check passed** — score=${rwaRisk.score}/100 override=none`);
    }
  } catch (e) {
    console.warn('[rwa] guard failed, proceeding without override:', e.message);
  }
  const finalRegimeType = regime.regime;
  const finalTargets    = ALLOCATIONS[finalRegimeType] || targets;

  // risk_on: Aave stable枠をeffectiveScore(APY×depeg割引×util割引)で動的に決定
  let resolvedTargets = [...finalTargets];
  try {
    const rwaData = JSON.parse(require('fs').readFileSync('./data/rwa_risk.json', 'utf8'));
    const scores = rwaData.stableScores || {};
    let bestSym = 'USDC', bestScore = -1, bestApy = 0;
    for (const [sym, s] of Object.entries(scores)) {
      if (s.effectiveScore > bestScore) { bestScore = s.effectiveScore; bestSym = sym; bestApy = s.apy; }
    }
    resolvedTargets = resolvedTargets.map(t =>
      t.inAave ? { ...t, token: bestSym, apy: bestApy } : t
    );
    await notify(`📊 **Aave best stable:** ${bestSym} @ ${bestApy.toFixed(2)}% APY (effectiveScore=${bestScore.toFixed(3)})`);
  } catch (e) {
    console.warn('[aave] APY check failed, defaulting to USDC:', e.message);
  }

  await notify(
    `🔄 **Rebalancing → ${finalRegimeType.toUpperCase()}**\n` +
    `BTC: $${regime.btc_price} | Phase: ${regime.phase} | Confidence: ${regime.confidence}\n` +
    `Targets: ${resolvedTargets.map(t => `${t.token}${t.inAave ? '(Aave)' : ''} ${(t.pct * 100).toFixed(0)}%`).join(', ')}\n` +
    `Reason: ${regime.reasoning}`
  );

  if (process.env.AUTO_REBALANCE !== 'true') {
    await notify('⏸️ **AUTO_REBALANCE=false** — dry-run only, no txs sent');
    savePositions({ regime: finalRegimeType, targets: resolvedTargets, updatedAt: new Date().toISOString() });
    return;
  }

  const BRIDGE_STABLE = 'USDC';

  // ── Step 1: Aave vault から不要なものをwithdraw ────────────────────────────
  const targetAaveSymbols = new Set(
    resolvedTargets.filter(t => t.inAave).map(t => t.token)
  );
  const aaveHoldings = await getAaveBalances(wallet);
  for (const h of aaveHoldings) {
    if (h.amount < 0.0001) continue;
    const sym = h.symbol.replace(/^a/, '');
    if (targetAaveSymbols.has(sym)) {
      console.log(`[rebalance] withdrawing ${h.symbol} for reallocation`);
    }
    try {
      await notify(`🏦 Withdrawing ${h.amount.toFixed(6)} ${h.symbol} from Aave`);
      await aaveWithdraw(sym, null);
      await notify(`✅ Withdrew ${h.symbol}`);
    } catch (e) {
      await notify(`⚠️ Aave withdraw failed (${h.symbol}): ${e.message?.slice(0, 80)}`);
    }
  }

  // ── Step 2: 不要なspot tokenをBRIDGE_STABLEにswap ────────────────────────
  const targetSpotSymbols = new Set(
    resolvedTargets.filter(t => !t.inAave).map(t => t.token)
  );
  const portfolio = await getPortfolio(wallet);
  for (const holding of portfolio) {
    if (targetSpotSymbols.has(holding.symbol)) continue;
    if (holding.symbol === BRIDGE_STABLE) continue;
    if (holding.symbol === 'MNT') continue; // gas reserve
    if (holding.amount < 0.0001) continue;
    try {
      await notify(`↩️ Selling ${holding.amount.toFixed(6)} ${holding.symbol} → ${BRIDGE_STABLE}`);
      const odosKey2 = holding.symbol + '→' + BRIDGE_STABLE;
      const moeKey2 = odosKey2;
      const txHash = ['METH→USDC','CMETH→USDC'].includes(odosKey2)
        ? await executeOdosSwap(holding.symbol, BRIDGE_STABLE, holding.amount * 0.999)
        : MOE_ROUTES[moeKey2]
          ? await executeMoeSwap(holding.symbol, BRIDGE_STABLE, holding.amount * 0.999)
          : await executeSwap(holding.symbol, BRIDGE_STABLE, holding.amount * 0.999);
      await notify(`✅ Sold ${holding.symbol} — [tx](https://explorer.mantle.xyz/tx/${txHash})`);
    } catch (e) {
      await notify(`⚠️ Swap failed ${holding.symbol}→${BRIDGE_STABLE}: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── Step 3: 目標spot tokenをswap取得 ──────────────────────────────────────
  const refreshed     = await getPortfolio(wallet);
  const stableBalance = refreshed.find(b => b.symbol === BRIDGE_STABLE)?.amount || 0;
  for (const target of resolvedTargets) {
    if (target.inAave) continue;
    if (target.token === BRIDGE_STABLE) continue;
    const alreadyHeld = refreshed.find(b => b.symbol === target.token);
    if (alreadyHeld && alreadyHeld.amount > 0.001) continue;
    const swapAmt = stableBalance * target.pct * 0.999;
    if (swapAmt < 0.001) continue;
    try {
      await notify(`→ Buying ${target.token} (${(target.pct*100).toFixed(0)}%) — ${swapAmt.toFixed(6)} ${BRIDGE_STABLE}`);
      const odosKey = BRIDGE_STABLE + '→' + target.token;
      const moeKey = odosKey;
      const txHash = ['USDC→METH','USDC→CMETH'].includes(odosKey)
        ? await executeOdosSwap(BRIDGE_STABLE, target.token, swapAmt)
        : MOE_ROUTES[moeKey]
          ? await executeMoeSwap(BRIDGE_STABLE, target.token, swapAmt)
          : await executeSwap(BRIDGE_STABLE, target.token, swapAmt);
      await notify(`✅ Bought ${target.token} — [tx](https://explorer.mantle.xyz/tx/${txHash})`);
    } catch (e) {
      await notify(`⚠️ Swap failed ${BRIDGE_STABLE}→${target.token}: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── Step 4: Aave deposit ───────────────────────────────────────────────────
  for (const target of resolvedTargets) {
    if (!target.inAave) continue;
    const afterSwap = await getPortfolio(wallet);
    const held = afterSwap.find(b => b.symbol === target.token);
    if (!held || held.amount < 0.001) continue;
    try {
      await notify(`🏦 Depositing ${held.amount.toFixed(6)} ${target.token} → Aave`);
      const txHash = await aaveDeposit(target.token, held.amount * 0.999);
      await notify(`✅ Deposited ${target.token} — [tx](https://explorer.mantle.xyz/tx/${txHash})`);
    } catch (e) {
      await notify(`⚠️ Aave deposit failed (${target.token}): ${e.message?.slice(0, 80)}`);
    }
  }

  savePositions({ regime: finalRegimeType, targets: resolvedTargets, updatedAt: new Date().toISOString() });
  await notify(`✅ **Rebalance complete** — Portfolio aligned to ${finalRegimeType.toUpperCase()}${regime.rwaOverride ? ` (RWA Override, score=${regime.rwaScore})` : ``}`);

  // ── On-chain audit trail ──────────────────────────────────────────────────
  try {
    const recorder  = getRecorder();
    const fromAsset = resolvedTargets?.[0]?.token || 'UNKNOWN';
    const toAsset   = finalRegimeType === 'risk_on' ? 'CMETH' : finalRegimeType === 'neutral' ? 'METH' : 'USDC';
    const rwaScore  = Math.round((rwaRisk?.score || 0) * 100);
    const tx = await recorder.recordRebalance(
      finalRegimeType,
      fromAsset,
      toAsset,
      0,
      rwaScore
    );
    await tx.wait();
    await notify(`🔗 **On-chain recorded** — [tx](https://explorer.mantle.xyz/tx/${tx.hash})`);
  } catch (e) {
    console.warn('[recorder] recordRebalance failed:', e.message?.slice(0, 80));
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function run() {
  await notify(
    `🚀 **StratumFlow Agent Started**\n` +
    `Interval: ${INTERVAL_MS / 60000} min | Wallet: ${new ethers.Wallet(process.env.PRIVATE_KEY).address}\n` +
    `Confidence threshold: ${CONFIDENCE_THRESHOLD} | Confirmation: ${CONFIRMATION_COUNT} cycles`
  );

  while (true) {
    try {
      console.log('\n[stratumflow] running regime detection...');
      const lastRegime = getLastRegime();          // save前に取得
      const regime     = await detectRegime();
      saveRegime(regime);
      // RWAリスク更新はexecuteRebalance内Guard3で実施済み（重複呼び出し防止）
      const regimeChanged   = lastRegime !== null && lastRegime !== regime.regime;
      const shouldRebalance = regime.rebalance || regimeChanged;

      if (!shouldRebalance) {
        await notify(`⏸️ **Hold** — regime=${regime.regime.toUpperCase()} confidence=${regime.confidence} (no change)`);
      } else {
        if (regimeChanged) {
          try {
            const recorder = getRecorder();
            const tx = await recorder.recordRegimeChange(lastRegime, regime.regime, Math.round((regime.confidence || 0) * 100));
            await tx.wait();
            console.log('[recorder] recordRegimeChange tx:', tx.hash);
          } catch (e) {
            console.warn('[recorder] recordRegimeChange failed:', e.message?.slice(0, 80));
          }
        }
        await executeRebalance(regime);
      }
    } catch (e) {
      console.error('[stratumflow] loop error:', e.message);
      await notify(`⚠️ **Agent Error** — ${e.message?.slice(0, 100)}`);
    }

    console.log(`[stratumflow] next run in ${INTERVAL_MS / 60000} min`);
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  executeRebalance,
  fetchRwaRisk,
  getPortfolio,
  getSwapQuote,
  getBestAaveStableApy,
  getAllAaveStableApys,
  getAaveBalances,
  loadPositions,
  getLastRegime,
};

if (require.main === module) {
  run().catch(e => {
    console.error('[stratumflow] fatal:', e.message);
    process.exit(1);
  });
}
