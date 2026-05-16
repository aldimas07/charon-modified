/**
 * Fee Velocity Tracker
 *
 * Tracks the rate of fee claims per token over a rolling window.
 * Fee velocity = SOL of fees distributed per minute.
 *
 * High velocity = many people actively trading = strong signal.
 * A sudden spike in velocity often precedes a price pump.
 */

import { now, lamToSol } from '../utils.js';

const FEE_WINDOW_MS = 10 * 60 * 1000; // 10 minute rolling window
const PRUNE_INTERVAL_MS = 60 * 1000;  // prune every 60s

// mint -> Array<{ sol: number, ts: number }>
const feeEvents = new Map();
let lastPrune = 0;

// Interval-based prune to prevent memory leak from stale mints
const _pruneTimer = setInterval(() => {
  const ts = now();
  if (ts - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOldEvents(ts);
    lastPrune = ts;
  }
}, PRUNE_INTERVAL_MS);
_pruneTimer.unref();

/**
 * Record a fee claim event for a token.
 * Called from feeClaim.js when a fee distribution is detected.
 */
export function recordFeeClaim(mint, distributedLamports, timestamp = null) {
  const ts = timestamp ?? now();
  const sol = lamToSol(distributedLamports);
  if (sol <= 0) return;

  if (!feeEvents.has(mint)) feeEvents.set(mint, []);
  feeEvents.get(mint).push({ sol, ts });

  // Opportunistic prune
  if (ts - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOldEvents(ts);
    lastPrune = ts;
  }
}

/**
 * Get fee velocity for a mint.
 * Returns { velocitySolPerMin, totalSolWindow, eventCount, windowMinutes }
 */
export function getFeeVelocity(mint) {
  const ts = now();
  const cutoff = ts - FEE_WINDOW_MS;
  const events = (feeEvents.get(mint) || []).filter(e => e.ts > cutoff);

  if (!events.length) {
    return { velocitySolPerMin: 0, totalSolWindow: 0, eventCount: 0, windowMinutes: FEE_WINDOW_MS / 60_000 };
  }

  const totalSol = events.reduce((sum, e) => sum + e.sol, 0);
  const windowMinutes = FEE_WINDOW_MS / 60_000;
  const velocity = totalSol / windowMinutes;

  return {
    velocitySolPerMin: Math.round(velocity * 10000) / 10000,
    totalSolWindow: Math.round(totalSol * 100) / 100,
    eventCount: events.length,
    windowMinutes,
  };
}

/**
 * Get fee velocity snapshot for multiple mints (for display/debug).
 */
export function getTopVelocities(limit = 10) {
  const ts = now();
  const cutoff = ts - FEE_WINDOW_MS;
  const results = [];

  for (const [mint, events] of feeEvents) {
    const recent = events.filter(e => e.ts > cutoff);
    if (!recent.length) continue;
    const totalSol = recent.reduce((sum, e) => sum + e.sol, 0);
    results.push({
      mint,
      totalSol: Math.round(totalSol * 100) / 100,
      velocitySolPerMin: Math.round((totalSol / (FEE_WINDOW_MS / 60_000)) * 10000) / 10000,
      eventCount: recent.length,
    });
  }

  results.sort((a, b) => b.velocitySolPerMin - a.velocitySolPerMin);
  return results.slice(0, limit);
}

function pruneOldEvents(ts) {
  const cutoff = ts - FEE_WINDOW_MS;
  for (const [mint, events] of feeEvents) {
    const filtered = events.filter(e => e.ts > cutoff);
    if (filtered.length === 0) {
      feeEvents.delete(mint);
    } else {
      feeEvents.set(mint, filtered);
    }
  }
}

/**
 * Get count of mints currently being tracked.
 */
export function trackedMintCount() {
  return feeEvents.size;
}
