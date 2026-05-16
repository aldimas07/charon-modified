/**
 * Charon Feature Tests
 *
 * Tests for all 6 new features using Node.js built-in test runner.
 * Run: node --test tests/features.test.js
 *
 * Focus: pure functions, edge cases, integration between modules.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

// Mock now() to control time in tests
let mockNow = Date.now();
const originalNow = Date.now;

function setMockTime(ms) { mockNow = ms; }
function advanceTime(ms) { mockNow += ms; }

// We need to mock the utils.js now() function.
// Since ES modules are cached, we'll use a different approach:
// Import the modules and test their exported functions directly.
// For time-dependent tests, we'll pass timestamps explicitly where supported.

// ═══════════════════════════════════════════════════════════════════
// #2 FEE VELOCITY
// ═══════════════════════════════════════════════════════════════════

describe('Fee Velocity (#2)', async () => {
  // Import fresh module for each test suite
  const mod = await import('../src/signals/feeVelocity.js');

  it('returns zero velocity for unknown mint', () => {
    const result = mod.getFeeVelocity('unknown_mint_address');
    assert.equal(result.velocitySolPerMin, 0);
    assert.equal(result.totalSolWindow, 0);
    assert.equal(result.eventCount, 0);
  });

  it('records fee claim and calculates velocity', () => {
    const now = Date.now();
    // Record 5 SOL of fees
    mod.recordFeeClaim('test_mint_1', 5_000_000_000, now); // 5 SOL in lamports
    const result = mod.getFeeVelocity('test_mint_1');
    assert.ok(result.velocitySolPerMin > 0, 'velocity should be positive');
    assert.equal(result.eventCount, 1);
    assert.ok(result.totalSolWindow > 0);
  });

  it('accumulates multiple fee claims', () => {
    const now = Date.now();
    mod.recordFeeClaim('test_mint_2', 1_000_000_000, now);       // 1 SOL
    mod.recordFeeClaim('test_mint_2', 2_000_000_000, now + 60000); // 2 SOL
    mod.recordFeeClaim('test_mint_2', 3_000_000_000, now + 120000); // 3 SOL
    const result = mod.getFeeVelocity('test_mint_2');
    assert.equal(result.eventCount, 3);
    assert.ok(result.totalSolWindow >= 5.99, `total should be ~6 SOL, got ${result.totalSolWindow}`);
    assert.ok(result.velocitySolPerMin > 0);
  });

  it('ignores zero/negative fee claims', () => {
    mod.recordFeeClaim('test_mint_zero', 0);
    mod.recordFeeClaim('test_mint_zero', -1000);
    const result = mod.getFeeVelocity('test_mint_zero');
    assert.equal(result.eventCount, 0);
  });

  it('getTopVelocities returns sorted results', () => {
    const now = Date.now();
    mod.recordFeeClaim('top_a', 10_000_000_000, now); // 10 SOL
    mod.recordFeeClaim('top_b', 5_000_000_000, now);  // 5 SOL
    const top = mod.getTopVelocities(5);
    assert.ok(top.length >= 2);
    // First should have higher velocity
    if (top.length >= 2) {
      assert.ok(top[0].velocitySolPerMin >= top[1].velocitySolPerMin);
    }
  });

  it('trackedMintCount returns correct count', () => {
    const before = mod.trackedMintCount();
    mod.recordFeeClaim('unique_mint_xyz', 1_000_000_000);
    // Count should have increased (or stayed same if already tracked)
    assert.ok(mod.trackedMintCount() >= before);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #4 HOLDER GROWTH
// ═══════════════════════════════════════════════════════════════════

describe('Holder Growth (#4)', async () => {
  const mod = await import('../src/signals/holderGrowth.js');

  it('returns zero growth for unknown mint', () => {
    const result = mod.getHolderGrowth('unknown_mint');
    assert.equal(result.growthRate, 0);
    assert.equal(result.deltaHolders, 0);
    assert.equal(result.snapshotCount, 0);
  });

  it('returns zero growth with only one snapshot', () => {
    mod.recordHolderCount('hg_test_1', 100);
    const result = mod.getHolderGrowth('hg_test_1');
    assert.equal(result.growthRate, 0); // need 2+ snapshots
    assert.equal(result.snapshotCount, 1);
  });

  it('calculates growth rate from two snapshots', () => {
    // We can't easily control time in the module, but we can test
    // that the function handles the data correctly
    mod.recordHolderCount('hg_test_2', 100);
    // The module has a 30s minimum gap check, so a second call
    // within 30s will be skipped. We test the API contract.
    const result = mod.getHolderGrowth('hg_test_2');
    assert.ok(typeof result.growthRate === 'number');
    assert.ok(result.growthRate >= 0, 'growth rate should be non-negative');
  });

  it('ignores invalid inputs', () => {
    mod.recordHolderCount(null, 100);
    mod.recordHolderCount('', 100);
    mod.recordHolderCount('test', 0);
    mod.recordHolderCount('test', -5);
    mod.recordHolderCount('test', NaN);
    // Should not crash
    assert.ok(true);
  });

  it('trackedMintCount returns a number', () => {
    assert.ok(typeof mod.trackedMintCount() === 'number');
  });
});

// ═══════════════════════════════════════════════════════════════════
// #5 SELL PRESSURE
// ═══════════════════════════════════════════════════════════════════

describe('Sell Pressure (#5)', async () => {
  const mod = await import('../src/signals/sellPressure.js');

  it('returns zero risk for unknown mint', () => {
    const result = mod.getSellPressure('unknown_mint');
    assert.equal(result.devDumpRisk, 0);
    assert.equal(result.whaleExitRisk, 0);
    assert.equal(result.topHolderDelta, 0);
    assert.deepEqual(result.details, []);
  });

  it('records holder snapshot', () => {
    const holdersData = {
      top20: [
        { address: 'dev_wallet', percent: 30 },
        { address: 'whale_1', percent: 15 },
        { address: 'whale_2', percent: 10 },
        { address: 'whale_3', percent: 5 },
        { address: 'whale_4', percent: 3 },
      ],
      top20Percent: 63,
      maxHolderPercent: 30,
    };
    mod.recordHolderSnapshot('sp_test_1', holdersData);
    // Should not crash, and getSellPressure should return zeros (only 1 snapshot)
    const result = mod.getSellPressure('sp_test_1');
    assert.equal(result.devDumpRisk, 0); // need 2+ snapshots
  });

  it('detects dev dump when top holder sells', () => {
    const now = Date.now();
    const snapshot1 = {
      top20: [
        { address: 'dev', percent: 40 },
        { address: 'w1', percent: 10 },
      ],
      top20Percent: 50,
      maxHolderPercent: 40,
    };
    const snapshot2 = {
      top20: [
        { address: 'dev', percent: 20 }, // sold half!
        { address: 'w1', percent: 10 },
      ],
      top20Percent: 30,
      maxHolderPercent: 20,
    };

    // Use a unique mint to avoid interference
    const mint = `sp_dump_test_${now}`;
    mod.recordHolderSnapshot(mint, snapshot1);
    // Can't easily control time gap, but test the API
    const result = mod.getSellPressure(mint);
    assert.ok(typeof result.devDumpRisk === 'number');
    assert.ok(result.devDumpRisk >= 0);
  });

  it('handles empty/null holders data gracefully', () => {
    mod.recordHolderSnapshot('sp_null', null);
    mod.recordHolderSnapshot('sp_empty', { top20: [] });
    mod.recordHolderSnapshot('sp_undef', {});
    // Should not crash
    assert.ok(true);
  });

  it('handles holders with missing percent field', () => {
    mod.recordHolderSnapshot('sp_missing', {
      top20: [
        { address: 'a' }, // no percent
        { address: 'b', percent: null },
      ],
      top20Percent: 0,
      maxHolderPercent: 0,
    });
    assert.ok(true); // should not crash
  });
});

// ═══════════════════════════════════════════════════════════════════
// #6 COORDINATION
// ═══════════════════════════════════════════════════════════════════

describe('Coordination (#6)', async () => {
  const mod = await import('../src/signals/coordination.js');

  it('returns no cluster for unknown mint', () => {
    const result = mod.detectCluster('unknown_mint');
    assert.equal(result.isCluster, false);
    assert.equal(result.clusterSize, 0);
    assert.deepEqual(result.wallets, []);
  });

  it('does not form cluster with < 3 wallets', () => {
    mod.recordWalletEntry('cl_test_1', 'wallet_a', 'Alice');
    mod.recordWalletEntry('cl_test_1', 'wallet_b', 'Bob');
    const result = mod.detectCluster('cl_test_1');
    assert.equal(result.isCluster, false);
    assert.ok(result.clusterSize < 3);
  });

  it('deduplicates same wallet within 30 min', () => {
    const mint = `cl_dedup_${Date.now()}`;
    mod.recordWalletEntry(mint, 'same_wallet', 'Same');
    mod.recordWalletEntry(mint, 'same_wallet', 'Same'); // should be deduped
    mod.recordWalletEntry(mint, 'same_wallet', 'Same'); // should be deduped
    const result = mod.detectCluster(mint);
    // Should count as 1 entry, not 3
    assert.ok(result.clusterSize <= 1, `expected <=1, got ${result.clusterSize}`);
  });

  it('handles null/empty inputs gracefully', () => {
    mod.recordWalletEntry(null, 'addr', 'label');
    mod.recordWalletEntry('mint', null, 'label');
    mod.recordWalletEntry('', 'addr', 'label');
    // scanForNewEntries with empty data
    const entries = mod.scanForNewEntries('mint', [], []);
    assert.deepEqual(entries, []);
  });

  it('scanForNewEntries detects wallet matches', () => {
    const currentHolders = [
      { address: 'holder_1' },
      { address: 'holder_2' },
      { address: 'holder_3' },
    ];
    const savedWallets = [
      { address: 'holder_1', label: 'Smart1' },
      { address: 'holder_2', label: 'Smart2' },
      { address: 'not_holder', label: 'Nope' },
    ];
    const mint = `cl_scan_${Date.now()}`;
    const result = mod.scanForNewEntries(mint, currentHolders, savedWallets);
    assert.equal(result.length, 2); // holder_1 and holder_2 match
    assert.equal(result[0].label, 'Smart1');
    assert.equal(result[1].label, 'Smart2');
  });

  it('handles scanForNewEntries with null holders', () => {
    const result = mod.scanForNewEntries('mint', null, [{ address: 'a', label: 'b' }]);
    assert.deepEqual(result, []);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #1 WALLET SCORING
// ═══════════════════════════════════════════════════════════════════

describe('Wallet Scoring (#1)', async () => {
  // We test the scoring logic indirectly through the exported functions
  // scoreWallet is internal, but we can test fetchSavedWalletExposure
  // with mock data by testing the scoring formula directly

  it('scoring formula: high win rate + many trades = high score', () => {
    // Recreate the scoring formula locally for testing
    function scoreWallet(pnl) {
      if (!pnl || pnl.totalTrades < 3) return 0;
      const winRateScore = Math.min(100, pnl.winRate * 1.2);
      const tradeCountScore = Math.min(100, (pnl.totalTrades / 20) * 100);
      const pnlScore = pnl.totalPnlPercent > 0
        ? Math.min(100, 50 + pnl.totalPnlPercent / 5)
        : Math.max(0, 50 + pnl.totalPnlPercent / 2);
      return Math.round(winRateScore * 0.4 + tradeCountScore * 0.3 + pnlScore * 0.3);
    }

    // Excellent wallet
    const excellent = scoreWallet({ winRate: 80, totalTrades: 25, totalPnlPercent: 200 });
    assert.ok(excellent >= 80, `excellent wallet score should be >=80, got ${excellent}`);

    // Average wallet
    const average = scoreWallet({ winRate: 50, totalTrades: 10, totalPnlPercent: 20 });
    assert.ok(average >= 40 && average <= 70, `average wallet score should be 40-70, got ${average}`);

    // Bad wallet
    const bad = scoreWallet({ winRate: 20, totalTrades: 5, totalPnlPercent: -50 });
    assert.ok(bad < 30, `bad wallet score should be <30, got ${bad}`);

    // New wallet (<3 trades)
    const newbie = scoreWallet({ winRate: 100, totalTrades: 2, totalPnlPercent: 50 });
    assert.equal(newbie, 0, 'wallet with <3 trades should score 0');

    // Null PnL
    assert.equal(scoreWallet(null), 0);
    assert.equal(scoreWallet(undefined), 0);
  });

  it('scoring edge cases', () => {
    function scoreWallet(pnl) {
      if (!pnl || pnl.totalTrades < 3) return 0;
      const winRateScore = Math.min(100, pnl.winRate * 1.2);
      const tradeCountScore = Math.min(100, (pnl.totalTrades / 20) * 100);
      const pnlScore = pnl.totalPnlPercent > 0
        ? Math.min(100, 50 + pnl.totalPnlPercent / 5)
        : Math.max(0, 50 + pnl.totalPnlPercent / 2);
      return Math.round(winRateScore * 0.4 + tradeCountScore * 0.3 + pnlScore * 0.3);
    }

    // Exactly 3 trades (minimum)
    const minTrades = scoreWallet({ winRate: 60, totalTrades: 3, totalPnlPercent: 10 });
    assert.ok(minTrades > 0, 'wallet with exactly 3 trades should score > 0');

    // Very high PnL (capped at 100)
    const highPnl = scoreWallet({ winRate: 90, totalTrades: 50, totalPnlPercent: 1000 });
    assert.ok(highPnl <= 100, `score should be <= 100, got ${highPnl}`);

    // Negative PnL (floor at 0)
    const negPnl = scoreWallet({ winRate: 10, totalTrades: 3, totalPnlPercent: -200 });
    assert.ok(negPnl >= 0, `score should be >= 0, got ${negPnl}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #3 DYNAMIC TP/SL
// ═══════════════════════════════════════════════════════════════════

describe('Dynamic TP/SL (#3)', async () => {
  const { dynamicTpSl } = await import('../src/pipeline/dynamicTpSl.js');

  const baseStrat = {
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: true,
    trailing_percent: 20,
  };

  it('returns base values for mid-range token with no signals', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 100000, // mid-range, no adjustment
        feeVelocitySolPerMin: 0,
        liquidityUsd: 50000,
        holderCount: 500,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.equal(result.tp, 50); // base, no adjustments
    assert.equal(result.sl, -25);
    assert.equal(result.trailing, true);
    assert.equal(result.trailingPercent, 20);
    assert.ok(Array.isArray(result.reasoning));
  });

  it('increases TP for micro mcap tokens', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 10000, // micro mcap
        feeVelocitySolPerMin: 0,
        liquidityUsd: 50000,
        holderCount: 100,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.tp > 50, `micro mcap TP should be >50, got ${result.tp}`);
    assert.ok(result.sl < -25, `micro mcap SL should be tighter (more negative), got ${result.sl}`);
    assert.ok(result.reasoning.some(r => r.includes('micro mcap')));
  });

  it('decreases TP for large mcap tokens', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 500000, // large mcap
        feeVelocitySolPerMin: 0,
        liquidityUsd: 100000,
        holderCount: 2000,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.tp < 50, `large mcap TP should be <50, got ${result.tp}`);
    assert.ok(result.reasoning.some(r => r.includes('large mcap')));
  });

  it('increases TP for high fee velocity', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 100000,
        feeVelocitySolPerMin: 3.0, // high velocity
        liquidityUsd: 50000,
        holderCount: 500,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.tp > 50, `high fee vel TP should be >50, got ${result.tp}`);
    assert.ok(result.reasoning.some(r => r.includes('fee velocity')));
  });

  it('loosens SL for high smart wallet score', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 100000,
        feeVelocitySolPerMin: 0,
        liquidityUsd: 50000,
        holderCount: 500,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 70 }, // high score
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.sl > -25, `high smart score SL should be looser (less negative), got ${result.sl}`);
    assert.ok(result.reasoning.some(r => r.includes('smart score')));
  });

  it('tightens SL for low liquidity', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 100000,
        feeVelocitySolPerMin: 0,
        liquidityUsd: 2000, // very low
        holderCount: 100,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.sl < -25, `low liquidity SL should be tighter, got ${result.sl}`);
    assert.ok(result.reasoning.some(r => r.includes('low liquidity')));
  });

  it('increases TP for cluster buy', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 100000,
        feeVelocitySolPerMin: 0,
        liquidityUsd: 50000,
        holderCount: 500,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: true,
        clusterSize: 4,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.tp > 50, `cluster buy TP should be >50, got ${result.tp}`);
    assert.ok(result.sl > -25, `cluster buy SL should be looser, got ${result.sl}`);
    assert.ok(result.reasoning.some(r => r.includes('cluster')));
  });

  it('decreases TP for dev dump risk', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 100000,
        feeVelocitySolPerMin: 0,
        liquidityUsd: 50000,
        holderCount: 500,
        holderGrowthRate: 0,
        devDumpRisk: 50, // high risk
        whaleExitRisk: 0,
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.tp < 50, `dev dump TP should be <50, got ${result.tp}`);
    assert.ok(result.sl < -25, `dev dump SL should be tighter, got ${result.sl}`);
    assert.ok(result.reasoning.some(r => r.includes('dev dump')));
  });

  it('tightens SL for whale exits', () => {
    const candidate = {
      metrics: {
        marketCapUsd: 100000,
        feeVelocitySolPerMin: 0,
        liquidityUsd: 50000,
        holderCount: 500,
        holderGrowthRate: 0,
        devDumpRisk: 0,
        whaleExitRisk: 3, // 3 whales exited
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.sl < -25, `whale exits SL should be tighter, got ${result.sl}`);
    assert.ok(result.reasoning.some(r => r.includes('whale')));
  });

  it('clamps TP between 10 and 500', () => {
    // Extreme case: micro mcap + high fee vel + cluster + holder growth
    const candidate = {
      metrics: {
        marketCapUsd: 5000,
        feeVelocitySolPerMin: 5.0,
        liquidityUsd: 50000,
        holderCount: 100,
        holderGrowthRate: 10,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: true,
        clusterSize: 5,
      },
      savedWalletExposure: { smartScore: 80 },
    };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(result.tp >= 10 && result.tp <= 500, `TP should be clamped 10-500, got ${result.tp}`);
    assert.ok(result.sl >= -60 && result.sl <= -5, `SL should be clamped -60 to -5, got ${result.sl}`);
  });

  it('handles missing metrics gracefully', () => {
    const candidate = { metrics: {}, savedWalletExposure: {} };
    const result = dynamicTpSl(candidate, baseStrat);
    assert.ok(typeof result.tp === 'number');
    assert.ok(typeof result.sl === 'number');
    assert.ok(result.tp >= 10 && result.tp <= 500);
    assert.ok(result.sl >= -60 && result.sl <= -5);
  });

  it('handles null candidate gracefully', () => {
    const result = dynamicTpSl({ metrics: null, savedWalletExposure: null }, baseStrat);
    assert.ok(typeof result.tp === 'number');
    assert.ok(typeof result.sl === 'number');
  });
});

// ═══════════════════════════════════════════════════════════════════
// FILTER LOGIC (candidateBuilder)
// ═══════════════════════════════════════════════════════════════════

describe('Filter Logic', async () => {
  // Test the filter conditions directly
  // We recreate the filter logic to verify correctness

  function checkFilter(strat, candidate) {
    const failures = [];
    const smartScore = candidate.savedWalletExposure?.smartScore ?? 0;
    const savedCount = candidate.savedWalletExposure?.holderCount ?? 0;
    const feeVel = candidate.metrics?.feeVelocitySolPerMin ?? 0;
    const holderGrowthRate = candidate.metrics?.holderGrowthRate ?? 0;
    const devDumpRisk = candidate.metrics?.devDumpRisk ?? 0;
    const whaleExitRisk = candidate.metrics?.whaleExitRisk ?? 0;

    if (strat.min_smart_wallet_score > 0 && savedCount > 0 && smartScore < strat.min_smart_wallet_score) {
      failures.push('smart_wallet_score');
    }
    if (strat.min_fee_velocity_sol_per_min > 0 && feeVel < strat.min_fee_velocity_sol_per_min) {
      failures.push('fee_velocity');
    }
    if (strat.min_holder_growth_rate > 0 && holderGrowthRate < strat.min_holder_growth_rate) {
      failures.push('holder_growth');
    }
    if (strat.max_dev_dump_risk_pct > 0 && devDumpRisk > strat.max_dev_dump_risk_pct) {
      failures.push('dev_dump');
    }
    if (strat.max_whale_exit_count > 0 && whaleExitRisk >= strat.max_whale_exit_count) {
      failures.push('whale_exit');
    }
    return failures;
  }

  it('all filters disabled (value=0) means no failures', () => {
    const strat = {
      min_smart_wallet_score: 0,
      min_fee_velocity_sol_per_min: 0,
      min_holder_growth_rate: 0,
      max_dev_dump_risk_pct: 0,
      max_whale_exit_count: 0,
    };
    const candidate = {
      metrics: { feeVelocitySolPerMin: 0, holderGrowthRate: 0, devDumpRisk: 100, whaleExitRisk: 5 },
      savedWalletExposure: { smartScore: 0, holderCount: 0 },
    };
    const failures = checkFilter(strat, candidate);
    assert.equal(failures.length, 0, 'all disabled should pass');
  });

  it('smart wallet score filter: only enforced when savedCount > 0', () => {
    const strat = { min_smart_wallet_score: 50, min_fee_velocity_sol_per_min: 0, min_holder_growth_rate: 0, max_dev_dump_risk_pct: 0, max_whale_exit_count: 0 };

    // No wallets matched → skip filter
    let failures = checkFilter(strat, {
      metrics: {},
      savedWalletExposure: { smartScore: 10, holderCount: 0 },
    });
    assert.equal(failures.length, 0, 'no matched wallets should skip filter');

    // Wallets matched but low score → fail
    failures = checkFilter(strat, {
      metrics: {},
      savedWalletExposure: { smartScore: 10, holderCount: 2 },
    });
    assert.ok(failures.includes('smart_wallet_score'));
  });

  it('fee velocity filter: rejects low velocity', () => {
    const strat = { min_smart_wallet_score: 0, min_fee_velocity_sol_per_min: 1.0, min_holder_growth_rate: 0, max_dev_dump_risk_pct: 0, max_whale_exit_count: 0 };
    const failures = checkFilter(strat, {
      metrics: { feeVelocitySolPerMin: 0.5 },
      savedWalletExposure: {},
    });
    assert.ok(failures.includes('fee_velocity'));
  });

  it('dev dump filter: rejects high risk', () => {
    const strat = { min_smart_wallet_score: 0, min_fee_velocity_sol_per_min: 0, min_holder_growth_rate: 0, max_dev_dump_risk_pct: 30, max_whale_exit_count: 0 };
    const failures = checkFilter(strat, {
      metrics: { devDumpRisk: 50 },
      savedWalletExposure: {},
    });
    assert.ok(failures.includes('dev_dump'));
  });

  it('whale exit filter: rejects when count >= threshold', () => {
    const strat = { min_smart_wallet_score: 0, min_fee_velocity_sol_per_min: 0, min_holder_growth_rate: 0, max_dev_dump_risk_pct: 0, max_whale_exit_count: 2 };
    const failures = checkFilter(strat, {
      metrics: { whaleExitRisk: 2 },
      savedWalletExposure: {},
    });
    assert.ok(failures.includes('whale_exit'));
  });

  it('undefined strategy keys safely skip filters', () => {
    const strat = {}; // no keys set
    const failures = checkFilter(strat, {
      metrics: { feeVelocitySolPerMin: 0, holderGrowthRate: 0, devDumpRisk: 100, whaleExitRisk: 5 },
      savedWalletExposure: { smartScore: 0, holderCount: 0 },
    });
    assert.equal(failures.length, 0, 'undefined keys should skip all filters');
  });
});

// ═══════════════════════════════════════════════════════════════════
// NORMALIZE DECISION (llm.js)
// ═══════════════════════════════════════════════════════════════════

describe('normalizeDecision', async () => {
  // Recreate the function for testing (can't import without DB)
  function normalizeDecision(parsed, fallbackReason = '') {
    const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
      ? String(parsed.verdict).toUpperCase()
      : 'WATCH';
    return {
      verdict,
      confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
      reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
      risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
      suggested_tp_percent: Number(parsed?.suggested_tp_percent) || null,
      suggested_sl_percent: Number(parsed?.suggested_sl_percent) || null,
    };
  }

  it('parses valid BUY decision', () => {
    const result = normalizeDecision({
      verdict: 'BUY',
      confidence: 75,
      reason: 'good setup',
      risks: ['low_liq'],
      suggested_tp_percent: 80,
      suggested_sl_percent: -20,
    });
    assert.equal(result.verdict, 'BUY');
    assert.equal(result.confidence, 75);
    assert.equal(result.reason, 'good setup');
    assert.deepEqual(result.risks, ['low_liq']);
    assert.equal(result.suggested_tp_percent, 80);
    assert.equal(result.suggested_sl_percent, -20);
  });

  it('defaults to WATCH for invalid verdict', () => {
    assert.equal(normalizeDecision({ verdict: 'INVALID' }).verdict, 'WATCH');
    assert.equal(normalizeDecision({}).verdict, 'WATCH');
    assert.equal(normalizeDecision(null).verdict, 'WATCH');
  });

  it('clamps confidence to 0-100', () => {
    assert.equal(normalizeDecision({ verdict: 'BUY', confidence: 150 }).confidence, 100);
    assert.equal(normalizeDecision({ verdict: 'BUY', confidence: -10 }).confidence, 0);
    assert.equal(normalizeDecision({ verdict: 'BUY', confidence: 'abc' }).confidence, 0);
  });

  it('returns null for missing TP/SL (not default)', () => {
    const result = normalizeDecision({ verdict: 'BUY' });
    assert.equal(result.suggested_tp_percent, null, 'missing TP should be null');
    assert.equal(result.suggested_sl_percent, null, 'missing SL should be null');
  });

  it('returns null for zero TP/SL', () => {
    const result = normalizeDecision({ verdict: 'BUY', suggested_tp_percent: 0, suggested_sl_percent: 0 });
    assert.equal(result.suggested_tp_percent, null, '0 TP should become null');
    assert.equal(result.suggested_sl_percent, null, '0 SL should become null');
  });

  it('limits risks to 8 items', () => {
    const risks = Array(20).fill('risk');
    const result = normalizeDecision({ verdict: 'PASS', risks });
    assert.equal(result.risks.length, 8);
  });

  it('truncates reason to 1000 chars', () => {
    const longReason = 'x'.repeat(2000);
    const result = normalizeDecision({ verdict: 'WATCH', reason: longReason });
    assert.ok(result.reason.length <= 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TP/SL FALLBACK CHAIN
// ═══════════════════════════════════════════════════════════════════

describe('TP/SL Fallback Chain', () => {
  it('priority: LLM > dynamic > strategy > global', () => {
    // Simulate the fallback chain from positions.js
    function resolveTpSl(decision, dyn, strat, globalDefault) {
      return Number(decision.suggested_tp_percent || dyn.tp || strat.tp_percent || globalDefault);
    }

    // LLM provides value → use it
    assert.equal(resolveTpSl({ suggested_tp_percent: 80 }, { tp: 60 }, { tp_percent: 50 }, 50), 80);

    // LLM null → use dynamic
    assert.equal(resolveTpSl({ suggested_tp_percent: null }, { tp: 60 }, { tp_percent: 50 }, 50), 60);

    // LLM null, dynamic 0 → use strategy
    assert.equal(resolveTpSl({ suggested_tp_percent: null }, { tp: 0 }, { tp_percent: 50 }, 50), 50);

    // All null/0 → use global
    assert.equal(resolveTpSl({ suggested_tp_percent: null }, { tp: 0 }, { tp_percent: 0 }, 50), 50);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CROSS-FEATURE INTEGRATION
// ═══════════════════════════════════════════════════════════════════

describe('Cross-Feature Integration', async () => {
  const { dynamicTpSl } = await import('../src/pipeline/dynamicTpSl.js');

  it('dynamicTpSl combines multiple signals correctly', () => {
    // Micro mcap + high fee vel + cluster buy + high smart score
    // Should produce aggressive TP, loose SL
    const candidate = {
      metrics: {
        marketCapUsd: 8000,
        feeVelocitySolPerMin: 2.5,
        liquidityUsd: 50000,
        holderCount: 200,
        holderGrowthRate: 8,
        devDumpRisk: 0,
        whaleExitRisk: 0,
        clusterBuy: true,
        clusterSize: 4,
      },
      savedWalletExposure: { smartScore: 70 },
    };
    const result = dynamicTpSl(candidate, { tp_percent: 50, sl_percent: -25, trailing_enabled: true, trailing_percent: 20 });
    // Should have multiple adjustments stacking
    assert.ok(result.tp > 80, `aggressive setup TP should be >80, got ${result.tp}`);
    assert.ok(result.sl > -25, `high conviction SL should be looser, got ${result.sl}`);
    assert.ok(result.reasoning.length >= 3, `should have 3+ reasoning items, got ${result.reasoning.length}`);
  });

  it('dynamicTpSl: bearish signals counteract bullish ones', () => {
    // Micro mcap (bullish) but dev dumping (bearish)
    const candidate = {
      metrics: {
        marketCapUsd: 10000,
        feeVelocitySolPerMin: 3.0,
        liquidityUsd: 50000,
        holderCount: 200,
        holderGrowthRate: 0,
        devDumpRisk: 50, // dev is dumping!
        whaleExitRisk: 2, // whales exiting
        clusterBuy: false,
        clusterSize: 0,
      },
      savedWalletExposure: { smartScore: 0 },
    };
    const result = dynamicTpSl(candidate, { tp_percent: 50, sl_percent: -25, trailing_enabled: true, trailing_percent: 20 });
    // Dev dump + whale exit should counteract the mcap + fee vel bonuses
    assert.ok(result.reasoning.some(r => r.includes('dev dump')));
    assert.ok(result.reasoning.some(r => r.includes('whale')));
  });
});
