# Charon Modified

An enhanced Solana memecoin trading bot built on top of Pump.fun, with advanced signal detection, smart wallet scoring, dynamic risk management, and coordination detection.

## Overview

Charon monitors Pump.fun fee claims, graduated tokens, and trending tokens in real-time via WebSocket. It enriches candidates with on-chain data, runs them through configurable filters, and uses an LLM to make buy/sell decisions. This modified version adds 6 major features on top of the original architecture.

## Features (Modified)

### 1. Smart Wallet Scoring

Tracks the quality of saved wallets, not just the count. Each wallet is scored 0-100 based on:

- **Win rate** (40% weight)
- **Trade count reliability** (30% weight) — more trades = more reliable score
- **Total PnL** (30% weight)

Wallets with fewer than 3 trades receive a score of 0. Scores are cached for 1 hour and fetched in parallel (concurrency limit of 5).

**Filter:** `min_smart_wallet_score` — only enforced when at least one saved wallet is a holder.

**Files:** `src/enrichment/wallets.js`

### 2. Fee Velocity Tracking

Measures the rate of on-chain fee claims per token over a rolling 10-minute window. Fee velocity = total SOL distributed / 10 minutes.

High velocity indicates heavy trading activity. A spike from 0.2 to 2.0 SOL/min is a strong momentum signal.

**Filter:** `min_fee_velocity_sol_per_min`

**Files:** `src/signals/feeVelocity.js`

### 3. Dynamic TP/SL

Calculates adaptive take-profit and stop-loss based on token profile instead of using static defaults. Adjustments:

| Factor | TP Adjustment | SL Adjustment |
|--------|--------------|---------------|
| MCap < $15K | +60% | Tighter |
| MCap $15K-50K | +30% | — |
| MCap >= $200K | -30% | Looser |
| Fee velocity >= 2.0 SOL/min | +30% | — |
| Fee velocity >= 0.5 SOL/min | +15% | — |
| Smart wallet score >= 60 | — | Looser |
| Smart wallet score >= 40 | — | Slightly looser |
| Liquidity < $5K | — | Tighter |
| Holder growth >= 5/min | +20% | — |
| Cluster buy (3+ wallets) | +25% | Looser |
| Dev dump risk > 30% | -30% | Tighter |
| Dev dump risk > 15% | -15% | — |
| Whale exits >= 2 | — | Tighter |

**Clamping:** TP: 10-500%, SL: -5% to -60%

**Priority chain:** LLM suggestion > Dynamic TP/SL > Strategy default > Global default

**Files:** `src/pipeline/dynamicTpSl.js`

### 4. Holder Growth Velocity

Tracks how fast new holders are accumulating per token over a rolling 15-minute window. Snapshots are taken when candidate data is fetched, with a minimum 30-second gap between snapshots.

**Filter:** `min_holder_growth_rate` (holders per minute)

**Files:** `src/signals/holderGrowth.js`

### 5. Dev/Whale Sell Pressure Detection

Monitors top holder balance changes over time by comparing holder snapshots:

- **Dev dump risk:** Percentage of top holder's position sold. >30% is a serious warning.
- **Whale exit risk:** Count of top-5 holders who sold >30% of their position.

**Filters:**
- `max_dev_dump_risk_pct` — reject if dev sold more than X% of position
- `max_whale_exit_count` — reject if >= X whales exited

**Files:** `src/signals/sellPressure.js`

### 6. Coordination Detection

Detects when 3+ tracked (saved) wallets enter the same token within a 2-minute window — a "cluster buy" signal indicating coordinated accumulation.

Key design decisions:
- 30-minute dedup per wallet+mint pair prevents false positives from persistent holders
- Sliding window algorithm finds the tightest sub-window
- Only triggers on NEW entries, not existing holdings

No hard filter — cluster buys are a bonus signal that increases TP and loosens SL via dynamic TP/SL.

**Files:** `src/signals/coordination.js`

## Architecture

```
Signals (WebSocket/Polling)
├── feeClaim.js        → Pump.fun fee distribution events
├── feeVelocity.js     → Fee claim rate tracking
├── graduated.js       → Bonding curve graduation
├── trending.js        → GMGN/Jupiter trending tokens
├── holderGrowth.js    → Holder count growth tracking
├── sellPressure.js    → Top holder balance changes
└── coordination.js    → Coordinated wallet entry detection

Enrichment
├── gmgn.js            → GMGN token info API
├── jupiter.js         → Jupiter price/holders/chart
├── wallets.js         → Saved wallet scoring + exposure
├── twitter.js         → Twitter narrative analysis
└── pumpfunMath.js     → Bonding curve calculations

Pipeline
├── candidateBuilder.js → Assembles candidates from signals + enrichment
├── dynamicTpSl.js      → Adaptive TP/SL calculator
├── llm.js              → LLM decision making
└── orchestrator.js     → Main pipeline coordination

Execution
├── positions.js        → Position lifecycle management
└── router.js           → Jupiter swap execution

Telegram
├── bot.js, commands.js, callbacks.js, menus.js, format.js, send.js
```

## Strategy System

Strategies are stored in SQLite and configurable via Telegram commands. Four built-in strategies:

| Strategy | Entry Mode | TP/SL | Description |
|----------|-----------|-------|-------------|
| **Sniper** | Immediate | 50/-25 | Fee claim + graduated/trending |
| **Dip Buy** | Wait for dip | 30/-20 | ATH distance -40% |
| **Smart Money** | Immediate | 100/-25 | High holder count, low rug ratio |
| **Degen** | Immediate | 30/-15 | Minimal filters, fast flips |

### Strategy Configuration

```
/stratset sniper tp_percent 75
/stratset sniper min_smart_wallet_score 40
/stratset sniper min_fee_velocity_sol_per_min 0.5
/stratset sniper min_holder_growth_rate 3
/stratset sniper max_dev_dump_risk_pct 30
/stratset sniper max_whale_exit_count 2
```

### All Configurable Filter Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `tp_percent` | number | 50 | Take profit % |
| `sl_percent` | number | -25 | Stop loss % |
| `trailing_enabled` | bool | true | Enable trailing stop |
| `trailing_percent` | number | 20 | Trailing stop % |
| `position_size_sol` | number | 0.1 | Buy size in SOL |
| `max_open_positions` | number | 3 | Max concurrent positions |
| `min_mcap_usd` | number | 7000 | Minimum market cap |
| `max_mcap_usd` | number | 200000 | Maximum market cap |
| `min_holders` | number | 0 | Minimum holder count |
| `min_fee_claim_sol` | number | 0.5 | Minimum fee claim |
| `min_gmgn_total_fee_sol` | number | 10 | Minimum GMGN total fees |
| `min_fee_velocity_sol_per_min` | number | 0 | Minimum fee velocity |
| `min_holder_growth_rate` | number | 0 | Minimum holder growth/min |
| `min_smart_wallet_score` | number | 0 | Minimum wallet quality score |
| `min_saved_wallet_holders` | number | 0 | Minimum matched wallets |
| `max_dev_dump_risk_pct` | number | 0 | Max dev dump risk % |
| `max_whale_exit_count` | number | 0 | Max whale exit count |
| `max_ath_distance_pct` | number | 0 | Max ATH distance % |
| `max_top20_holder_percent` | number | 100 | Max top holder concentration |
| `trending_min_volume_usd` | number | 0 | Min trending volume |
| `trending_min_swaps` | number | 0 | Min trending swaps |
| `trending_max_rug_ratio` | number | 0.3 | Max rug ratio |
| `trending_max_bundler_rate` | number | 0.5 | Max bundler rate |

## Setup

### Prerequisites

- Node.js 18+
- Helius API key (RPC + WebSocket)
- GMGN API key
- Jupiter API key
- Telegram bot token

### Installation

```bash
git clone git@github.com:aldimas07/charon-modified.git
cd charon-modified
npm install
```

### Configuration

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_TOPIC_ID=your_topic_id
HELIUS_API_KEY=your_helius_key
GMGN_API_KEY=your_gmgn_key
JUPITER_API_KEY=your_jupiter_key
SOLANA_PRIVATE_KEY=your_base58_private_key
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your_llm_key
LLM_MODEL=gpt-4o-mini
TRADING_MODE=dry_run
```

### Running

```bash
npm start
```

### Testing

```bash
npm test
```

52 tests covering all 6 features, filter logic, TP/SL calculations, and edge cases.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/menu` | Open main menu |
| `/strategy` | Show/switch strategy |
| `/stratset <id> <key> <value>` | Set strategy config |
| `/positions` | Show open positions |
| `/candidate <mint>` | Show candidate details |
| `/filters` | Show current filters |
| `/setfilter <key> <value>` | Set global filter |
| `/pnl` | Show saved wallet PnL + scores |
| `/walletadd <label> <address>` | Add wallet to track |
| `/walletremove <label>` | Remove tracked wallet |
| `/wallets` | List tracked wallets |
| `/learn` | Run learning report |
| `/lessons` | Show active lessons |
| `/history` | Show position history |

## Learning System

Charon includes a self-improving learning loop:

1. **Evidence collection** — all buy/sell decisions and outcomes are stored
2. **Lesson generation** — LLM analyzes trade history and produces actionable rules
3. **Auto-blocking** — routes with <10% win rate and 5+ trades are automatically blocked
4. **Prompt injection** — active lessons are injected into future LLM decisions

## License

Private — for personal use only.
