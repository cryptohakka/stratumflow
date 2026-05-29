require('dotenv').config();
const express = require('express');
const { detectRegime }       = require('./regime');
const { executeRebalance, getPortfolio, getBestAaveStableApy, loadPositions } = require('./agent');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = parseInt(process.env.A2A_PORT) || 5005;

const REGIME_PATH = path.join(__dirname, 'regime.json');

app.use(express.json());

// ── Agent Card (A2A discovery) ────────────────────────────────────────────────
const AGENT_CARD = {
  name: 'StratumFlow',
  description: 'Autonomous DeFi portfolio manager on Mantle. Detects BTC market regime via Triple-A multi-agent framework and rebalances between cmETH, mETH, and Aave stablecoins on Mantle.',
  url: process.env.A2A_BASE_URL || 'https://stratumflow.a2aflow.space',
  version: '1.0.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  skills: [
    {
      id: 'get_regime',
      name: 'Get current market regime',
      description: 'Returns the current BTC market regime (risk_on / neutral / risk_off) with confidence, phase, and agent council reasoning.',
      examples: ['What is the current regime?', 'Is the market risk-on or risk-off?'],
    },
    {
      id: 'run_regime_check',
      name: 'Run regime detection',
      description: 'Triggers a fresh Triple-A regime detection cycle (Architect → Auditor → Arbiter) and returns the result.',
      examples: ['Run a regime check', 'Detect current BTC regime'],
    },
    {
      id: 'get_portfolio',
      name: 'Get portfolio holdings',
      description: 'Returns current token balances on Mantle for the managed wallet.',
      examples: ['Show portfolio', 'What tokens do I hold?'],
    },
    {
      id: 'rebalance',
      name: 'Execute rebalance',
      description: 'Rebalances the portfolio to match the current regime allocation targets.',
      examples: ['Rebalance the portfolio', 'Execute rebalance'],
    },
    {
      id: 'get_aave_apy',
      name: 'Get Aave V3 Mantle APY',
      description: 'Returns the best supply APY across USDC, USDe, USDT0, GHO on Aave V3 Mantle.',
      examples: ['What is the best Aave APY?', 'Show stable yields on Mantle'],
    },
  ],
};

// ── A2A Agent Card endpoint ───────────────────────────────────────────────────
app.get('/.well-known/agent.json', (req, res) => {
  res.json(AGENT_CARD);
});

// ── Task dispatch ─────────────────────────────────────────────────────────────
async function dispatch(skillId, params) {
  switch (skillId) {

    case 'get_regime': {
      let regime = {};
      try { regime = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')); } catch {}
      return {
        regime:        regime.regime || null,
        confidence:    regime.confidence || null,
        phase:         regime.phase || null,
        bias:          regime.bias || null,
        rebalance:     regime.rebalance || false,
        reasoning:     regime.reasoning || null,
        btc_price:     regime.btc_price || null,
        funding_rate:  regime.funding_rate || null,
        atr_pct:       regime.atr_pct || null,
        signal_score:  regime.signal_score || null,
        council:       regime.council || null,
        updated_at:    regime.updated_at || null,
      };
    }

    case 'run_regime_check': {
      const regime = await detectRegime();
      return {
        regime:       regime.regime,
        confidence:   regime.confidence,
        phase:        regime.phase,
        reasoning:    regime.reasoning,
        btc_price:    regime.btc_price,
        rebalance:    regime.rebalance,
        updated_at:   regime.updated_at,
      };
    }

    case 'get_portfolio': {
      const wallet   = process.env.WALLET_ADDRESS;
      const holdings = await getPortfolio(wallet);
      return { wallet, holdings };
    }

    case 'rebalance': {
      let regime = {};
      try { regime = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')); } catch {}
      if (!regime.regime) throw new Error('No regime data — run regime_check first');
      await executeRebalance(regime);
      return { ok: true, regime: regime.regime };
    }

    case 'get_aave_apy': {
      const best = await getBestAaveStableApy();
      return best;
    }

    default:
      throw new Error('Unknown skill: ' + skillId);
  }
}

// ── A2A tasks/send endpoint ───────────────────────────────────────────────────
app.post('/a2a/tasks/send', async (req, res) => {
  const { id, skill, params } = req.body || {};

  if (!skill) {
    return res.status(400).json({
      id,
      status: { state: 'failed', message: { role: 'agent', parts: [{ text: 'skill is required' }] } },
    });
  }

  try {
    const result = await dispatch(skill, params || {});
    res.json({
      id,
      status: {
        state: 'completed',
        message: {
          role:  'agent',
          parts: [{ text: JSON.stringify(result, null, 2) }],
        },
      },
      result,
    });
  } catch (e) {
    console.error('[a2a] error:', e.message);
    res.status(500).json({
      id,
      status: {
        state:   'failed',
        message: { role: 'agent', parts: [{ text: e.message }] },
      },
    });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/a2a/health', (req, res) => {
  let regime = null;
  try { regime = JSON.parse(fs.readFileSync(REGIME_PATH, 'utf8')).regime; } catch {}
  res.json({ ok: true, regime, ts: new Date().toISOString() });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('[a2a-server] :' + PORT);
});

process.on('uncaughtException',  e => console.error('[a2a uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[a2a unhandled]', e));
