# StratumFlow

**AI-driven RWA portfolio rebalancer on Mantle** — a Triple-A agent council reads BTC market regime in real time and automatically rebalances between cmETH, mETH, and Aave stable yield.

🎥 **Demo:** _[coming soon]_  
🌐 **Live:** https://stratumflow.a2aflow.space

---

## Overview

StratumFlow continuously monitors BTC market conditions and dynamically allocates a Mantle-native portfolio across three regime states:

| Regime | Allocation | Strategy |
|--------|-----------|----------|
| **Risk On** | cmETH 70% / USDC(Aave) 30% | Maximize ETH beta exposure |
| **Neutral** | mETH 50% / USDC(Aave) 50% | Balanced yield, preserve optionality |
| **Risk Off** | USDC(Aave) 100% | Preserve capital, minimize drawdown |

Aave stable allocation always routes to the **highest-yield stable** (USDC/USDT0/GHO/USDe) dynamically selected by blended APY including Merkl incentives.

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
Every 30 minutes, the **Triple-A council** evaluates BTC market signals:
- ATR%, funding rate, OI change, signal score (−3 to +3)
- **Architect** builds the bull/bear case
- **Auditor** challenges the hypothesis
- **Arbiter** renders the final verdict → `risk_on` / `neutral` / `risk_off`

### 2. Rebalance Execution (`agent.js`)
On regime change (or manual trigger):
1. Withdraw all aTokens from Aave
2. Sell existing holdings → USDC via Odos v3
3. Buy target allocation tokens via Odos v3
4. Deposit stable portion → Aave best yield

### 3. Yield Optimization
- **cmETH / mETH APY**: DefiLlama
- **Aave stable APY**: Aave v3 on-chain RAY + Merkl incentives
- Blended APY calculated per regime and displayed in UI

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Mantle (chainId 5000) |
| Liquid Staking | cmETH (Veda/EigenLayer/Karak/Symbiotic), mETH |
| Stable Yield | Aave v3 (USDC / USDT0 / GHO / USDe) |
| DEX Routing | Odos v3 SOR |
| AI Council | Gemini (Architect) / OpenRouter (Auditor) / Gemini (Arbiter) |
| APY Data | DefiLlama + Aave on-chain + Merkl API |
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
USDC=0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9
USDT0=0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE
GHO=0xb4d5a1E15D5b36b6c7a1D53401b63dEc6F2CF3C
USDE=0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34

# Aave aToken addresses
AAVE_AUSDC=0xcb8164415274515867ec43CbD284ab5d6d2b304F
AAVE_AUSDT0=0x7053bAD224F0C021839f6AC645BdaE5F8b585b69
AAVE_AGHO=0x8917d4eE4609f991b559DAF8D0aD1b892c13B127
AAVE_AUSDE=0xb9aCA933C9c0aa854a6DBb7b12f0CC3FdaC15ee7

AUTO_REBALANCE=true
REBALANCE_INTERVAL_MS=1800000
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
