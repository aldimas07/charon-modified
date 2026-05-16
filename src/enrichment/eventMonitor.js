/**
 * Pump.fun event monitor — watches for large Buy/Sell events on tracked tokens.
 * Uses Helius enhanced WebSocket or polling to detect trades in real-time.
 *
 * Can trigger early exits when:
 * - Large sell detected on a held position (dump detection)
 * - Bonding curve completion detected (graduation)
 * - Unusual volume spike on a candidate
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_RPC_URL, PUMP_PROGRAM } from '../config.js';
import { extractPumpEventsFromLogs, isPumpTradeEvent, fetchBondingCurve, updateBcFromEvent, invalidateBcCache, detectGraduation } from './pumpfunMath.js';
import { db } from '../db/connection.js';
import { now } from '../utils.js';

// ── Config ───────────────────────────────────────────────────────────
const MONITOR_INTERVAL_MS = 30_000; // 30s polling
const DUMP_THRESHOLD_SOL = 5; // alert on sells > 5 SOL
const LARGE_BUY_THRESHOLD_SOL = 10; // alert on buys > 10 SOL

let _connection = null;
let _monitorInterval = null;
let _watchedMints = new Set(); // mints we're actively monitoring
let _eventHandlers = { onDump: null, onGraduation: null, onLargeTrade: null };

// ── Event Handler Registration ───────────────────────────────────────
export function onPumpEvent(handler, eventType = 'all') {
  if (eventType === 'dump' || eventType === 'all') _eventHandlers.onDump = handler;
  if (eventType === 'graduation' || eventType === 'all') _eventHandlers.onGraduation = handler;
  if (eventType === 'largeTrade' || eventType === 'all') _eventHandlers.onLargeTrade = handler;
}

// ── Watch Management ─────────────────────────────────────────────────
export function watchMint(mint) {
  _watchedMints.add(typeof mint === 'string' ? mint : mint.toBase58?.() || String(mint));
}

export function unwatchMint(mint) {
  _watchedMints.delete(typeof mint === 'string' ? mint : mint.toBase58?.() || String(mint));
}

/**
 * Auto-populate watched mints from open positions.
 */
export function syncWatchedMints() {
  try {
    const positions = db.prepare("SELECT mint FROM dry_run_positions WHERE status = 'open'").all();
    _watchedMints = new Set(positions.map(p => p.mint));
    console.log(`[event-monitor] watching ${_watchedMints.size} open position mints`);
  } catch (err) {
    console.log(`[event-monitor] sync failed: ${err.message}`);
  }
}

// ── Polling Monitor ──────────────────────────────────────────────────
/**
 * Start polling for recent transactions on watched mints.
 * Uses Helius getSignaturesForAsset to find recent trades, then
 * decodes events from the transaction logs.
 */
export function startEventMonitor() {
  if (_monitorInterval) return;

  _connection = new Connection(SOLANA_RPC_URL);
  syncWatchedMints();

  _monitorInterval = setInterval(pollRecentTrades, MONITOR_INTERVAL_MS);
  console.log(`[event-monitor] started, polling every ${MONITOR_INTERVAL_MS / 1000}s for ${_watchedMints.size} mints`);
}

export function stopEventMonitor() {
  if (_monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
    console.log('[event-monitor] stopped');
  }
}

const seenSigs = new Set();
const SEEN_SIG_TTL = 5 * 60 * 1000; // 5 min
let lastPrune = 0;

async function pollRecentTrades() {
  if (_watchedMints.size === 0) return;

  // Prune old signatures
  const nowMs = Date.now();
  if (nowMs - lastPrune > SEEN_SIG_TTL) {
    seenSigs.clear();
    lastPrune = nowMs;
  }

  for (const mint of _watchedMints) {
    try {
      const pda = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
        new PublicKey(PUMP_PROGRAM),
      )[0];

      // Get recent signatures for the bonding curve account
      const sigs = await _connection.getSignaturesForAddress(pda, { limit: 3 });

      for (const sig of sigs) {
        if (seenSigs.has(sig.signature)) continue;
        seenSigs.add(sig.signature);

        // Fetch transaction to decode events
        const tx = await _connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (!tx?.meta?.logMessages) continue;

        const events = extractPumpEventsFromLogs(tx.meta.logMessages);
        for (const event of events) {
          await processEvent(mint, event, sig.signature, tx);
        }
      }
    } catch (err) {
      // Rate limit or RPC error — skip this mint
      if (!err.message?.includes('429')) {
        console.log(`[event-monitor] ${mint.slice(0, 8)}: ${err.message}`);
      }
    }
  }
}

async function processEvent(mint, event, signature, tx) {
  if (!event?.data) return;

  const solAmount = event.data.solAmount ? event.data.solAmount.toNumber() / 1e9 : 0;

  // Update bonding curve cache from trade event (more efficient than RPC fetch)
  if ((event.type === 'Buy' || event.type === 'Sell') && event.data.virtualSolReserves) {
    updateBcFromEvent(mint, event.data);
  }

  // Large trade detection
  if (event.type === 'Sell' && solAmount >= DUMP_THRESHOLD_SOL) {
    console.log(`[event-monitor] DUMP detected: ${mint.slice(0, 8)} — ${solAmount.toFixed(2)} SOL sell`);
    if (_eventHandlers.onDump) {
      _eventHandlers.onDump({ mint, event, signature, solAmount });
    }
  }

  if (event.type === 'Buy' && solAmount >= LARGE_BUY_THRESHOLD_SOL) {
    console.log(`[event-monitor] LARGE BUY: ${mint.slice(0, 8)} — ${solAmount.toFixed(2)} SOL`);
    if (_eventHandlers.onLargeTrade) {
      _eventHandlers.onLargeTrade({ mint, event, signature, solAmount });
    }
  }

  // Graduation detection — invalidate cache and check AMM
  if (event.type === 'CompletePump' || event.type === 'MigrateToAmm') {
    console.log(`[event-monitor] GRADUATION: ${mint.slice(0, 8)} — ${event.type}`);
    invalidateBcCache(mint); // clear both BC and pool cache
    unwatchMint(mint); // no longer on bonding curve

    // Detect AMM pool
    const amm = await detectGraduation(mint);
    if (amm.graduated) {
      console.log(`[event-monitor] AMM pool detected for ${mint.slice(0, 8)}: mcap $${Math.round(amm.marketCap * 150)}`);
    }

    if (_eventHandlers.onGraduation) {
      _eventHandlers.onGraduation({ mint, event, signature, amm });
    }
  }
}

// ── Bonding Curve Change Detector ────────────────────────────────────
/**
 * Compare current bonding curve reserves with last known state.
 * Returns { changed, deltaSol, deltaTokens, significantChange }
 */
export async function detectBondingCurveChange(mint, lastKnownBc) {
  const current = await fetchBondingCurve(mint, false); // force fresh
  if (!current || !lastKnownBc) return null;

  const deltaSol = current.virtualSolReserves.sub(lastKnownBc.virtualSolReserves);
  const deltaTokens = current.virtualTokenReserves.sub(lastKnownBc.virtualTokenReserves);

  const solChange = Math.abs(deltaSol.toNumber()) / 1e9;
  const significantChange = solChange >= 1; // >1 SOL movement

  return {
    changed: !deltaSol.isZero() || !deltaTokens.isZero(),
    deltaSol: deltaSol.toString(),
    deltaTokens: deltaTokens.toString(),
    solChange,
    significantChange,
    current,
  };
}
