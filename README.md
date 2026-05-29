# StratumFlow

**AI-driven RWA portfolio rebalancer on Mantle** — a Triple-A agent council reads BTC market regime in real time and automatically rebalances between cmETH, mETH, and Aave stable yield. A dedicated RWA Risk Score engine monitors on-chain liquidity depth and stablecoin health, overriding the regime signal when exit conditions deteriorate.

🎥 **Demo:** _[coming soon]_  
🌐 **Live:** https://stratumflow.a2aflow.space

---

## Overview

StratumFlow continuously monitors BTC market conditions and dynamically allocates a Mantle-native portfolio across three regime states:

| Regime | Allocation | Strategy |
|--------|-----------|----------|
| **Risk On** | cmETH 70% / highest-yield Aave stable 30% | Maximize ETH beta exposure |
| **Neutral** | mETH 50% / USDY 50% | Balanced yield, preserve optionality |
| **Risk Off** | USDY 70% / USDC 30% | Preserve capital, minimize drawdown |

Aave stable allocation dynamically selects the **highest-score stable** (USDC/USDT0/GHO/USDe) by blended APY including Merkl incentives, penalized for depeg risk and utilization.

---

## Architecture

```
BTC Market Data (Hyperliquid)
        │
        ▼
┌───────────────────────────────────┐
│         Triple-A Council          │
│                                   │
│  Architect  →  Auditor  →  Arbiter│
│  (bullish?)    (challenge) (verdict)│
└───────────────┬───────────────────┘
                │ regime signal
                ▼
        RWA Risk Override Engine
        (exit depth + depeg + util)
                │
                ▼
        executeRebalance()
                │
        ┌───────┴────────┐
        │                │
   Odos v3 SOR      Aave v3 Pool
  (cmETH/mETH       (deposit /
   swaps)            withdraw)
        │                │
        └───────┬────────┘
                ▼
        Mantle Wallet
```

---

## How It Works

### 1. Regime Detection (`regime.js`)
Every 15 minutes, the **Triple-A council** evaluates BTC market signals:
- ATR%, funding rate, OI change, signal score (−3 to +3)
- **Architect** builds the bull/bear case
- **Auditor** challenges the hypothesis
- **Arbiter** renders the final verdict → `risk_on` / `neutral` / `risk_off`

### 2. RWA Risk Score (`agent.js`)
A parallel scoring engine monitors RWA-specific risks and can **override the regime signal**:

```
RWA Score = exitDepth(50%) + stableDepeg(30%) + stableUtil(20%)
```

| Score | Override Action |
|-------|----------------|
| ≥ 70 or exit depth < $200K | Force RISK_OFF |
| 50–69 | Cap at NEUTRAL (block RISK_ON) |
| < 50 | No override — BTC regime applies |

**Exit Depth** is measured via Odos SOR price impact for $100K and $500K cmETH/mETH swaps. During the Bybit hack (Feb 2025), DEX depth was the only real-time exit indicator — direct redemption (cmETH→mETH→ETH) has an 8-hour delay.

### 3. Rebalance Execution (`agent.js`)
On regime change (or manual trigger):
1. Withdraw all aTokens from Aave
2. Sell existing holdings → USDC via Odos v3
3. Buy target allocation tokens via Odos v3
4. Deposit stable portion → Aave best-score stable

### 4. Stable Selection Scoring
Each Aave stable is scored 0–100:
```
score = APY(40%) + Depeg(35%) + Util(25%)
  APY  : min(apy / 8, 1) × 40             — 8% = full marks
  Depeg: (1 − min(depeg / 1.0, 1)) × 35   — 1% off-peg = 0
  Util : (1 − min(util / 95, 1)) × 25     — 95% = 0 (Aave danger threshold)
```

---

## RWA Tab

The `/rwa` page provides real-time visibility into the override engine:

- **RWA Risk Score** — composite score with metric breakdown cards and horizontal gauge
- **Exit Depth** — live Odos SOR impact for $100K/$500K swaps, 24h chart, backing asset summary
- **Risk Context** — Bybit hack case study as liquidity stress reference
- **Aave Stable Selection** — ranked table with APY / util / depeg / score-100

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Mantle (chainId 5000) |
| Liquid Staking | cmETH (Veda/EigenLayer/Karak/Symbiotic), mETH |
| RWA Stable | USDY (Ondo Finance) |
| Stable Yield | Aave v3 (USDC / USDT0 / GHO / USDe) |
| DEX Routing | Odos v3 SOR |
| AI Council | Gemini (Architect) / OpenRouter (Auditor) / Gemini (Arbiter) |
| APY Data | DefiLlama + Aave on-chain + Merkl API |
| Liquidity Data | Odos SOR (price impact simulation) |
| A2A Protocol | Google A2A (`/.well-known/agent.json`) |
| Backend | Node.js + ethers v6 |
| Frontend | Vanilla JS + SSE (real-time log streaming) |

---

## Setup

```bash
git clone https://github.com/cryptohakka/stratumflow
cd stratumflow
npm install
cp .env.example .env
# fill in .env
npm start
```

### `.env` variables

```
RPC_URL=https://rpc.mantle.xyz
PRIVATE_KEY=0x...
ODOS_API_KEY=...
OPENROUTER_API_KEY=...
GEMINI_API_KEY=...
MERKL_API_KEY=...

# Token addresses (Mantle)
MNT=0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000
METH=0xcDA86A272531e8640cD7F1a92c01839911B90bb0
CMETH=0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA
USDY=0x5bE26527e817998A7206475496fDE1E68957c5A6
USDC=0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9
USDT0=0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC
GHO=0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73
USDE=0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34

# Aave aToken addresses
AAVE_AUSDC=0xcb8164415274515867ec43CbD284ab5d6d2b304F
AAVE_AUSDT0=0x7053bAD224F0C021839f6AC645BdaE5F8b585b69
AAVE_AGHO=0x8917d4eE4609f991b559DAF8D0aD1b892c13B127
AAVE_AUSDE=0xb9aCA933C9c0aa854a6DBb7b12f0CC3FdaC15ee7

# Merchant Moe LB Router (exit depth)
MOE_LB_ROUTER=0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a
MOE_LB_QUOTER=0x501b8AFd35df20f531fF45F6f695793AC3316c85

AUTO_REBALANCE=true
REBALANCE_INTERVAL_MS=900000
```

---

## API

### UI Server (port 5004)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/regime` | Current regime + council reasoning |
| GET | `/api/balances` | Wallet holdings + Aave positions with USD |
| GET | `/api/yields` | APY data for all tokens |
| GET | `/api/snapshots` | BTC market snapshots (last 8) |
| GET | `/api/liquidity` | Exit depth — live Odos SOR price impact |
| GET | `/api/liquidity/history` | 24h exit depth history |
| GET | `/api/rwa-risk` | RWA risk score + override status |
| POST | `/api/regime-check` | Trigger immediate regime evaluation |
| POST | `/api/rebalance` | Trigger immediate rebalance |
| POST | `/api/force-regime` | Override regime `{"regime":"risk_on"}` |
| GET | `/events` | SSE stream for live log |

### A2A Server (port 5005)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/.well-known/agent.json` | A2A agent card |
| POST | `/a2a/tasks/send` | Send rebalance/regime task |
| GET | `/a2a/health` | Health check |

---

## License

MIT
