import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { enrichWithBondingCurve, detectGraduation } from '../enrichment/pumpfunMath.js';
import { getFeeVelocity } from '../signals/feeVelocity.js';
import { recordHolderCount, getHolderGrowth } from '../signals/holderGrowth.js';
import { recordHolderSnapshot, getSellPressure } from '../signals/sellPressure.js';
import { scanForNewEntries, detectCluster } from '../signals/coordination.js';
import { savedWallets } from '../enrichment/wallets.js';
import { gmgnLink } from '../format.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const smartScore = candidate.savedWalletExposure.smartScore ?? 0;
  const feeSol = candidate.feeClaim?.distributedSol;
  const feeVel = candidate.metrics.feeVelocitySolPerMin ?? 0;
  const holderGrowthRate = candidate.metrics.holderGrowthRate ?? 0;
  const devDumpRisk = candidate.metrics.devDumpRisk ?? 0;
  const whaleExitRisk = candidate.metrics.whaleExitRisk ?? 0;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // Smart wallet score (quality of matched wallets, not just count)
  if (strat.min_smart_wallet_score > 0 && savedCount > 0 && smartScore < strat.min_smart_wallet_score) {
    failures.push(`smart wallet score: ${smartScore} < ${strat.min_smart_wallet_score}`);
  }

  // Fee velocity — rate of fee claims in the rolling window
  if (strat.min_fee_velocity_sol_per_min > 0 && feeVel < strat.min_fee_velocity_sol_per_min) {
    failures.push(`fee velocity: ${feeVel} SOL/min < ${strat.min_fee_velocity_sol_per_min} SOL/min`);
  }

  // Holder growth rate — new holders per minute
  if (strat.min_holder_growth_rate > 0 && holderGrowthRate < strat.min_holder_growth_rate) {
    failures.push(`holder growth: ${holderGrowthRate}/min < ${strat.min_holder_growth_rate}/min`);
  }

  // Dev dump risk — top holder selling significant portion
  if (strat.max_dev_dump_risk_pct > 0 && devDumpRisk > strat.max_dev_dump_risk_pct) {
    failures.push(`dev dump risk: ${devDumpRisk}% > ${strat.max_dev_dump_risk_pct}%`);
  }

  // Whale exit risk — multiple top holders selling
  if (strat.max_whale_exit_count > 0 && whaleExitRisk >= strat.max_whale_exit_count) {
    failures.push(`whale exits: ${whaleExitRisk} >= ${strat.max_whale_exit_count}`);
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Price impact filter — reject if buying 0.1 SOL causes >5% impact (500 bps)
  if (candidate.bondingCurve?.priceImpactBpsMedium != null) {
    const maxImpact = 500; // 5% in bps
    if (candidate.bondingCurve.priceImpactBpsMedium > maxImpact) {
      failures.push(`price impact: ${candidate.bondingCurve.priceImpactBpsMedium}bps > ${maxImpact}bps for 0.1 SOL`);
    }
  }

  // Graduation progress — bonus signal, not a hard filter (yet)
  // Tokens at 80%+ graduation have higher chance of AMM migration
  if (candidate.bondingCurve?.graduationPercent >= 95) {
    failures.push(`graduation: ${candidate.bondingCurve.graduationPercent}% — too close to graduation, may migrate soon`);
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const feeVelocity = getFeeVelocity(mint);
  const holderGrowth = getHolderGrowth(mint);

  // Record holder count snapshot for growth tracking
  const currentHolderCount = Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0);
  if (currentHolderCount > 0) recordHolderCount(mint, currentHolderCount);

  // Record holder snapshot for sell pressure detection
  if (holders?.top20?.length) recordHolderSnapshot(mint, holders);
  const sellPressure = getSellPressure(mint);

  // Scan for coordinated wallet entries
  scanForNewEntries(mint, holders?.holders || [], savedWallets());
  const cluster = detectCluster(mint);

  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );

  // Enrich with bonding curve data (on-chain pricing, graduation, price impact)
  const solPriceUsd = priceUsd && jupiterAsset?.usdPrice ? undefined : 150; // fallback SOL price
  let bondingCurve = await enrichWithBondingCurve(mint, solPriceUsd);

  // If bonding curve not found, check if token graduated to AMM
  let ammData = null;
  if (!bondingCurve && graduatedCoin) {
    const amm = await detectGraduation(mint);
    if (amm.graduated) {
      ammData = {
        graduated: true,
        marketCapUsd: amm.marketCap * (solPriceUsd || 150),
        poolAddress: amm.poolAddress,
      };
    }
  }

  // Use bonding curve mcap as fallback if GMGN/Jupiter unavailable
  const finalMarketCapUsd = firstPositiveNumber(
    marketCapUsd,
    bondingCurve?.bondingCurveMarketCapUsd,
    ammData?.marketCapUsd,
  ) || marketCapUsd;

  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd: finalMarketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
      feeVelocitySolPerMin: feeVelocity.velocitySolPerMin,
      feeVelocityTotalSol: feeVelocity.totalSolWindow,
      feeVelocityEventCount: feeVelocity.eventCount,
      holderGrowthRate: holderGrowth.growthRate,
      holderGrowthDelta: holderGrowth.deltaHolders,
      holderGrowthWindowMin: holderGrowth.deltaMinutes,
      devDumpRisk: sellPressure.devDumpRisk,
      whaleExitRisk: sellPressure.whaleExitRisk,
      topHolderDelta: sellPressure.topHolderDelta,
      clusterBuy: cluster.isCluster,
      clusterSize: cluster.clusterSize,
      clusterWallets: cluster.wallets,
    },
    sellPressureDetails: sellPressure.details,
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    bondingCurve: bondingCurve ? {
      marketCapUsd: bondingCurve.bondingCurveMarketCapUsd,
      graduationPercent: bondingCurve.graduationPercent,
      graduationSolNeeded: bondingCurve.graduationSolNeeded,
      buyPriceSol: bondingCurve.buyPriceSol,
      sellPriceSol: bondingCurve.sellPriceSol,
      spread: bondingCurve.spread,
      priceImpactBpsSmall: bondingCurve.priceImpactBpsSmall,
      priceImpactBpsMedium: bondingCurve.priceImpactBpsMedium,
    } : null,
    ammPool: ammData ? {
      graduated: true,
      marketCapUsd: ammData.marketCapUsd,
      poolAddress: ammData.poolAddress,
    } : null,
    createdAtMs: now(),
  };
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
