/**
 * Dynamic TP/SL Calculator
 *
 * Calculates adaptive take-profit and stop-loss based on token profile:
 * - Lower mcap → higher TP potential, tighter SL (more volatile)
 * - Higher fee velocity → more aggressive TP (momentum)
 * - Higher smart wallet score → looser SL (conviction)
 * - Lower liquidity → tighter SL (slippage risk)
 *
 * The strategy config provides base TP/SL. Dynamic adjusts from there.
 * LLM can still override with suggested_tp/sl_percent.
 */

import { numSetting } from '../db/settings.js';

/**
 * Calculate dynamic TP/SL for a candidate.
 * @param {object} candidate - full candidate object
 * @param {object} strat - active strategy config
 * @returns {{ tp: number, sl: number, trailing: boolean, trailingPercent: number, reasoning: string[] }}
 */
export function dynamicTpSl(candidate, strat) {
  const mcap = Number(candidate.metrics?.marketCapUsd || 0);
  const feeVel = Number(candidate.metrics?.feeVelocitySolPerMin || 0);
  const smartScore = Number(candidate.savedWalletExposure?.smartScore || 0);
  const liquidity = Number(candidate.metrics?.liquidityUsd || 0);
  const holderCount = Number(candidate.metrics?.holderCount || 0);
  const holderGrowthRate = Number(candidate.metrics?.holderGrowthRate || 0);

  // Base from strategy
  let baseTp = Number(strat.tp_percent || numSetting('default_tp_percent', 50));
  let baseSl = Number(strat.sl_percent || numSetting('default_sl_percent', -25));
  let trailing = strat.trailing_enabled ?? true;
  let trailingPercent = Number(strat.trailing_percent || 20);
  const reasoning = [];

  // ── MCap adjustment ──────────────────────────────────────────────
  // Smaller mcap = more upside potential but more volatile
  if (mcap > 0 && mcap < 15000) {
    baseTp *= 1.6;  // 10k mcap → 80% TP instead of 50%
    baseSl *= 1.2;  // tighter SL (-30% instead of -25%)
    trailingPercent = Math.max(15, trailingPercent - 5);
    reasoning.push(`micro mcap ($${Math.round(mcap)}): TP +60%, SL tighter`);
  } else if (mcap >= 15000 && mcap < 50000) {
    baseTp *= 1.3;
    reasoning.push(`small mcap ($${Math.round(mcap)}): TP +30%`);
  } else if (mcap >= 200000) {
    baseTp *= 0.7;  // larger mcap → more conservative TP
    baseSl *= 0.8;  // looser SL
    reasoning.push(`large mcap ($${Math.round(mcap)}): TP -30%, SL looser`);
  }

  // ── Fee velocity adjustment ──────────────────────────────────────
  // High velocity = strong momentum → more aggressive TP
  if (feeVel >= 2.0) {
    baseTp *= 1.3;
    reasoning.push(`high fee velocity (${feeVel}/min): TP +30%`);
  } else if (feeVel >= 0.5) {
    baseTp *= 1.15;
    reasoning.push(`moderate fee velocity (${feeVel}/min): TP +15%`);
  }

  // ── Smart wallet score adjustment ────────────────────────────────
  // High score wallets = conviction → looser SL
  if (smartScore >= 60) {
    baseSl *= 0.8;  // -25% → -20%
    reasoning.push(`high smart score (${smartScore}): SL looser`);
  } else if (smartScore >= 40) {
    baseSl *= 0.9;
    reasoning.push(`moderate smart score (${smartScore}): SL slightly looser`);
  }

  // ── Liquidity adjustment ─────────────────────────────────────────
  // Low liquidity = slippage risk → tighter SL
  if (liquidity > 0 && liquidity < 5000) {
    baseSl *= 1.3;  // -25% → -32.5%
    trailingPercent = Math.max(10, trailingPercent - 5);
    reasoning.push(`low liquidity ($${Math.round(liquidity)}): SL tighter`);
  }

  // ── Holder growth bonus ──────────────────────────────────────────
  // Fast holder growth = organic interest → more aggressive TP
  if (holderGrowthRate >= 5) {
    baseTp *= 1.2;
    reasoning.push(`fast holder growth (${holderGrowthRate}/min): TP +20%`);
  }

  // ── Cluster buy bonus ────────────────────────────────────────────
  // Coordinated wallet entries = strong conviction signal
  const clusterBuy = candidate.metrics?.clusterBuy ?? false;
  const clusterSize = candidate.metrics?.clusterSize ?? 0;
  if (clusterBuy && clusterSize >= 3) {
    baseTp *= 1.25;
    baseSl *= 0.85; // looser SL
    reasoning.push(`cluster buy (${clusterSize} wallets): TP +25%, SL looser`);
  }

  // ── Sell pressure penalty ────────────────────────────────────────
  const devDumpRisk = candidate.metrics?.devDumpRisk ?? 0;
  const whaleExitRisk = candidate.metrics?.whaleExitRisk ?? 0;
  if (devDumpRisk > 30) {
    baseTp *= 0.7;
    baseSl *= 1.3; // tighter SL
    reasoning.push(`dev dump risk (${devDumpRisk}%): TP -30%, SL tighter`);
  } else if (devDumpRisk > 15) {
    baseTp *= 0.85;
    reasoning.push(`moderate dev dump risk (${devDumpRisk}%): TP -15%`);
  }
  if (whaleExitRisk >= 2) {
    baseSl *= 1.2;
    reasoning.push(`whale exits (${whaleExitRisk}): SL tighter`);
  }

  // ── Clamp values ─────────────────────────────────────────────────
  const tp = Math.round(Math.max(10, Math.min(500, baseTp)));
  const sl = Math.round(Math.min(-5, Math.max(-60, baseSl)));
  trailingPercent = Math.round(Math.max(5, Math.min(50, trailingPercent)));

  return { tp, sl, trailing, trailingPercent, reasoning };
}
