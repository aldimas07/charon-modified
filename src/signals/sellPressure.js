/**
 * Sell Pressure Detector
 *
 * Tracks top holder balance changes over time.
 * Detects:
 * - Dev dump: top holder (usually dev wallet) selling significant portion
 * - Whale exit: multiple top holders reducing positions simultaneously
 *
 * Uses Jupiter holder data snapshots to detect balance declines.
 */

import { now } from '../utils.js';

const SNAPSHOT_WINDOW_MS = 10 * 60 * 1000; // 10 min lookback
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;  // prune every 5 min
const MAX_SNAPSHOTS_PER_MINT = 12;

// mint -> Array<{ topHolders: [{address, percent}], top20Percent, maxHolderPercent, ts }>
const holderSnapshots = new Map();
let lastPrune = 0;

// Interval-based prune
const _pruneTimer = setInterval(() => {
  const ts = now();
  if (ts - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOld(ts);
    lastPrune = ts;
  }
}, PRUNE_INTERVAL_MS);
_pruneTimer.unref();

/**
 * Record a holder snapshot for a mint.
 * Called from candidateBuilder when holder data is fetched.
 */
export function recordHolderSnapshot(mint, holdersData) {
  if (!mint || !holdersData?.top20?.length) return;

  const ts = now();
  if (!holderSnapshots.has(mint)) holderSnapshots.set(mint, []);

  const snapshots = holderSnapshots.get(mint);

  // Skip if last snapshot was < 60 seconds ago
  if (snapshots.length > 0 && ts - snapshots[snapshots.length - 1].ts < 60_000) return;

  const snapshot = {
    topHolders: holdersData.top20.slice(0, 10).map(h => ({
      address: h.address,
      percent: Number(h.percent || 0),
    })),
    top20Percent: Number(holdersData.top20Percent || 0),
    maxHolderPercent: Number(holdersData.maxHolderPercent || 0),
    ts,
  };

  snapshots.push(snapshot);
  if (snapshots.length > MAX_SNAPSHOTS_PER_MINT) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS_PER_MINT);
  }

  if (ts - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOld(ts);
    lastPrune = ts;
  }
}

/**
 * Analyze sell pressure for a mint.
 * Returns { devDumpRisk, whaleExitRisk, topHolderDelta, top20Delta, details }
 */
export function getSellPressure(mint) {
  const ts = now();
  const cutoff = ts - SNAPSHOT_WINDOW_MS;
  const snapshots = (holderSnapshots.get(mint) || []).filter(s => s.ts > cutoff);

  if (snapshots.length < 2) {
    return { devDumpRisk: 0, whaleExitRisk: 0, topHolderDelta: 0, top20Delta: 0, details: [] };
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const details = [];

  // Dev dump: compare top holder percent
  const firstTop = first.topHolders[0]?.percent ?? 0;
  const lastTop = last.topHolders[0]?.percent ?? 0;
  const topHolderDelta = lastTop - firstTop; // negative = sold
  const devDumpRisk = firstTop > 0 ? Math.max(0, Math.round((-topHolderDelta / firstTop) * 100)) : 0;

  if (devDumpRisk > 20) {
    details.push(`top holder sold ${devDumpRisk}% of position (${firstTop.toFixed(1)}% → ${lastTop.toFixed(1)}%)`);
  }

  // Whale exit: count how many top-5 holders reduced their position
  let whaleExits = 0;
  const compareCount = Math.min(5, first.topHolders.length, last.topHolders.length);
  for (let i = 0; i < compareCount; i++) {
    const prevPercent = first.topHolders[i]?.percent ?? 0;
    // Find same address in last snapshot
    const currHolder = last.topHolders.find(h => h.address === first.topHolders[i]?.address);
    const currPercent = currHolder?.percent ?? 0;
    if (prevPercent > 0.5 && currPercent < prevPercent * 0.7) { // sold >30% of position
      whaleExits++;
      details.push(`holder #${i + 1} reduced ${prevPercent.toFixed(1)}% → ${currPercent.toFixed(1)}%`);
    }
  }
  const whaleExitRisk = whaleExits;

  // Top 20 concentration change
  const top20Delta = (last.top20Percent ?? 0) - (first.top20Percent ?? 0);

  return { devDumpRisk, whaleExitRisk, topHolderDelta, top20Delta, details };
}

function pruneOld(ts) {
  const cutoff = ts - SNAPSHOT_WINDOW_MS;
  for (const [mint, snapshots] of holderSnapshots) {
    const filtered = snapshots.filter(s => s.ts > cutoff);
    if (filtered.length === 0) holderSnapshots.delete(mint);
    else holderSnapshots.set(mint, filtered);
  }
}

export function trackedMintCount() {
  return holderSnapshots.size;
}
