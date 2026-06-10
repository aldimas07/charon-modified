import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now } from '../utils.js';
import { numSetting, boolSetting, setSetting, setActiveStrategy, activeStrategy, updateStrategyConfig } from '../db/settings.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  candidateButtons,
  sendTpSlDefaults,
  strategyMenuText,
  strategyKeyboard,
  sourcesText,
  sourcesKeyboard,
  topicListText,
  topicListKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen, sendTradeIntent } from './send.js';
import { candidateSummary } from './format.js';
import { candidateById, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import { createDryRunPosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { executeLiveBuy, executeConfirmedIntent, rejectIntent } from '../execution/router.js';
import { sendCandidate, sendPosition, closePosition, updatePositionRule, toggleTrailing } from './commands.js';
import { requestNumericFilterInput, requestStrategyNumericInput } from './input.js';
import { handleHistoryCallback } from './history.js';

export async function handleCallback(query) {
  const data = query.data || '';
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  await answerCallback(query);
  if (!data.startsWith('input:') && !data.startsWith('stratinput:')) {
    const { pendingNumericInputs } = await import('./input.js');
    pendingNumericInputs.delete(String(chatId));
  }

  if (data === 'menu:main') return editMenuMessage(query, mainMenuText(), menuKeyboard());
  if (data === 'noop') return null;
  if (data.startsWith('hist:')) return handleHistoryCallback(query);
  if (data === 'menu:agent') {
    return editMenuMessage(query, agentText(), agentKeyboard());
  }
  if (data === 'toggle:agent') {
    setSetting('agent_enabled', boolSetting('agent_enabled', true) ? 'false' : 'true');
    return editMenuMessage(query, agentText(), agentKeyboard());
  }
  if (data === 'toggle:trending_enabled' || data === 'toggle:trending_allow_degen') {
    const key = data.replace('toggle:', '');
    setSetting(key, boolSetting(key, key === 'trending_enabled') ? 'false' : 'true');
    return editMenuMessage(query, filtersText(), filtersKeyboard());
    }
    if (data === 'toggle:signal_server_enabled') {
     const current = boolSetting('signal_server_enabled', true);
     setSetting('signal_server_enabled', current ? 'false' : 'true');
     return editMenuMessage(query, sourcesText(), sourcesKeyboard());
    }
  if (data === 'menu:filters') return editMenuMessage(query, filtersText(), filtersKeyboard());
  if (data === 'menu:strategy') return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  if (data === 'menu:wallets') return editMenuMessage(query, walletsText(), navKeyboard());
  if (data === 'menu:positions') return editMenuMessage(query, positionsText(), navKeyboard());
  if (data === 'menu:pnl') {
    const { sendPnl } = await import('./commands.js');
    return sendPnl(chatId, query);
  }
  if (data === 'menu:settings') return editMenuMessage(query, `${agentText()}\n\n${filtersText()}`, navKeyboard([
    [
      { text: 'Agent', callback_data: 'menu:agent' },
      { text: 'Filters', callback_data: 'menu:filters' },
    ],
  ]));

  // Sources menu
  if (data === 'menu:sources') return editMenuMessage(query, sourcesText(), sourcesKeyboard());
  if (data.startsWith('toggle:tg_require_mint_locked') || data.startsWith('toggle:tg_require_freeze_locked')) {
    const key = data.replace('toggle:', '');
    setSetting(key, boolSetting(key, key === 'tg_require_mint_locked') ? 'false' : 'true');
    return editMenuMessage(query, sourcesText(), sourcesKeyboard());
  }
  if (data.startsWith('source:rm_channel:')) {
    const ch = data.replace('source:rm_channel:', '');
    const current = setting('tg_signal_channels', '');
    const updated = current.split(',').map(c => c.trim().split(':')[0]).filter(c => c && c !== ch).join(',');
    setSetting('tg_signal_channels', updated);
    return editMenuMessage(query, sourcesText(), sourcesKeyboard());
  }
  if (data === 'source:add_channel') {
    const { pendingNumericInputs } = await import('./input.js');
    pendingNumericInputs.set(String(chatId), { type: 'tg_channel_add', key: 'tg_channel_add' });
    return bot.sendMessage(chatId, 'Send the Telegram channel username (e.g. @channel_name or channel_name):');
  }
  // Topic management callbacks
  if (data.startsWith('topic:list:')) {
    const channel = data.replace('topic:list:', '');
    const { db } = await import('../db/connection.js');
    const topics = db.prepare(
      'SELECT topic_id, topic_name, sample_text, enabled FROM channel_topics WHERE channel_username = ? ORDER BY discovered_at_ms DESC'
    ).all(channel);
    return editMenuMessage(query, topicListText(channel, topics), topicListKeyboard(channel, topics));
  }
  if (data.startsWith('topic:toggle:')) {
    const parts = data.replace('topic:toggle:', '').split(':');
    const channel = parts[0];
    const topicId = parts.slice(1).join(':');
    const { db } = await import('../db/connection.js');
    const current = db.prepare('SELECT enabled FROM channel_topics WHERE channel_username = ? AND topic_id = ?').get(channel, topicId);
    if (current) {
      db.prepare('UPDATE channel_topics SET enabled = ? WHERE channel_username = ? AND topic_id = ?').run(current.enabled ? 0 : 1, channel, topicId);
    }
    const topics = db.prepare(
      'SELECT topic_id, topic_name, sample_text, enabled FROM channel_topics WHERE channel_username = ? ORDER BY discovered_at_ms DESC'
    ).all(channel);
    return editMenuMessage(query, topicListText(channel, topics), topicListKeyboard(channel, topics));
  }
  if (data.startsWith('topic:refresh:')) {
    const channel = data.replace('topic:refresh:', '');
    const { fetchChannelTopics, getClient } = await import('../signals/telegramChannel.js');
    if (!getClient()) {
      return bot.sendMessage(chatId, 'MTProto client not connected. Restart Charon first.');
    }
    await bot.sendMessage(chatId, 'Scanning topics...');
    const topics = await fetchChannelTopics(channel);
    if (!topics.length) {
      return bot.sendMessage(chatId, 'No forum topics found. Channel may not be a forum group.');
    }
    const { db } = await import('../db/connection.js');
    const ts = Date.now();
    const upsert = db.prepare(
      'INSERT INTO channel_topics (channel_username, topic_id, topic_name, enabled, discovered_at_ms) VALUES (?, ?, ?, COALESCE((SELECT enabled FROM channel_topics WHERE channel_username = ? AND topic_id = ?), 1), ?) ON CONFLICT(channel_username, topic_id) DO UPDATE SET topic_name = excluded.topic_name, discovered_at_ms = excluded.discovered_at_ms'
    );
    for (const t of topics) {
      upsert.run(channel, t.id, t.title, channel, t.id, ts);
    }
    const allTopics = db.prepare(
      'SELECT topic_id, topic_name, sample_text, enabled FROM channel_topics WHERE channel_username = ? ORDER BY discovered_at_ms DESC'
    ).all(channel);
    return editMenuMessage(query, topicListText(channel, allTopics), topicListKeyboard(channel, allTopics));
  }
  if (data.startsWith('topic:add:')) {
    const channel = data.replace('topic:add:', '');
    const { pendingNumericInputs } = await import('./input.js');
    pendingNumericInputs.set(String(chatId), { type: 'tg_topic_add', channel, at: Date.now() });
    return bot.sendMessage(chatId, 'Send the topic ID (numeric) to add.\n\nTo find topic IDs: forward a message from the topic to @JsonDumpBot or check the message link (t.me/c/xxx/TOPIC_ID).');
  }

  if (data.startsWith('cycle:')) {
    const [, key, valuesStr] = data.split(':');
    const values = valuesStr.split(',');
    const current = setting(key, values[0]);
    const idx = values.indexOf(current);
    const next = values[(idx + 1) % values.length];
    setSetting(key, next);
    return editMenuMessage(query, sourcesText(), sourcesKeyboard());
  }

  if (data.startsWith('strategy:select:')) {
    const strategyId = data.replace('strategy:select:', '');
    setActiveStrategy(strategyId);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }
  if (data.startsWith('stratcfg:')) {
    const key = data.replace('stratcfg:', '');
    return handleStratConfig(query, chatId, key);
  }
  if (data.startsWith('stratinput:')) {
    const key = data.replace('stratinput:', '');
    return requestStrategyNumericInput(query, key);
  }

  const [kind, id, value] = data.split(':');
  if (kind === 'input') return requestNumericFilterInput(query, id);
  if (kind === 'set') return updateSettingFromButton(query, id, value);
  if (kind === 'batch') return sendBatch(chatId, Number(id));
  if (kind === 'intent') {
    if (value === 'confirm') return executeConfirmedIntent(chatId, Number(id));
    if (value === 'reject') return rejectIntent(chatId, Number(id));
  }
  if (kind === 'cand') return sendCandidate(chatId, Number(id));
  if (kind === 'ign') {
    updateCandidateStatus(Number(id), 'ignored');
    return bot.sendMessage(chatId, 'Ignored candidate.');
  }
  if (kind === 'buy') {
    const row = candidateById(Number(id));
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    if (!canOpenMorePositions()) {
      return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}). Close one first or raise the limit.`);
    }
    const candidate = row.candidate;
    const decision = { verdict: 'BUY', confidence: 100, reason: 'Manual dry buy', risks: [], suggested_tp_percent: numSetting('default_tp_percent', 50), suggested_sl_percent: numSetting('default_sl_percent', -25) };
    const decisionId = storeDecision(row.id, candidate, decision);
    decision.id = decisionId;
    if (tradingMode() === 'live') {
      await executeLiveBuy(row, decision, 'manual', [row], row.id);
      return;
    }
    const positionId = await createDryRunPosition(row.id, candidate, decision, 'manual_buy');
    logDecisionEvent({
      batchId: 'manual',
      triggerCandidateId: row.id,
      selectedRow: row,
      rows: [row],
      decision,
      mode: tradingMode(),
      action: 'manual_dry_run_entry',
      execution: { positionId },
    });
    return sendPositionOpen(positionId);
  }
  if (kind === 'tpsl') return sendTpSlDefaults(chatId, query);
  if (kind === 'pos') return sendPosition(chatId, Number(id), query);
  if (kind === 'sell') return closePosition(chatId, Number(id), 'MANUAL');
  if (kind === 'tp') return updatePositionRule(chatId, Number(id), 'tp_percent', Number(value), query);
  if (kind === 'sl') return updatePositionRule(chatId, Number(id), 'sl_percent', Number(value), query);
  if (kind === 'trail') return toggleTrailing(chatId, Number(id), query);
  return null;
}

async function answerCallback(query, text = '') {
  await bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});
}

export async function editMenuMessage(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  if (!messageId) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}

const STRAT_PRESETS = {
  tp_percent: [25, 50, 75, 100, 150, 200],
  sl_percent: [-10, -15, -20, -25, -30, -40],
  position_size_sol: [0.02, 0.05, 0.1, 0.2, 0.5],
  max_open_positions: [1, 2, 3, 5, 10],
  min_mcap_usd: [0, 5000, 10000, 25000, 50000, 100000],
  max_mcap_usd: [0, 50000, 100000, 200000, 500000, 1000000],
  trailing_percent: [10, 15, 20, 25, 30],
  min_source_count: [1, 2, 3, 4],
  min_holders: [0, 100, 500, 1000, 2000, 5000],
  llm_min_confidence: [0, 30, 50, 60, 70, 80, 90],
  partial_tp_at_percent: [25, 50, 75, 100, 150, 200],
  partial_tp_sell_percent: [25, 33, 50, 75],
  max_hold_ms: [0, 1800000, 3600000, 7200000, 14400000, 28800000, 86400000],
  min_fee_claim_sol: [0, 0.5, 1, 2, 5, 10],
  min_gmgn_total_fee_sol: [0, 3, 5, 10, 20],
  max_ath_distance_pct: [0, -20, -30, -40, -50, -60],
  min_smart_wallet_score: [0, 20, 30, 40, 50, 60, 70],
  min_fee_velocity_sol_per_min: [0, 0.1, 0.3, 0.5, 1.0, 2.0],
  min_holder_growth_rate: [0, 1, 2, 3, 5, 10],
  max_dev_dump_risk_pct: [0, 15, 20, 30, 40, 50],
  max_whale_exit_count: [0, 1, 2, 3],
  token_age_max_ms: [0, 1800000, 3600000, 7200000, 14400000, 43200000, 86400000],
};

function formatStratValue(key, value) {
  if (key === 'max_hold_ms' || key === 'token_age_max_ms') {
    return value > 0 ? `${Math.round(value / 60000)}m` : 'off';
  }
  if (key.includes('percent') || key.includes('pct')) return `${value}%`;
  if (key.includes('sol')) return `${value} SOL`;
  if (key.includes('usd')) return value > 0 ? `$${value.toLocaleString()}` : 'off';
  return String(value);
}

async function handleStratConfig(query, chatId, key) {
  const strat = activeStrategy();
  const newConfig = { ...strat };
  delete newConfig.id;
  delete newConfig.name;

  // Boolean toggles
  const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim']);
  if (boolKeys.has(key)) {
    newConfig[key] = !strat[key];
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }

  // Cycle through presets
  const presets = STRAT_PRESETS[key];
  if (presets) {
    const current = Number(strat[key] ?? 0);
    const idx = presets.indexOf(current);
    const next = idx >= 0 ? presets[(idx + 1) % presets.length] : presets[0];
    newConfig[key] = next;
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }

  // Fallback: show current value
  return bot.sendMessage(chatId, `Current ${key}: ${formatStratValue(key, strat[key])}\nUse /stratset ${strat.id} ${key} <value> to change.`);
}

async function updateSettingFromButton(query, key, value) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const valid = new Set([
    'min_fee_claim_sol',
    'min_mcap_usd',
    'max_mcap_usd',
    'min_gmgn_total_fee_sol',
    'min_graduated_volume_usd',
    'max_top20_holder_percent',
    'min_saved_wallet_holders',
    'trending_enabled',
    'trending_source',
    'trending_allow_degen',
    'trending_interval',
    'trending_limit',
    'trending_order_by',
    'trending_min_volume_usd',
    'trending_min_swaps',
    'trending_max_rug_ratio',
    'trending_max_bundler_rate',
    'trading_mode',
    'llm_min_confidence',
    'llm_candidate_pick_count',
    'llm_candidate_max_age_ms',
    'max_open_positions',
    'dry_run_buy_sol',
    'default_tp_percent',
    'default_sl_percent',
    'default_trailing_enabled',
    'default_trailing_percent',
    'min_smart_wallet_score',
    'min_fee_velocity_sol_per_min',
    'min_holder_growth_rate',
    'max_dev_dump_risk_pct',
    'max_whale_exit_count',
  ]);
  if (!valid.has(key) || value == null) return bot.sendMessage(chatId, 'Unknown setting.');
  setSetting(key, value);
  const text = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentText()
    : filtersText();
  const extra = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentKeyboard()
    : filtersKeyboard();
  return editMenuMessage(query, text, extra);
}