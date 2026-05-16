/**
 * Coordination Detector
 *
 * Detects when multiple tracked wallets enter the same token
 * within a short time window — a "cluster buy" signal.
 *
 * Cluster buys indicate coordinated accumulation, often by
 * insider groups or smart money networks. Strong bullish signal
 * when combined with other filters.
 */

import { now } from '../utils.js';
import { db } from '../db/connection.js';

const CLUSTER_WINDOW_MS = 3 * 60 * 1000; // 3 minute window for cluster detection
const PRUNE_INTERVAL_MS = 2 * 60 * 1000;
const MIN_CLUSTER_SIZE = 3; // minimum wallets to form a cluster
const ENTRY_DEDUP_MS = 30 * 60 * 1000; // 30 min dedup for wallet+mint pairs

// mint -> Array<{ address, label, ts }>
const walletEntries = new Map();
// "mint:address" -> last recorded ts
const entrySeenCache = new Map();
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
 * Record that a wallet entered a token.
 * Only records NEW entries (not seen in last 30 min).
 */
export function recordWalletEntry(mint, address, label = '') {
  if (!mint || !address) return;

  const ts = now();
  const cacheKey = `${mint}:${address}`;

  // Dedup: same wallet + same mint within 30 min = skip
  const lastSeen = entrySeenCache.get(cacheKey);
  if (lastSeen && ts - lastSeen < ENTRY_DEDUP_MS) return;
  entrySeenCache.set(cacheKey, ts);

  if (!walletEntries.has(mint)) walletEntries.set(mint, []);
  walletEntries.get(mint).push({ address, label, ts });

  // Opportunistic prune
  if (ts - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOld(ts);
    lastPrune = ts;
  }
}

/**
 * Detect cluster buys for a mint.
 * Returns { isCluster, clusterSize, wallets, windowSeconds }
 */
export function detectCluster(mint) {
  const ts = now();
  const cutoff = ts - CLUSTER_WINDOW_MS;
  const entries = (walletEntries.get(mint) || []).filter(e => e.ts > cutoff);

  if (entries.length < MIN_CLUSTER_SIZE) {
    return { isCluster: false, clusterSize: entries.length, wallets: [], windowSeconds: 0 };
  }

  // Find the tightest cluster within the window
  const uniqueAddresses = [...new Set(entries.map(e => e.address))];
  const uniqueWallets = uniqueAddresses.map(addr => {
    const entry = entries.find(e => e.address === addr);
    return { address: addr, label: entry?.label || '', ts: entry?.ts || ts };
  }).sort((a, b) => a.ts - b.ts);

  // Check if all unique wallets fit within a 2-minute sub-window
  const tightWindow = 2 * 60_000;
  for (let i = 0; i <= uniqueWallets.length - MIN_CLUSTER_SIZE; i++) {
    const clusterEnd = uniqueWallets[i].ts + tightWindow;
    const clusterWallets = uniqueWallets.filter(w => w.ts >= uniqueWallets[i].ts && w.ts <= clusterEnd);

    if (clusterWallets.length >= MIN_CLUSTER_SIZE) {
      const windowSeconds = Math.round((clusterWallets[clusterWallets.length - 1].ts - clusterWallets[0].ts) / 1000);
      return {
        isCluster: true,
        clusterSize: clusterWallets.length,
        wallets: clusterWallets.map(w => w.label || w.address.slice(0, 8)),
        windowSeconds,
      };
    }
  }

  return { isCluster: false, clusterSize: uniqueAddresses.length, wallets: [], windowSeconds: 0 };
}

/**
 * Scan holder data for new wallet entries and record them.
 * Returns array of newly detected entries.
 */
export function scanForNewEntries(mint, currentHolders, savedWallets) {
  if (!currentHolders?.length || !savedWallets?.length) return [];

  const holderSet = new Set(currentHolders.map(h => h.address));
  const newEntries = [];

  for (const wallet of savedWallets) {
    if (holderSet.has(wallet.address)) {
      recordWalletEntry(mint, wallet.address, wallet.label);
      newEntries.push(wallet);
    }
  }

  return newEntries;
}

function pruneOld(ts) {
  const cutoff = ts - CLUSTER_WINDOW_MS;
  for (const [mint, entries] of walletEntries) {
    const filtered = entries.filter(e => e.ts > cutoff);
    if (filtered.length === 0) walletEntries.delete(mint);
    else walletEntries.set(mint, filtered);
  }
  // Prune entry seen cache
  const entryCutoff = ts - ENTRY_DEDUP_MS;
  for (const [key, seenTs] of entrySeenCache) {
    if (seenTs < entryCutoff) entrySeenCache.delete(key);
  }
}

export function trackedMintCount() {
  return walletEntries.size;
}
