/**
 * Holder Growth Velocity Tracker
 *
 * Tracks holder count changes per token over a rolling window.
 * Holder growth rate = new holders per minute.
 *
 * Fast organic holder growth is a strong signal of genuine interest.
 * Tokens that gain 5+ holders per minute are often in early pump phase.
 */

import { now } from '../utils.js';

const GROWTH_WINDOW_MS = 15 * 60 * 1000; // 15 minute rolling window
const PRUNE_INTERVAL_MS = 2 * 60 * 1000; // prune every 2 min
const MAX_SNAPSHOTS_PER_MINT = 30;       // limit memory per mint

// mint -> Array<{ count: number, ts: number }>
const holderSnapshots = new Map();
let lastPrune = 0;

// Interval-based prune
const _pruneTimer = setInterval(() => {
  const ts = now();
  if (ts - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOldSnapshots(ts);
    lastPrune = ts;
  }
}, PRUNE_INTERVAL_MS);
_pruneTimer.unref();

/**
 * Record a holder count snapshot for a mint.
 * Called from candidateBuilder when holder data is fetched.
 */
export function recordHolderCount(mint, holderCount) {
  if (!mint || !Number.isFinite(holderCount) || holderCount <= 0) return;

  const ts = now();
  if (!holderSnapshots.has(mint)) holderSnapshots.set(mint, []);

  const snapshots = holderSnapshots.get(mint);

  // Skip if last snapshot was < 30 seconds ago (avoid noise)
  if (snapshots.length > 0 && ts - snapshots[snapshots.length - 1].ts < 30_000) return;

  snapshots.push({ count: holderCount, ts });

  // Limit snapshots per mint
  if (snapshots.length > MAX_SNAPSHOTS_PER_MINT) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS_PER_MINT);
  }

  // Opportunistic prune
  if (ts - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOldSnapshots(ts);
    lastPrune = ts;
  }
}

/**
 * Get holder growth velocity for a mint.
 * Returns { growthRate, deltaHolders, deltaMinutes, snapshotCount }
 */
export function getHolderGrowth(mint) {
  const ts = now();
  const cutoff = ts - GROWTH_WINDOW_MS;
  const snapshots = (holderSnapshots.get(mint) || []).filter(s => s.ts > cutoff);

  if (snapshots.length < 2) {
    return { growthRate: 0, deltaHolders: 0, deltaMinutes: 0, snapshotCount: snapshots.length };
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const deltaHolders = last.count - first.count;
  const deltaMinutes = (last.ts - first.ts) / 60_000;
  const growthRate = deltaMinutes > 0 ? Math.round((deltaHolders / deltaMinutes) * 100) / 100 : 0;

  return {
    growthRate: Math.max(0, growthRate), // only positive growth is interesting
    deltaHolders,
    deltaMinutes: Math.round(deltaMinutes * 10) / 10,
    snapshotCount: snapshots.length,
  };
}

function pruneOldSnapshots(ts) {
  const cutoff = ts - GROWTH_WINDOW_MS;
  for (const [mint, snapshots] of holderSnapshots) {
    const filtered = snapshots.filter(s => s.ts > cutoff);
    if (filtered.length === 0) {
      holderSnapshots.delete(mint);
    } else {
      holderSnapshots.set(mint, filtered);
    }
  }
}

/**
 * Get count of mints currently tracked.
 */
export function trackedMintCount() {
  return holderSnapshots.size;
}
