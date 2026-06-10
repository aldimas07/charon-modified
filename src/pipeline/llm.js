import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS, LLM_MAX_TOKENS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting, activeStrategy } from '../db/settings.js';
import { dynamicTpSl } from './dynamicTpSl.js';
import { db } from '../db/connection.js';

export function normalizeDecision(parsed, fallbackReason = '') {
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
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
    },
    bondingCurve: c.bondingCurve ? {
      graduationPercent: c.bondingCurve.graduationPercent,
      priceImpactBps50: c.bondingCurve.priceImpactBpsSmall,
      priceImpactBps100: c.bondingCurve.priceImpactBpsMedium,
      spread: c.bondingCurve.spread,
    } : null,
    savedWalletExposure: c.savedWalletExposure ? {
      holderCount: c.savedWalletExposure.holderCount,
      smartScore: c.savedWalletExposure.smartScore ?? 0,
      wallets: c.savedWalletExposure.wallets,
      matchedDetails: c.savedWalletExposure.matchedWalletDetails ?? [],
    } : null,
    holderGrowth: {
      rate: c.metrics?.holderGrowthRate ?? 0,
      delta: c.metrics?.holderGrowthDelta ?? 0,
      windowMin: c.metrics?.holderGrowthWindowMin ?? 0,
    },
    sellPressure: {
      devDumpRisk: c.metrics?.devDumpRisk ?? 0,
      whaleExitRisk: c.metrics?.whaleExitRisk ?? 0,
      topHolderDelta: c.metrics?.topHolderDelta ?? 0,
      details: c.sellPressureDetails ?? [],
    },
    clusterBuy: c.metrics?.clusterBuy ?? false,
    clusterSize: c.metrics?.clusterSize ?? 0,
    clusterWallets: c.metrics?.clusterWallets ?? [],
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  // Time-of-day context injection
  const hour = new Date().getUTCHours();
  let timeContext = '';
  if (hour >= 4 && hour <= 6) {
    timeContext = 'WARNING: Current time is 04-06 UTC (Asia dead zone, historically 21% WR). Be extra selective.';
  } else if (hour >= 18 && hour <= 19) {
    timeContext = 'NOTE: Current time is 18-19 UTC (golden hour, historically 70% WR). Slightly more aggressive entries acceptable.';
  } else if (hour >= 10 && hour <= 11) {
    timeContext = 'NOTE: Current time is 10-11 UTC (EU morning, historically 57% WR). Good window.';
  }

  const systemParts = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only. No reasoning, no markdown, no code fences.',
    'You will receive up to 5 candidates. Pick at most one to BUY.',
    '',
    'ENTRY CRITERIA (prioritized by proven impact):',
    '1. FEE VELOCITY: feeVelocitySolPerMin > 1.0 = heavy on-chain activity, strong signal. 0.5-1.0 = decent. < 0.3 = weak interest.',
    '2. ORGANIC INTEREST: trending.organicScore > 40 + holderGrowth.rate > 2/min = genuine demand. trending.organicScore < 20 or bundlerRate > 0.4 = red flag.',
    '3. DUMP RISK: devDumpRisk > 30 or whaleExitRisk >= 2 = serious sell pressure, avoid. devDumpRisk < 10 = safe.',
    '4. WALLET BACKING: smartScore > 40 with multiple matched wallets = floor support. 0 smart wallets = no conviction signal, acceptable but riskier.',
    '5. CHART POSITION: distanceFromAthPercent < -50% = room to run. distanceFromAthPercent > -10% = near top, late entry risk.',
    '',
    'EXIT AWARENESS:',
    '- Tokens that run < 15 minutes have 67% WR. Fast exits are profitable exits.',
    '- Tokens held > 60 minutes have 20% WR. Do not BUY tokens you expect to hold for hours.',
    '- Recommended TP/SL is provided per candidate. Prefer tighter trailing over wider targets.',
    '',
    'VERDICT RULES:',
    '- BUY: reasonable asymmetric setup. Does NOT need to be perfect. Confidence 65-85 is acceptable.',
    '- WATCH: genuinely uncertain. Not a rejection — wait for better data.',
    '- PASS: clearly unsafe, empty set, or all candidates are late entries.',
    '- Do not reject solely because a lesson mentions caution — lessons are context, not hard rules.',
    '',
    'METRIC REFERENCE:',
    'savedWalletExposure.smartScore (0-100) = wallet quality: win rate, trade count, PnL. High smartScore with multiple matched wallets is strong conviction.',
    'metrics.feeVelocitySolPerMin = on-chain fee claims in 10-min window. >1 SOL/min = heavy activity. Spike from 0.2 to 2.0 = strong momentum.',
    'holderGrowth.rate = new holders per minute in 15-min window. >5/min = fast organic growth. 1-5/min = steady. 0 = stagnating.',
    'metrics.devDumpRisk (0-100) = % of top holder position sold. >30% = serious dump risk. metrics.whaleExitRisk = count of top-5 holders who sold >30%.',
    'metrics.clusterBuy = true when 3+ tracked wallets entered within 2 minutes. Strong bullish coordination signal.',
    'Volume spike alone is NOT a buy signal. If trending volume is very high but price already pumped >50% from ATH, this is a late entry risk. Look for tokens with active fee claims, organic interest, and room to run (far from ATH).',
    'You will receive a recommended_tp_sl per candidate. Use it as guidance; your suggested_tp/sl_percent override it.',
  ];
  if (timeContext) systemParts.splice(3, 0, timeContext);
  const system = systemParts.join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: (() => {
      const strat = activeStrategy();
      return rows.map(row => {
        const compact = compactCandidateForLlm(row);
        const dyn = dynamicTpSl(row.candidate, strat);
        compact.recommended_tp_sl = { tp: dyn.tp, sl: dyn.sl, trailing: dyn.trailing, trailingPercent: dyn.trailingPercent, reasons: dyn.reasoning };
        return compact;
      });
    })(),
  };

  try {
    const body = {
      model: LLM_MODEL,
      temperature: 0.2,
      max_tokens: LLM_MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    };
    // MiMo-specific: disable thinking to free token budget for JSON output
    if (/mimo/i.test(LLM_MODEL)) body.thinking = { type: 'disabled' };
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/?$/, '')}/chat/completions`, body, {
      timeout: LLM_TIMEOUT_MS,
      headers: { ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}), 'content-type': 'application/json', 'accept-encoding': 'identity' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    try {
      const parsed = strictJsonFromText(content);
      const decision = normalizeDecision(parsed);
      const selectedId = Number(parsed.selected_candidate_id);
      const selectedMint = String(parsed.selected_mint || '');
      const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);

      // Attach dynamic TP/SL for position creation fallback
      let dynamicTpSlValues = null;
      if (decision.verdict === 'BUY' && row) {
        const strat = activeStrategy();
        const dyn = dynamicTpSl(row.candidate, strat);
        dynamicTpSlValues = { tp: dyn.tp, sl: dyn.sl };
      }

      return {
        ...decision,
        dynamic_tp_sl: dynamicTpSlValues,
        selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
        selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
        selected_row: decision.verdict === 'BUY' && row ? row : null,
      };
    } catch (parseErr) {
      console.log(`[llm] JSON parse failed: ${parseErr.message}`);
      console.log(`[llm] raw response (first 500): ${content.slice(0, 500)}`);
      throw parseErr;
    }
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: null,
      suggested_sl_percent: null,
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}
