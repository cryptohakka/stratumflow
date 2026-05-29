# StratumFlow

**Autonomous AI allocator for Mantle yield-bearing assets with liquidity-aware risk management.**

Live: [stratumflow.a2aflow.space](https://stratumflow.a2aflow.space)

---

## Why It Matters

Most AI allocators optimize for yield and price trends — but ignore the hardest problem in on-chain portfolios:

**Can you actually exit during stress?**

Liquid staking and yield-bearing assets can appear stable until liquidity suddenly disappears. During the Bybit liquidity shock in Feb 2025, secondary-market exit depth became more important than headline APY.

StratumFlow treats liquidity as a first-class risk signal — not an afterthought.

The system continuously measures:
- DEX exit depth (Odos SOR, $100K swap impact)
- Stablecoin depeg risk (live peg tracking)
- Aave utilization stress (liquidation proximity)

...and can **override bullish market signals** before liquidity conditions deteriorate further.

---

## Overview

StratumFlow is a Triple-A AI-driven portfolio rebalancer built on Mantle's RWA infrastructure. It runs a continuous regime detection loop — analyzing BTC market signals via a three-agent debate council — and autonomously rebalances between Mantle's yield-bearing assets according to the detected regime.

Regime detection runs every 30 minutes. A2A-compatible API allows external agent orchestration.

---

## Asset Allocation

| Regime | cmETH | mETH | Aave Stable (dynamic) |
|--------|-------|------|-----------------------|
| Risk-on | 70% | — | 30% |
| Neutral | — | 50% | 50% |
| Risk-off | — | — | 100% |

**Dynamic stable selection:** At execution time, the system evaluates all Aave stables on Mantle (USDe, USDC, USDT0, GHO) by a composite risk-adjusted score:

```
StableScore = APY×0.40 + (1 − DepegRisk)×0.35 + (1 − UtilStress)×0.25
```

Util threshold: penalized above 95%. The highest-scoring stable is selected for execution.

---

## Triple-A Agent Council

```
Architect  →  proposes
Auditor    →  challenges
Arbiter    →  decides
```

Each regime evaluation triggers a structured adversarial debate:

1. **Architect** — analyzes BTC price action, funding rate, OI delta, and momentum signals. Proposes a regime with bullish/bearish thesis.
2. **Auditor** — challenges the proposal. Identifies contradicting signals, tail risks, and overconfidence.
3. **Arbiter** — weighs both sides and delivers a final verdict: regime + confidence score + rationale.

Decisions below 60% confidence are flagged as **UNCERTAIN** and can block automatic execution.

---

## RWA Risk Engine

The `/rwa` tab exposes the live risk engine that can override regime signals:

### RWA Risk Score

Composite score (0–1) measuring portfolio exit safety:

```
RWA Score = exitNorm×0.50 + depegNorm×0.30 + utilNorm×0.20

exitNorm  = 1 − min(exitDepth / 200,000, 1.0)   (omitted if no data)
depegNorm = min(maxDepeg / 2.0, 1.0)
utilNorm  = min(avgUtil / 90.0, 1.0)
```

### Exit Depth (via Odos SOR)

Live simulation of a $100K swap's price impact on the current regime's primary asset (cmETH in risk-on, mETH in neutral). If the swap would move price by more than 2%, an **override** blocks risk-on execution regardless of the regime signal.

### Override Rules

| Condition | Action |
|-----------|--------|
| Score ≥ 70 or exit depth < $200K | Force RISK_OFF |
| Score 50–69 | Cap at NEUTRAL (block RISK_ON) |
| Score < 50 | No override — BTC regime applies |
| $100K swap impact > 2% | Exclude from exit depth score |

This is the core differentiator: **automated risk management that constrains the AI's own bullish signals.**

---

## Key Innovations

- AI multi-agent adversarial council (Architect / Auditor / Arbiter)
- Liquidity-aware RWA override engine with live Odos exit-depth simulation
- Risk-adjusted stablecoin selection across Mantle Aave pools
- Regime-gated allocation with confidence thresholds
- A2A-compatible API for multi-agent orchestration — external agents can query regime state, trigger rebalances, or coordinate execution flows
- Autonomous execution on Mantle via Odos SOR with Merchant Moe LB Router fallback

---

## Architecture

```
BTC signals (price, funding, OI, news)
        │
   ┌────▼────────────────────┐
   │   Triple-A Council      │  ← continuous 30min autonomous loop
   │  Architect→Auditor→Arbiter │
   └────────────┬────────────┘
                │ regime + confidence
   ┌────────────▼────────────┐
   │   RWA Override Engine   │  ← real-time
   │  exit depth / depeg /   │
   │  aave util              │
   └────────────┬────────────┘
                │ final allocation
   ┌────────────▼────────────┐
   │  Execution              │
   │  Merchant Moe LB Router │
   │  cmETH / mETH / Aave    │
   └─────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Chain | Mantle |
| Yield assets | cmETH, mETH |
| Stable yield | Aave (USDe / USDC / USDT0 / GHO) — dynamic |
| DEX routing | Odos SOR (primary), Merchant Moe LB Router (fallback) |
| Price / liquidity | DefiLlama, Odos price impact API |
| AI council | OpenRouter (Gemini) |
| A2A protocol | A2A / MCP compatible |
| Backend | Node.js |
| Frontend | Vanilla JS, SSE live log |

---

## Contract Addresses (Mantle)

| Token | Address |
|-------|---------|
| mETH | `0xcDA86A272531e8640cD7F1a92c01839911B90bb0` |
| cmETH | `0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA` |
| USDe | `0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34` |
| USDC | `0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9` |
| USDT0 | `0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC` |
| GHO | `0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73` |
| MoeLBRouter | `0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a` |
| LBQuoter | `0x501b8AFd35df20f531fF45F6f695793AC3316c85` |

---

## API Reference

### Portfolio Server (port 5004)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/regime` | Current regime + council output |
| GET | `/api/balances` | Portfolio holdings |
| GET | `/api/yields` | Live APY data |
| GET | `/api/rwa-risk` | RWA risk score + override status |
| GET | `/api/liquidity/history` | 24h exit depth history |
| POST | `/api/regime-check` | Trigger immediate regime evaluation |
| POST | `/api/rebalance` | Trigger immediate rebalance |
| POST | `/api/force-regime` | Override regime `{"regime":"risk_on"}` |
| GET | `/events` | SSE stream (live log + regime updates) |

### A2A Server (port 5005)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/.well-known/agent.json` | A2A agent card |
| POST | `/a2a/tasks/send` | Send rebalance / regime task |
| GET | `/a2a/health` | Health check |

---

## Future Work

- Cross-chain allocation across Mantle and other yield-bearing ecosystems
- Autonomous hedging during detected liquidity stress
- Intent-based execution routing
- Vaultization (ERC-4626) for external capital
- DAO-governed risk parameters

---

## Demo

🎥 Demo: coming soon

---

## Agent Identity

StratumFlow is registered on the ERC-8004 Identity Registry as a verifiable on-chain AI agent.

- **Agent ID:** [Mantle #107](https://8004scan.io/agents/mantle/107)
- **Wallet:** `0x694fF912a9558b97e28135546c33cd85a3cd5325`
- **RebalanceRecorder:** [`0x3d99E72229BF6DD14697751971C81D93529BeEff`](https://explorer.mantle.xyz/address/0x3d99E72229BF6DD14697751971C81D93529BeEff)

## License

MIT
