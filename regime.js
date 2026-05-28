require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
const HL_URL             = 'https://api.hyperliquid.xyz/info';
const SNAPSHOTS_PATH     = './snapshots.json';
const REGIME_PATH        = './regime.json';
const MAX_SNAPSHOTS      = 24; // 24h at 1h intervals

const WEBHOOKS = {
  architect: process.env.DISCORD_ARCHITECT_WEBHOOK,
  auditor:   process.env.DISCORD_AUDITOR_WEBHOOK,
  arbiter:   process.env.DISCORD_ARBITER_WEBHOOK,
  system:    process.env.DISCORD_SYSTEM_WEBHOOK,
};

// ── OpenRouter inference ──────────────────────────────────────────────────────
async function infer(messages, maxTokens = 800, agentName = 'Arcana') {
  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { model: OPENROUTER_MODEL, messages, max_tokens: maxTokens },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://stratumflow.a2aflow.space',
        'X-Title': `StratumFlow ${agentName}`,
      }
    }
  );
  return response.data.choices[0].message.content;
}

// ── Discord webhook ───────────────────────────────────────────────────────────
async function sendAsAgent(role, content) {
  const url = WEBHOOKS[role];
  const nameMap = {
    architect: '🏛️ Architect',
    auditor:   '🔍 Auditor',
    arbiter:   '⚖️ Arbiter',
    system:    '🤖 System',
  };
  // broadcast to Live Log (summary: first 300 chars)
  if (global._broadcast) {
    const label = nameMap[role] || role;
    const summary = content.replace(/\*\*/g,'').replace(/\*/g,'').replace(/`{1,3}/g,'').replace(/\n+/g,' ').trim().slice(0,300);
    global._broadcast({ type:'log', line: `[${label}] ${summary}` });
  }
  if (!url) return;
  const chunks = content.match(/[\s\S]{1,1900}/g) || [content];
  for (const chunk of chunks) {
    await axios.post(url, { content: chunk, username: nameMap[role] })
      .catch(e => console.error(`[webhook:${role}]`, e.message));
  }
}

// ── Snapshots ─────────────────────────────────────────────────────────────────
function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(SNAPSHOTS_PATH, 'utf8')); }
  catch { return []; }
}

function saveSnapshots(snaps) {
  fs.writeFileSync(SNAPSHOTS_PATH, JSON.stringify(snaps.slice(-MAX_SNAPSHOTS), null, 2));
}

function computeDeltas(current, snaps) {
  const deltas = {};
  if (!snaps.length) return deltas;

  const prev = snaps.length >= 3 ? snaps[snaps.length - 3] : snaps[0]; // 3h ago (1h intervals)

  if (prev.mark_price > 0)
    deltas.price_change_pct_3h = +((current.mark_price - prev.mark_price) / prev.mark_price * 100).toFixed(3);
  if (prev.open_interest > 0)
    deltas.oi_change_pct_3h = +((current.open_interest - prev.open_interest) / prev.open_interest * 100).toFixed(3);
  if (prev.funding_rate != null)
    deltas.funding_delta_3h = +(current.funding_rate - prev.funding_rate).toFixed(8);

  if (snaps.length >= 2) {
    const oldest = snaps[0]; // 24h ago
    if (oldest.mark_price > 0)
      deltas.price_change_pct_24h = +((current.mark_price - oldest.mark_price) / oldest.mark_price * 100).toFixed(3);
    if (oldest.open_interest > 0)
      deltas.oi_change_pct_24h = +((current.open_interest - oldest.open_interest) / oldest.open_interest * 100).toFixed(3);
    if (oldest.funding_rate != null)
      deltas.funding_delta_24h = +(current.funding_rate - oldest.funding_rate).toFixed(8);
  }

  // OI interpretation
  const oi3h = deltas.oi_change_pct_3h || 0;
  const fr   = current.funding_rate;
  const priceUp = (deltas.price_change_pct_3h || 0) > 0;
  if      (fr > 0.0001 && oi3h > 1.0)  deltas.oi_interpretation = 'long_build';
  else if (fr < -0.0001 && oi3h > 1.0) deltas.oi_interpretation = 'short_build';
  else if (priceUp && oi3h < -2.0)      deltas.oi_interpretation = 'short_squeeze';
  else if (priceUp && oi3h > 3.0)       deltas.oi_interpretation = 'long_trap';
  else                                   deltas.oi_interpretation = 'mixed';

  return deltas;
}

// ── BTC market data ───────────────────────────────────────────────────────────
async function getBtcData(snaps) {
  const r = await axios.post(HL_URL, { type: 'metaAndAssetCtxs' }, { timeout: 10000 });
  const [meta, ctxs] = r.data;
  const idx = meta.universe.findIndex(a => a.name === 'BTC');
  const ctx = ctxs[idx];

  // ATR from candles
  let atr_pct = 1.0;
  try {
    const candleRes = await axios.post(HL_URL, {
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '1h', startTime: Date.now() - 15 * 3600 * 1000 }
    }, { timeout: 10000 });
    const candles = candleRes.data;
    if (candles.length >= 14) {
      const trs = candles.map((c, i) => {
        if (i === 0) return parseFloat(c.h) - parseFloat(c.l);
        const prev = candles[i - 1];
        return Math.max(
          parseFloat(c.h) - parseFloat(c.l),
          Math.abs(parseFloat(c.h) - parseFloat(prev.c)),
          Math.abs(parseFloat(c.l) - parseFloat(prev.c))
        );
      });
      const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
      atr_pct = +(atr / parseFloat(ctx.markPx) * 100).toFixed(4);
    }
  } catch (e) {
    console.warn('[atr] fetch failed, using default:', e.message);
  }

  const current = {
    mark_price:    parseFloat(ctx.markPx),
    funding_rate:  parseFloat(ctx.funding),
    open_interest: parseFloat(ctx.openInterest),
    premium:       parseFloat(ctx.premium || 0),
    atr_pct,
    ts: new Date().toISOString(),
  };

  current.deltas = computeDeltas(current, snaps);
  return current;
}

// ── Signal score ──────────────────────────────────────────────────────────────
function computeSignalScore(btc) {
  const atrScore = btc.atr_pct < 0.5 ? 1 : btc.atr_pct > 1.2 ? -1 : 0;
  const frScore  = btc.funding_rate > 0.0001 ? 1 : btc.funding_rate < -0.0001 ? -1 : 0;
  const oiChg    = btc.deltas.oi_change_pct_3h || 0;
  const oiScore  = oiChg > 2 ? 1 : oiChg < -2 ? -1 : 0;
  return { score: atrScore + frScore + oiScore, detail: `ATR:${atrScore} FR:${frScore} OI:${oiScore}` };
}

// ── Regime detection (3-agent flow) ──────────────────────────────────────────
async function detectRegime() {
  console.log('=== regime detection start ===');

  const snaps = loadSnapshots();
  const btc = await getBtcData(snaps);
  const { score: signalScore, detail: signalDetail } = computeSignalScore(btc);
  const d = btc.deltas;

  const btcSummary = `BTC: $${btc.mark_price} | FR: ${(btc.funding_rate * 100).toFixed(4)}% | OI: ${btc.open_interest} | ATR: ${btc.atr_pct}%`;
  const deltaSection = Object.keys(d).length
    ? `\nΔ(3h): price=${d.price_change_pct_3h ?? 'N/A'}% OI=${d.oi_change_pct_3h ?? 'N/A'}% FR=${d.funding_delta_3h ?? 'N/A'} | Δ(24h): price=${d.price_change_pct_24h ?? 'N/A'}% | OI interp: ${d.oi_interpretation}`
    : '\nΔ: accumulating (first run)';

  await sendAsAgent('system', `📊 **Regime Detection Started**\n${btcSummary}${deltaSection}`);

  // ── Round 1: Architect ──
  const architectPrompt = `You are Architect, a market analyst for a cross-chain portfolio manager.

Analyze current BTC market data and structure the market regime.

Market Data:
- Price: $${btc.mark_price}
- Funding Rate: ${(btc.funding_rate * 100).toFixed(4)}%
- Open Interest: ${btc.open_interest}
- ATR: ${btc.atr_pct}%
${deltaSection}

Provide:
1. Structured market analysis (bull / range / bear case)
2. Primary scenario (most likely regime)
3. Contrarian scenario (what if the primary is wrong?)

For portfolio management context: determine if conditions favor RISK-ON (deploy into cmETH + highest Aave stable yield on Mantle) or RISK-OFF (consolidate into USDY/USDC stable yield on Mantle).

Be concise, 3-5 sentences. Start directly with your analysis — no preamble like 'Here is my analysis'.`;

  const architectReply = await infer([{ role: 'user', content: architectPrompt }], 600, 'Architect');
  await sendAsAgent('architect', `**Round 1 — Analysis**\n${architectReply}`);

  // ── Round 2: Auditor ──
  const auditorPrompt = `You are Auditor, a critical reviewer for a portfolio management AI.

Challenge the following market analysis. Find flaws, missing context, or overconfident assumptions.

Market Data: ${btcSummary}${deltaSection}

Architect's Analysis:
${architectReply}

Identify weaknesses in the analysis and conclude with your own view: is the market RISK-ON or RISK-OFF right now?
Be critical and concise, 3-5 sentences. Start directly with your critique — no preamble like 'As Auditor' or 'I find'.`;

  const auditorReply = await infer([{ role: 'user', content: auditorPrompt }], 600, 'Auditor');
  await sendAsAgent('auditor', `**Round 2 — Review**\n${auditorReply}`);

  // ── Round 3: Arbiter ──
  const arbiterPrompt = `You are Arbiter, the final decision maker for a cross-chain portfolio manager.

Based on the analysis and review below, make a final portfolio regime decision.

Market Data: ${btcSummary}${deltaSection}
Signal Score: ${signalDetail} => total: ${signalScore >= 0 ? '+' : ''}${signalScore}

Architect: ${architectReply}
Auditor: ${auditorReply}

Return ONLY valid JSON, no explanation outside the JSON:
{
  "regime": "risk_on" | "neutral" | "risk_off",
  "confidence": 0.0-1.0,
  "phase": "bull" | "range" | "bear",
  "bias": "long" | "short" | "neutral",
  "rebalance": true | false,
  "reasoning": "one sentence explanation"
}

Rules:
- risk_on: deploy capital into highest-yield vaults
- risk_off: consolidate into USYC stable yield
- rebalance: true if regime changed or confidence > 0.7
- confidence reflects Auditor's criticism strength (stronger criticism = lower confidence)`;

  const arbiterRaw = await infer([{ role: 'user', content: arbiterPrompt }], 400, 'Arbiter');
  // raw log deferred until after parse

  // Parse JSON
  const match = arbiterRaw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Arbiter JSON parse failed: ' + arbiterRaw);
  const result = JSON.parse(match[0]);

  // Validate
  if (["risk_on","neutral","risk_off"].indexOf(result.regime) === -1) result.regime = "neutral";
  if (typeof result.confidence !== 'number') result.confidence = 0.5;
  if (!['bull', 'range', 'bear'].includes(result.phase)) result.phase = 'range';
  if (!['long', 'short', 'neutral'].includes(result.bias)) result.bias = 'neutral';

  // Auditor penalty
  const negWords = ['wrong', 'flawed', 'overconfident', 'missing', 'insufficient', 'unreliable', 'risky', 'danger', 'contradiction', 'weak'];
  const negCount = negWords.filter(w => auditorReply.toLowerCase().includes(w)).length;
  if (negCount >= 3 && result.confidence > 0.6) {
    const penalty = Math.min(negCount * 0.03, 0.15);
    result.confidence = Math.round((result.confidence - penalty) * 100) / 100;
    console.log(`[confidence] Auditor penalty: ${negCount} neg words, -${penalty} => ${result.confidence}`);
  }

  // Save regime
  const regime = {
    ...result,
    signal_score: signalScore,
    btc_price: btc.mark_price,
    atr_pct: btc.atr_pct,
    funding_rate: btc.funding_rate,
    oi_change: btc.deltas?.oi_change_pct_3h ?? null,
    updated_at: new Date().toISOString(),
    council: (() => {
      const sentiment = s => {
        const t = s.toLowerCase();
        if(t.includes('bullish') || t.includes('risk-on') || t.includes('upward')) return 'bullish';
        if(t.includes('bearish') || t.includes('risk-off') || t.includes('downward')) return 'bearish';
        return 'neutral';
      };
      const clean = s => s.replace(/#{1,3}[^\n]*/g,'').replace(/\*\*/g,'').replace(/\*\s/g,'').replace(/\d+\.[^\n]*/g,'').replace(/\n+/g,' ').trim();
      const first = s => (clean(s).match(/[^.!?]+[.!?]/)?.[0] || clean(s).slice(0, 100)).trim();
      return {
        architect: sentiment(architectReply) + ' — ' + clean(architectReply).slice(0, 90).trim() + '...',
        auditor:   (auditorReply.toLowerCase().includes('agree') ? 'agrees' : 'challenges') + ' — ' + clean(auditorReply).slice(0, 90).trim() + '...',
        arbiter:   first(result.reasoning || arbiterRaw),
      };
    })(),
  };
  fs.writeFileSync(REGIME_PATH, JSON.stringify(regime, null, 2));

  // Summary to Discord
  const emoji = result.regime === "risk_on" ? "🟢" : result.regime === "neutral" ? "🟡" : "🔴";
  const rebalanceStr = result.rebalance ? '✅ Rebalance triggered' : '⏸️ Hold current allocation';
  await sendAsAgent('arbiter', `${emoji} **Final Decision: ${result.regime.toUpperCase()}**\nPhase: ${result.phase} | Confidence: ${result.confidence} | Bias: ${result.bias}\n${result.reasoning}\n${rebalanceStr}`);

  // Update snapshot
  const { deltas: _, ...snap } = btc;
  snaps.push(snap);
  saveSnapshots(snaps);

  console.log(`[regime] ${result.regime} (confidence=${result.confidence}) rebalance=${result.rebalance}`);
  return regime;
}

module.exports = { detectRegime };

// Run directly
if (require.main === module) {
  detectRegime().catch(e => {
    console.error('regime detection failed:', e.message);
    process.exit(1);
  });
}
