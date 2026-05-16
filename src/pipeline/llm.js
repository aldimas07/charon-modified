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
  if (!ENABLE_LLM || !LLM_API_KEY) {
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

  const system = [
    'You are Charon, a Solana meme coin trench analyst in a DRY-RUN LEARNING phase.',
    'Return strict JSON only. No reasoning, no markdown, no code fences.',
    'You will receive up to 5 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'In dry-run learning, MISSING good entries is worse than small losses. Bias toward ACTION when data looks decent.',
    'Use verdict BUY when a candidate shows reasonable asymmetric setup — it does NOT need to be perfect.',
    'Use WATCH only when genuinely uncertain. Use PASS only for clearly unsafe or empty sets.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Confidence is your conviction from 0 to 100. A BUY with confidence 65-80 is acceptable in dry-run mode.',
    'Do not reject candidates solely because a lesson mentions caution — lessons are context, not hard rules.',
    'savedWalletExposure.smartScore (0-100) reflects wallet quality: win rate, trade count, PnL. High smartScore with multiple matched wallets is a strong conviction signal.',
    'metrics.feeVelocitySolPerMin is the rate of on-chain fee claims in a 10-min window. High velocity (>1 SOL/min) means heavy trading activity and strong organic interest. A spike from 0.2 to 2.0 SOL/min is a strong momentum signal.',
    'holderGrowth.rate is new holders per minute in a 15-min window. Rate >5/min = fast organic growth. Rate 1-5/min = steady. Rate 0 = stagnating.',
    'metrics.devDumpRisk (0-100) = % of top holder position sold. >30% = serious dump risk. metrics.whaleExitRisk = count of top-5 holders who sold >30% of their position. Both are bearish signals.',
    'metrics.clusterBuy = true when 3+ tracked wallets entered this token within 2 minutes. clusterSize and clusterWallets show details. This is a strong bullish coordination signal.',
    'You will receive a recommended_tp_sl per candidate based on its profile. Use it as guidance but you may adjust based on your analysis. Your suggested_tp_percent and suggested_sl_percent override the recommendation.',
  ].join(' ');
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
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/?$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      max_tokens: LLM_MAX_TOKENS,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
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
