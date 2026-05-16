/**
 * Pump.fun bonding curve math — ported from @nirholas/pump-fun-sdk
 *
 * Provides exact pricing, price impact, graduation progress, and market cap
 * calculations using on-chain bonding curve reserves. More accurate than
 * GMGN/Jupiter approximations for pre-graduation pump.fun tokens.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_PROGRAM, HELIUS_API_KEY, SOLANA_RPC_URL } from '../config.js';

// ── Constants ────────────────────────────────────────────────────────
const LAMPORTS_PER_SOL = new BN(1_000_000_000);
const ONE_BILLION_SUPPLY = new BN('1000000000000000'); // 1e15 (6 decimals)
const INITIAL_REAL_TOKEN_RESERVES = new BN('793100000000000'); // 793.1M * 10^6
const TOKEN_DECIMALS = 1_000_000; // 10^6

// ── RPC Cache ────────────────────────────────────────────────────────
const bcCache = new Map(); // mint → { data, fetchedAt }
const BC_CACHE_TTL = 15_000; // 15s — bonding curve reserves change every trade

let _connection = null;
function getConnection() {
  if (!_connection && SOLANA_RPC_URL) {
    _connection = new Connection(SOLANA_RPC_URL);
  }
  return _connection;
}

// ── PDA Derivation ───────────────────────────────────────────────────
function bondingCurvePda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM),
  );
  return pda;
}

// ── Account Decoding ─────────────────────────────────────────────────
// Layout: discriminator(8) + virtualTokenReserves(u64) + virtualSolReserves(u64)
//         + realTokenReserves(u64) + realSolReserves(u64) + tokenTotalSupply(u64)
//         + complete(bool) + creator(pubkey32) + isMayhemMode(bool) + isCashbackCoin(bool)
function decodeBondingCurve(data) {
  if (!data || data.length < 8 + 8 * 5 + 1 + 32 + 1 + 1) return null;
  let o = 8; // skip Anchor discriminator
  const r = (n) => { const v = new BN(data.slice(o, o + n), 'le'); o += n; return v; };
  const bool = () => { const v = data[o] === 1; o += 1; return v; };

  return {
    virtualTokenReserves: r(8),
    virtualSolReserves: r(8),
    realTokenReserves: r(8),
    realSolReserves: r(8),
    tokenTotalSupply: r(8),
    complete: bool(),
    creator: new PublicKey(data.slice(o, o + 32)),
    isMayhemMode: bool(),
    isCashbackCoin: bool(),
  };
}

// ── Fetch Bonding Curve ──────────────────────────────────────────────
export async function fetchBondingCurve(mint, useCache = true) {
  const cacheKey = typeof mint === 'string' ? mint : mint.toBase58?.() || String(mint);
  if (useCache) {
    const cached = bcCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < BC_CACHE_TTL) return cached.data;
  }

  const conn = getConnection();
  if (!conn) return null;

  try {
    const pda = bondingCurvePda(cacheKey);
    const info = await conn.getAccountInfo(pda);
    if (!info) return null;
    const bc = decodeBondingCurve(info.data);
    if (bc) bcCache.set(cacheKey, { data: bc, fetchedAt: Date.now() });
    return bc;
  } catch (err) {
    console.log(`[pumpfun] fetchBondingCurve failed for ${cacheKey.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

// ── Batch Fetch ──────────────────────────────────────────────────────
export async function fetchMultipleBondingCurves(mints) {
  const conn = getConnection();
  if (!conn) return {};

  const toFetch = [];
  const results = {};

  for (const mint of mints) {
    const key = typeof mint === 'string' ? mint : mint.toBase58?.() || String(mint);
    const cached = bcCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < BC_CACHE_TTL) {
      results[key] = cached.data;
    } else {
      toFetch.push(key);
    }
  }

  if (toFetch.length === 0) return results;

  try {
    const pdas = toFetch.map(m => bondingCurvePda(m));
    // getMultipleAccountsInfo max 100
    for (let i = 0; i < pdas.length; i += 100) {
      const batch = pdas.slice(i, i + 100);
      const mintsBatch = toFetch.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(batch);
      for (let j = 0; j < infos.length; j++) {
        if (infos[j]) {
          const bc = decodeBondingCurve(infos[j].data);
          if (bc) {
            bcCache.set(mintsBatch[j], { data: bc, fetchedAt: Date.now() });
            results[mintsBatch[j]] = bc;
          }
        }
      }
    }
  } catch (err) {
    console.log(`[pumpfun] batch fetch failed: ${err.message}`);
  }

  return results;
}

// ── Fee Calculation ──────────────────────────────────────────────────
// Default pump.fun fees (post April 2025)
const DEFAULT_PROTOCOL_FEE_BPS = 100; // 1%
const DEFAULT_CREATOR_FEE_BPS = 0;

function computeFeesBps(bc) {
  // Simplified: use default flat fees (no FeeConfig tiers for now)
  // FeeConfig tiered fees can be added later if needed
  return {
    protocolFeeBps: new BN(DEFAULT_PROTOCOL_FEE_BPS),
    creatorFeeBps: bc.creator && !bc.creator.equals(PublicKey.default)
      ? new BN(DEFAULT_CREATOR_FEE_BPS)
      : new BN(0),
  };
}

function getFee(amount, feeBps) {
  // ceilDiv(amount * feeBps, 10000)
  return amount.mul(feeBps).add(new BN(9999)).div(new BN(10_000));
}

// ── Core Pricing Math ────────────────────────────────────────────────

/**
 * Given SOL amount (lamports), calculate how many tokens you'd receive.
 * Accounts for fees deducted from input SOL.
 */
export function getBuyTokenAmount(bc, solAmountLamports) {
  const amount = new BN(solAmountLamports);
  if (amount.isZero() || !bc) return new BN(0);
  if (bc.virtualTokenReserves.isZero()) return new BN(0);

  const { protocolFeeBps, creatorFeeBps } = computeFeesBps(bc);
  const totalFeeBps = protocolFeeBps.add(creatorFeeBps);

  // Deduct fees from input
  const inputAmount = amount.subn(1).muln(10_000).div(totalFeeBps.addn(10_000));

  // tokensOut = inputAmount * virtualTokenReserves / (virtualSolReserves + inputAmount)
  const tokensOut = inputAmount
    .mul(bc.virtualTokenReserves)
    .div(bc.virtualSolReserves.add(inputAmount));

  // Cap at remaining supply
  return BN.min(tokensOut, bc.realTokenReserves);
}

/**
 * Given token amount (raw units), calculate how much SOL it costs to buy.
 * Returns total cost including fees.
 */
export function getBuySolCost(bc, tokenAmountRaw) {
  const amount = new BN(tokenAmountRaw);
  if (amount.isZero() || !bc) return new BN(0);
  if (bc.virtualTokenReserves.isZero()) return new BN(0);

  const minAmount = BN.min(amount, bc.realTokenReserves);

  // solCost = tokenAmount * virtualSolReserves / (virtualTokenReserves - tokenAmount) + 1
  const denominator = bc.virtualTokenReserves.sub(minAmount);
  if (denominator.isZero() || denominator.isNeg()) return new BN(0);

  const solCost = minAmount.mul(bc.virtualSolReserves).div(denominator).addn(1);

  // Add fees on top
  const { protocolFeeBps, creatorFeeBps } = computeFeesBps(bc);
  const totalFee = getFee(solCost, protocolFeeBps.add(creatorFeeBps));

  return solCost.add(totalFee);
}

/**
 * Given token amount (raw units), calculate how much SOL you'd receive from selling.
 * Returns net SOL after fees.
 */
export function getSellSolReceived(bc, tokenAmountRaw) {
  const amount = new BN(tokenAmountRaw);
  if (amount.isZero() || !bc) return new BN(0);
  if (bc.virtualTokenReserves.isZero()) return new BN(0);

  // grossSol = tokenAmount * virtualSolReserves / (virtualTokenReserves + tokenAmount)
  const grossSol = amount.mul(bc.virtualSolReserves).div(bc.virtualTokenReserves.add(amount));

  // Deduct fees
  const { protocolFeeBps, creatorFeeBps } = computeFeesBps(bc);
  const totalFee = getFee(grossSol, protocolFeeBps.add(creatorFeeBps));

  const netSol = grossSol.sub(totalFee);
  return BN.max(new BN(0), netSol);
}

// ── Price Impact ─────────────────────────────────────────────────────

/**
 * Calculate buy price impact in basis points (bps).
 * Returns { priceBefore, priceAfter, impactBps, tokensReceived }
 */
export function calculateBuyPriceImpact(bc, solAmountLamports) {
  if (!bc || bc.virtualTokenReserves.isZero()) return null;

  const spotPrice = (s, t) => s.mul(LAMPORTS_PER_SOL).div(t);

  const priceBefore = spotPrice(bc.virtualSolReserves, bc.virtualTokenReserves);
  const tokensReceived = getBuyTokenAmount(bc, solAmountLamports);

  const newSol = bc.virtualSolReserves.add(new BN(solAmountLamports));
  const newTokens = bc.virtualTokenReserves.sub(tokensReceived);

  if (newTokens.isZero() || newTokens.isNeg()) return null;
  const priceAfter = spotPrice(newSol, newTokens);

  const impactBps = priceBefore.isZero()
    ? 0
    : priceAfter.sub(priceBefore).muln(10_000).div(priceBefore).toNumber();

  return {
    priceBefore: priceBefore.toNumber() / 1e9,
    priceAfter: priceAfter.toNumber() / 1e9,
    impactBps,
    tokensReceived: tokensReceived.toString(),
  };
}

/**
 * Calculate sell price impact in basis points (bps).
 * Returns { priceBefore, priceAfter, impactBps, solReceived }
 */
export function calculateSellPriceImpact(bc, tokenAmountRaw) {
  if (!bc || bc.virtualTokenReserves.isZero()) return null;

  const spotPrice = (s, t) => s.mul(LAMPORTS_PER_SOL).div(t);

  const priceBefore = spotPrice(bc.virtualSolReserves, bc.virtualTokenReserves);
  const solReceived = getSellSolReceived(bc, tokenAmountRaw);

  const newSol = bc.virtualSolReserves.sub(solReceived);
  const newTokens = bc.virtualTokenReserves.add(new BN(tokenAmountRaw));

  if (newTokens.isZero()) return null;
  const priceAfter = spotPrice(newSol, newTokens);

  const impactBps = priceBefore.isZero()
    ? 0
    : priceBefore.sub(priceAfter).muln(10_000).div(priceBefore).toNumber();

  return {
    priceBefore: priceBefore.toNumber() / 1e9,
    priceAfter: priceAfter.toNumber() / 1e9,
    impactBps,
    solReceived: solReceived.toString(),
  };
}

// ── Market Cap ───────────────────────────────────────────────────────

/**
 * Calculate market cap in lamports from bonding curve reserves.
 * marketCap = virtualSolReserves * mintSupply / virtualTokenReserves
 */
export function bondingCurveMarketCap(bc) {
  if (!bc || bc.virtualTokenReserves.isZero()) return new BN(0);
  return bc.virtualSolReserves.mul(bc.tokenTotalSupply).div(bc.virtualTokenReserves);
}

/**
 * Get market cap in USD given SOL price.
 */
export function bondingCurveMarketCapUsd(bc, solPriceUsd) {
  const mcapLamports = bondingCurveMarketCap(bc);
  return mcapLamports.toNumber() / 1e9 * solPriceUsd;
}

// ── Graduation Progress ──────────────────────────────────────────────

/**
 * How close is the token to graduating to AMM? Returns 0..100 (percent).
 * Also returns estimated SOL needed to reach graduation.
 */
export function graduationProgress(bc, globalInitialRealTokenReserves) {
  if (!bc) return { percent: 0, isGraduated: false, tokensRemaining: '0', solNeeded: 0 };

  const initial = globalInitialRealTokenReserves || INITIAL_REAL_TOKEN_RESERVES;
  if (initial.isZero()) return { percent: 0, isGraduated: false, tokensRemaining: '0', solNeeded: 0 };

  if (bc.complete || bc.realTokenReserves.isZero()) {
    return { percent: 100, isGraduated: true, tokensRemaining: '0', solNeeded: 0 };
  }

  const tokensSold = initial.sub(bc.realTokenReserves);
  const percent = Math.min(100, tokensSold.toNumber() / initial.toNumber() * 100);

  // Estimate SOL needed to buy remaining tokens
  const solNeeded = getBuySolCost(bc, bc.realTokenReserves);

  return {
    percent: Math.round(percent * 100) / 100,
    isGraduated: false,
    tokensRemaining: bc.realTokenReserves.toString(),
    solNeeded: solNeeded.toNumber() / 1e9, // in SOL
  };
}

// ── Token Price ──────────────────────────────────────────────────────

/**
 * Get current buy/sell price per whole token (1 token = 10^6 raw units).
 * Returns prices in SOL.
 */
export function getTokenPrices(bc) {
  if (!bc || bc.virtualTokenReserves.isZero()) return null;

  const oneToken = new BN(TOKEN_DECIMALS);
  const buyCost = getBuySolCost(bc, oneToken);
  const sellReceived = getSellSolReceived(bc, oneToken);

  return {
    buyPriceSol: buyCost.toNumber() / 1e9,
    sellPriceSol: sellReceived.toNumber() / 1e9,
    spread: (buyCost.sub(sellReceived).toNumber() / 1e9),
  };
}

// ── Enrichment Integration ───────────────────────────────────────────

/**
 * Enrich a candidate with bonding curve data. Call this from candidateBuilder.
 * Returns null if bonding curve data unavailable (token graduated or RPC failed).
 */
export async function enrichWithBondingCurve(mint, solPriceUsd = 150) {
  const bc = await fetchBondingCurve(mint);
  if (!bc || bc.complete) return null; // graduated or unavailable

  const mcapLamports = bondingCurveMarketCap(bc);
  const mcapUsd = mcapLamports.toNumber() / 1e9 * solPriceUsd;
  const grad = graduationProgress(bc);
  const prices = getTokenPrices(bc);

  // Calculate price impact for typical Charon trade sizes
  const impactSmall = calculateBuyPriceImpact(bc, new BN(0.05 * 1e9)); // 0.05 SOL
  const impactMedium = calculateBuyPriceImpact(bc, new BN(0.1 * 1e9));  // 0.1 SOL

  return {
    bondingCurveMarketCapUsd: mcapUsd,
    graduationPercent: grad.percent,
    graduationSolNeeded: grad.solNeeded,
    buyPriceSol: prices?.buyPriceSol,
    sellPriceSol: prices?.sellPriceSol,
    spread: prices?.spread,
    priceImpactBpsSmall: impactSmall?.impactBps || 0,
    priceImpactBpsMedium: impactMedium?.impactBps || 0,
    virtualSolReserves: bc.virtualSolReserves.toString(),
    virtualTokenReserves: bc.virtualTokenReserves.toString(),
    realTokenReserves: bc.realTokenReserves.toString(),
    _bc: bc, // raw BC object for further calculations
  };
}

// ── Utilities ────────────────────────────────────────────────────────

/** SOL raw units → human SOL */
export function lamportsToSol(lamports) {
  return new BN(lamports).toNumber() / 1e9;
}

/** Token raw units → human tokens */
export function rawToTokens(raw) {
  return new BN(raw).toNumber() / TOKEN_DECIMALS;
}

// ── Sell Overflow Protection ─────────────────────────────────────────
// On Solana, selling too many tokens in one tx can cause u64 overflow:
// `amount * virtualSolReserves` exceeds u64::MAX, the TransferChecked
// moves tokens BEFORE the math aborts → tokens lost on revert.
// maxSafeSellAmount calculates the maximum tokens safe for a single sell.

const U64_MAX = new BN('18446744073709551615'); // 2^64 - 1
const SAFETY_FACTOR = 0.9; // 90% of theoretical max

/**
 * Maximum token amount safe for a single sell transaction.
 * Prevents u64 overflow in `tokenAmount * virtualSolReserves`.
 */
export function maxSafeSellAmount(bc) {
  if (!bc || bc.virtualSolReserves.isZero()) return new BN(0);
  // maxAmount = floor(0.9 * u64_MAX / virtualSolReserves)
  return new BN(Math.floor(SAFETY_FACTOR * U64_MAX.toNumber()))
    .div(bc.virtualSolReserves);
}

/**
 * Validate that a sell amount won't cause overflow.
 * Returns { valid, safeMax, requested, needsChunking }
 */
export function validateSellAmount(bc, tokenAmountRaw) {
  const requested = new BN(tokenAmountRaw);
  const safeMax = maxSafeSellAmount(bc);
  const needsChunking = requested.gt(safeMax);
  return {
    valid: !needsChunking,
    safeMax: safeMax.toString(),
    requested: requested.toString(),
    needsChunking,
  };
}

/**
 * Execute a large sell in safe chunks. Calls sellFn(chunkAmount) for each chunk,
 * refetching bonding curve state between chunks to get fresh reserves.
 * Returns aggregated results.
 */
export async function sellChunked({ bc, mint, tokenAmountRaw, sellFn, refetchBcFn, maxChunks = 5 }) {
  let remaining = new BN(tokenAmountRaw);
  const results = [];
  let currentBc = bc;

  for (let i = 0; i < maxChunks && remaining.gt(new BN(0)); i++) {
    const safeMax = maxSafeSellAmount(currentBc);
    const chunkAmount = BN.min(remaining, safeMax);

    if (chunkAmount.isZero()) break;

    console.log(`[pumpfun] sell chunk ${i + 1}: ${chunkAmount.toString()} tokens (${remaining.toString()} remaining)`);

    const result = await sellFn(chunkAmount.toString());
    results.push(result);

    remaining = remaining.sub(chunkAmount);

    // Refetch bonding curve state for accurate safe amount calculation
    if (remaining.gt(new BN(0)) && refetchBcFn) {
      const freshBc = await refetchBcFn(mint);
      if (freshBc) currentBc = freshBc;
    }
  }

  return {
    chunks: results.length,
    totalSold: new BN(tokenAmountRaw).sub(remaining).toString(),
    remaining: remaining.toString(),
    results,
  };
}

// ── Event Decoder ────────────────────────────────────────────────────
// Decodes raw Anchor events from transaction logs into typed objects.
// Discriminators from the pump.fun IDL (8-byte sha256 prefix).

const EVENT_DISCRIMINATORS = {
  // Pump program events
  'a537817004b3ca28': 'SetTokenMeta',
  'b7e9b62f624d793b': 'CreateToken',
  '4c043e3bb0174241': 'Buy',
  '371b61073072602e': 'Sell',
  'e445a52e51cb9a1d': 'CompletePump',
  '1b8a98449ae7e832': 'MigrateToAmm',
  '68c7a2bc77cb814a': 'UpdateGlobal',
  '9527de9bd37c981a': 'SetCreator',
  'f3a4f24d04c2c1a2': 'SetMetaplexCreator',
  'eb67b76e370f02eb': 'AdminSetCreator',
  '4d9f47f2b2907da7': 'UpdateTokenMeta',
  // PumpAMM events
  '7c53e2d132e6a83a': 'CreatePool',
  'f0403b8e8e3a1f3f': 'Deposit',
  'a051e66e8f5b0acc': 'Withdraw',
  '9bb16cd40a3ac612': 'BuyExactIn',
  '257f7f3e02d1a8a1': 'BuyExactOut',
  '40db7dc33cf78f0c': 'SellExactIn',
  'a93c1f7c2f20c4a4': 'SellExactOut',
  // PumpFees events
  'a537817004b3ca29': 'ClaimTokenIncentives',
  'b7e9b62f624d793c': 'UpdateFeeConfig',
};

/**
 * Try to decode a pump.fun event from raw transaction log data.
 * Returns { type, data } or null if not a recognized pump event.
 */
export function tryDecodePumpEvent(logData) {
  if (!logData || logData.length < 16) return null;

  // Extract 8-byte discriminator from hex or buffer
  let disc;
  if (typeof logData === 'string') {
    // Hex string — extract first 16 hex chars (8 bytes)
    disc = logData.slice(0, 16).toLowerCase();
  } else if (Buffer.isBuffer(logData)) {
    disc = logData.slice(0, 8).toString('hex');
  } else {
    return null;
  }

  const eventType = EVENT_DISCRIMINATORS[disc];
  if (!eventType) return null;

  // Decode common fields based on event type
  try {
    const buf = typeof logData === 'string' ? Buffer.from(logData, 'hex') : logData;
    return decodePumpEvent(buf, eventType);
  } catch (err) {
    return { type: eventType, data: null, error: err.message };
  }
}

function decodePumpEvent(buf, type) {
  let o = 8; // skip discriminator

  const u64 = () => { const v = new BN(buf.slice(o, o + 8), 'le'); o += 8; return v; };
  const pubkey = () => { const v = buf.slice(o, o + 32); o += 32; return v; };
  const bool = () => { const v = buf[o] === 1; o += 1; return v; };
  const string = () => {
    const len = buf.readUInt32LE(o); o += 4;
    const s = buf.slice(o, o + len).toString('utf8'); o += len; return s;
  };

  switch (type) {
    case 'Buy':
    case 'Sell': {
      return {
        type,
        data: {
          mint: new PublicKey(pubkey()).toString(),
          solAmount: u64(),
          tokenAmount: u64(),
          isBuy: type === 'Buy',
          user: new PublicKey(pubkey()).toString(),
          timestamp: u64(),
          virtualSolReserves: u64(),
          virtualTokenReserves: u64(),
          realSolReserves: u64(),
          realTokenReserves: u64(),
        },
      };
    }
    case 'CreateToken': {
      return {
        type,
        data: {
          mint: new PublicKey(pubkey()).toString(),
          name: string(),
          symbol: string(),
          uri: string(),
          creator: new PublicKey(pubkey()).toString(),
        },
      };
    }
    case 'CompletePump': {
      return {
        type,
        data: {
          mint: new PublicKey(pubkey()).toString(),
          virtualSolReserves: u64(),
          virtualTokenReserves: u64(),
        },
      };
    }
    case 'MigrateToAmm': {
      return {
        type,
        data: {
          mint: new PublicKey(pubkey()).toString(),
          user: new PublicKey(pubkey()).toString(),
        },
      };
    }
    default:
      return { type, data: { raw: buf.slice(8).toString('hex').slice(0, 200) } };
  }
}

/**
 * Extract all pump.fun events from transaction logs.
 * Pass the transaction's logMessages array from getTransaction.
 */
export function extractPumpEventsFromLogs(logMessages) {
  if (!Array.isArray(logMessages)) return [];
  const events = [];

  for (const log of logMessages) {
    // Anchor events are logged as "Program data: <base64>"
    if (!log.startsWith('Program data: ')) continue;
    try {
      const b64 = log.slice('Program data: '.length);
      const buf = Buffer.from(b64, 'base64');
      const event = tryDecodePumpEvent(buf);
      if (event) events.push(event);
    } catch (e) {
      // skip malformed
    }
  }

  return events;
}

/**
 * Quick check: is this a pump.fun Buy/Sell event?
 * Useful for filtering transaction logs before full decode.
 */
export function isPumpTradeEvent(buf) {
  if (!buf || buf.length < 16) return false;
  const disc = Buffer.isBuffer(buf) ? buf.slice(0, 8).toString('hex') : String(buf).slice(0, 16).toLowerCase();
  return disc === '4c043e3bb0174241' || disc === '371b61073072602e'; // Buy or Sell
}

// ── AMM Pool Support (Graduated Tokens) ──────────────────────────────
// PumpAMM program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
// When a token graduates from bonding curve, it migrates to an AMM pool.
// We can detect this and get pricing from the pool's reserves.

const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const CANONICAL_POOL_INDEX = 0;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// AMM Pool cache
const poolCache = new Map();
const POOL_CACHE_TTL = 30_000; // 30s

/**
 * Derive the canonical PumpAMM pool PDA for a token mint.
 * Matches canonicalPumpPoolPda from pump-fun-sdk.
 */
export function canonicalPoolPda(mint) {
  const mintPk = new PublicKey(mint);
  const ammProgram = new PublicKey(PUMP_AMM_PROGRAM);

  // pumpPoolAuthorityPda = PDA(["pool-authority", mint], pump_program)
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool-authority'), mintPk.toBuffer()],
    new PublicKey(PUMP_PROGRAM),
  );

  // poolPda = PDA([index_le_u32, authority, baseMint, quoteMint], amm_program)
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(CANONICAL_POOL_INDEX);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [indexBuf, poolAuthority.toBuffer(), mintPk.toBuffer(), new PublicKey(WSOL_MINT).toBuffer()],
    ammProgram,
  );

  return poolPda;
}

/**
 * Decode AMM pool account data.
 * Layout: discriminator(8) + poolBump(u8) + index(u32) + creator(32) + baseMint(32)
 *         + quoteMint(32) + lpMint(32) + poolBaseTokenAccount(32)
 *         + poolQuoteTokenAccount(32) + lpSupply(u64) + coinCreator(32)
 *         + isMayhemMode(bool) + isCashbackCoin(bool)
 */
function decodeAmmPool(data) {
  if (!data || data.length < 8 + 1 + 4 + 32 * 7 + 8 + 32 + 1 + 1) return null;
  let o = 8; // skip discriminator

  const u8 = () => data[o++];
  const u32 = () => { const v = data.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = new BN(data.slice(o, o + 8), 'le'); o += 8; return v; };
  const pubkey = () => { const v = new PublicKey(data.slice(o, o + 32)); o += 32; return v; };
  const bool = () => data[o++] === 1;

  return {
    poolBump: u8(),
    index: u32(),
    creator: pubkey(),
    baseMint: pubkey(),
    quoteMint: pubkey(),
    lpMint: pubkey(),
    poolBaseTokenAccount: pubkey(),
    poolQuoteTokenAccount: pubkey(),
    lpSupply: u64(),
    coinCreator: pubkey(),
    isMayhemMode: bool(),
    isCashbackCoin: bool(),
  };
}

/**
 * Fetch AMM pool state for a graduated token.
 * Returns null if token hasn't graduated (no pool exists).
 */
export async function fetchAmmPool(mint, useCache = true) {
  const cacheKey = typeof mint === 'string' ? mint : mint.toBase58?.() || String(mint);
  if (useCache) {
    const cached = poolCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < POOL_CACHE_TTL) return cached.data;
  }

  const conn = getConnection();
  if (!conn) return null;

  try {
    const poolPda = canonicalPoolPda(cacheKey);
    const info = await conn.getAccountInfo(poolPda);
    if (!info) {
      poolCache.set(cacheKey, { data: null, fetchedAt: Date.now() });
      return null;
    }
    const pool = decodeAmmPool(info.data);
    poolCache.set(cacheKey, { data: pool, fetchedAt: Date.now() });
    return pool;
  } catch (err) {
    console.log(`[pumpfun] fetchAmmPool failed for ${cacheKey.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Get AMM pool reserves by fetching the pool's token accounts.
 * Returns { baseReserve, quoteReserve } in raw units.
 */
export async function getAmmReserves(pool) {
  if (!pool) return null;
  const conn = getConnection();
  if (!conn) return null;

  try {
    const [baseInfo, quoteInfo] = await conn.getMultipleAccountsInfo([
      pool.poolBaseTokenAccount,
      pool.poolQuoteTokenAccount,
    ]);

    if (!baseInfo || !quoteInfo) return null;

    // SPL Token account layout: mint(32) + owner(32) + amount(u64) + ...
    // Amount is at offset 64
    const baseReserve = new BN(baseInfo.data.slice(64, 72), 'le');
    const quoteReserve = new BN(quoteInfo.data.slice(64, 72), 'le');

    return { baseReserve, quoteReserve };
  } catch (err) {
    console.log(`[pumpfun] getAmmReserves failed: ${err.message}`);
    return null;
  }
}

/**
 * Calculate AMM market cap from pool reserves.
 * marketCap = quoteReserve * tokenTotalSupply / baseReserve / lamportsPerSol
 */
export function ammMarketCap(pool, reserves, tokenTotalSupply) {
  if (!reserves || reserves.baseReserve.isZero()) return 0;
  const mcapLamports = reserves.quoteReserve.mul(tokenTotalSupply).div(reserves.baseReserve);
  return mcapLamports.toNumber() / 1e9;
}

/**
 * Detect if a token has graduated to AMM.
 * Returns { graduated, pool, reserves, marketCap } or { graduated: false }.
 */
export async function detectGraduation(mint) {
  const pool = await fetchAmmPool(mint);
  if (!pool) return { graduated: false };

  const reserves = await getAmmReserves(pool);
  if (!reserves) return { graduated: true, pool, reserves: null, marketCap: 0 };

  const marketCap = ammMarketCap(pool, reserves, new BN('1000000000000000'));

  return {
    graduated: true,
    pool,
    reserves,
    marketCap,
    poolAddress: canonicalPoolPda(mint).toString(),
  };
}

// ── Batch Enrichment with Bonding Curve + AMM ────────────────────────
/**
 * Enrich multiple candidates at once. Uses batch RPC for bonding curves,
 * falls back to individual fetches for AMM pools.
 * Returns Map<mint, enrichmentData>.
 */
export async function batchEnrichCandidates(mints, solPriceUsd = 150) {
  const results = new Map();

  // Batch fetch bonding curves
  const bcMap = await fetchMultipleBondingCurves(mints);

  for (const mint of mints) {
    const bc = bcMap[mint];
    if (bc && !bc.complete) {
      // Still on bonding curve
      const mcapLamports = bondingCurveMarketCap(bc);
      const mcapUsd = mcapLamports.toNumber() / 1e9 * solPriceUsd;
      const grad = graduationProgress(bc);
      const prices = getTokenPrices(bc);
      const impactSmall = calculateBuyPriceImpact(bc, new BN(0.05 * 1e9));
      const impactMedium = calculateBuyPriceImpact(bc, new BN(0.1 * 1e9));

      results.set(mint, {
        source: 'bondingCurve',
        marketCapUsd: mcapUsd,
        graduationPercent: grad.percent,
        buyPriceSol: prices?.buyPriceSol,
        sellPriceSol: prices?.sellPriceSol,
        spread: prices?.spread,
        priceImpactBpsSmall: impactSmall?.impactBps || 0,
        priceImpactBpsMedium: impactMedium?.impactBps || 0,
      });
    } else if (bc && bc.complete) {
      // Graduated — try AMM
      const amm = await detectGraduation(mint);
      results.set(mint, {
        source: 'amm',
        graduated: true,
        marketCapUsd: amm.marketCap * solPriceUsd,
        poolAddress: amm.poolAddress,
      });
    } else {
      // No bonding curve data — might be graduated or invalid
      const amm = await detectGraduation(mint);
      if (amm.graduated) {
        results.set(mint, {
          source: 'amm',
          graduated: true,
          marketCapUsd: amm.marketCap * solPriceUsd,
          poolAddress: amm.poolAddress,
        });
      }
    }
  }

  return results;
}

// ── Cache Invalidation from Events ───────────────────────────────────
/**
 * Invalidate bonding curve cache when a trade event is detected.
 * Call this from event monitor when a Buy/Sell event is observed.
 */
export function invalidateBcCache(mint) {
  const key = typeof mint === 'string' ? mint : mint.toBase58?.() || String(mint);
  bcCache.delete(key);
  poolCache.delete(key);
}

/**
 * Update bonding curve cache with fresh data from a decoded trade event.
 * More efficient than re-fetching from RPC.
 */
export function updateBcFromEvent(mint, eventData) {
  if (!eventData?.virtualSolReserves) return;
  const key = typeof mint === 'string' ? mint : mint.toBase58?.() || String(mint);
  const bc = {
    virtualTokenReserves: eventData.virtualTokenReserves,
    virtualSolReserves: eventData.virtualSolReserves,
    realTokenReserves: eventData.realTokenReserves,
    realSolReserves: eventData.realSolReserves,
    tokenTotalSupply: new BN('1000000000000000'),
    complete: false,
    creator: null,
    isMayhemMode: false,
    isCashbackCoin: false,
  };
  bcCache.set(key, { data: bc, fetchedAt: Date.now() });
}
