import { db } from '../db/connection.js';
import { now } from '../utils.js';

const WALLET_SCORE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const walletScoreCache = new Map(); // address -> { score, pnl, cachedAt }

export function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}

export async function fetchWalletPnl(address) {
  try {
    const url = `https://datapi.jup.ag/v1/pnl?addresses=${encodeURIComponent(address)}&includeClosed=false`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.[address] ?? data?.data?.[address] ?? data;
    if (!d || typeof d !== 'object') return null;
    return {
      totalTrades: Number(d.totalTrades ?? d.total_trades ?? 0),
      wins: Number(d.wins ?? d.winCount ?? d.win_count ?? 0),
      winRate: Number(d.winRate ?? d.win_rate ?? 0),
      totalPnlPercent: Number(d.totalPnlPercent ?? d.total_pnl_percent ?? d.totalPnlUsd ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Score a wallet 0-100 based on PnL data.
 * Factors: win rate (40%), trade count reliability (30%), total PnL (30%).
 * Wallets with <5 trades get penalized (not enough data).
 */
function scoreWallet(pnl) {
  if (!pnl || pnl.totalTrades < 3) return 0;
  const winRateScore = Math.min(100, pnl.winRate * 1.2); // 83% WR → 100
  const tradeCountScore = Math.min(100, (pnl.totalTrades / 20) * 100); // 20 trades → 100
  const pnlScore = pnl.totalPnlPercent > 0
    ? Math.min(100, 50 + pnl.totalPnlPercent / 5) // +250% PnL → 100
    : Math.max(0, 50 + pnl.totalPnlPercent / 2);   // -100% PnL → 0
  return Math.round(winRateScore * 0.4 + tradeCountScore * 0.3 + pnlScore * 0.3);
}

/**
 * Fetch and cache wallet scores for all saved wallets.
 * Parallelizes API calls with concurrency limit of 5.
 * Returns Map<address, { score, pnl, cachedAt }>.
 */
export async function fetchWalletScores() {
  const wallets = savedWallets();
  const now_ = now();
  const result = new Map();

  // Evict stale cache entries
  for (const [addr, entry] of walletScoreCache) {
    if (now_ - entry.cachedAt > WALLET_SCORE_CACHE_TTL_MS) {
      walletScoreCache.delete(addr);
    }
  }

  // Split into cached and needs-fetch
  const toFetch = [];
  for (const wallet of wallets) {
    const cached = walletScoreCache.get(wallet.address);
    if (cached && now_ - cached.cachedAt < WALLET_SCORE_CACHE_TTL_MS) {
      result.set(wallet.address, cached);
    } else {
      toFetch.push(wallet);
    }
  }

  // Parallel fetch with concurrency limit of 5
  const CONCURRENCY = 5;
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(w => fetchWalletPnl(w.address))
    );
    for (let j = 0; j < batch.length; j++) {
      const pnl = settled[j].status === 'fulfilled' ? settled[j].value : null;
      const score = scoreWallet(pnl);
      const entry = { score, pnl, cachedAt: now_ };
      walletScoreCache.set(batch[j].address, entry);
      result.set(batch[j].address, entry);
    }
  }

  return result;
}

export async function fetchSavedWalletExposure(mint, holders) {
  const wallets = savedWallets();
  if (!wallets.length || !holders?.holders?.length) {
    return { holderCount: 0, checked: wallets.length, wallets: [], smartScore: 0, matchedWalletDetails: [] };
  }
  const holderSet = new Set(holders.holders.map(h => h.address));
  const matched = wallets.filter(wallet => holderSet.has(wallet.address));

  // Fetch scores for matched wallets
  const scores = await fetchWalletScores();
  const matchedDetails = matched.map(w => {
    const scoreData = scores.get(w.address);
    return {
      label: w.label,
      address: w.address,
      score: scoreData?.score ?? 0,
      winRate: scoreData?.pnl?.winRate ?? 0,
      totalTrades: scoreData?.pnl?.totalTrades ?? 0,
    };
  });

  // Smart score = weighted average of matched wallet scores
  // More matched wallets with high scores = higher smart score
  const avgScore = matchedDetails.length > 0
    ? Math.round(matchedDetails.reduce((sum, w) => sum + w.score, 0) / matchedDetails.length)
    : 0;

  return {
    holderCount: matched.length,
    checked: wallets.length,
    wallets: matched.map(w => w.label),
    smartScore: avgScore,
    matchedWalletDetails: matchedDetails,
  };
}
