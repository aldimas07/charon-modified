import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, parseNumericInput } from '../utils.js';
import { activeStrategy, setSetting, setting, updateStrategyConfig } from '../db/settings.js';
import {
  filtersText,
  filtersKeyboard,
  numericFilterLabels,
  navKeyboard,
  strategyKeyboard,
  strategyMenuText,
  strategyNumericLabels,
  sourcesText,
  sourcesKeyboard,
} from './menus.js';

export const pendingNumericInputs = new Map();

export async function requestNumericFilterInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!numericFilterLabels[key]) return bot.sendMessage(chatId, 'Unknown numeric filter.');
  pendingNumericInputs.set(String(chatId), {
    type: 'setting',
    key,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${numericFilterLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:filters' }]]),
  );
}

export async function requestStrategyNumericInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!strategyNumericLabels[key]) return bot.sendMessage(chatId, 'Unknown strategy setting.');
  const strat = activeStrategy();
  pendingNumericInputs.set(String(chatId), {
    type: 'strategy',
    key,
    strategyId: strat.id,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${strat.name} ${strategyNumericLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, -40, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:strategy' }]]),
  );
}

export async function consumeNumericFilterInput(chatId, text, userMessageId = null) {
  const pending = pendingNumericInputs.get(String(chatId));
  if (!pending) return false;
  if (pending.type === 'tg_channel_add') {
    pendingNumericInputs.delete(String(chatId));
    const clean = text.trim().replace('@', '').replace('https://t.me/', '');
    const current = setting('tg_signal_channels', '');
    const channels = current ? current.split(',').map(c => c.trim().split(':')[0]) : [];
    if (channels.includes(clean)) {
      await bot.sendMessage(chatId, `@${clean} already in channel list.`);
      return true;
    }
    const updated = current ? `${current},${clean}` : clean;
    setSetting('tg_signal_channels', updated);
    await bot.sendMessage(chatId, `Added @${clean}.\n\n${sourcesText()}`, { parse_mode: 'HTML', ...sourcesKeyboard() });
    return true;
  }

  if (pending.type === 'tg_topic_add') {
    pendingNumericInputs.delete(String(chatId));
    const topicId = text.trim().replace(/[^0-9]/g, '');
    if (!topicId) {
      await bot.sendMessage(chatId, 'Invalid topic ID. Must be a numeric ID.');
      return true;
    }
    const channel = pending.channel;
    const { db } = await import('../db/connection.js');
    const existing = db.prepare('SELECT 1 FROM channel_topics WHERE channel_username = ? AND topic_id = ?').get(channel, topicId);
    if (existing) {
      await bot.sendMessage(chatId, 'Topic ' + topicId + ' already exists for @' + channel + '.');
      return true;
    }
    db.prepare(
      'INSERT INTO channel_topics (channel_username, topic_id, topic_name, enabled, discovered_at_ms) VALUES (?, ?, ?, 1, ?)'
    ).run(channel, topicId, 'Topic ' + topicId, Date.now());
    const topics = db.prepare(
      'SELECT topic_id, topic_name, sample_text, enabled FROM channel_topics WHERE channel_username = ? ORDER BY discovered_at_ms DESC'
    ).all(channel);
    const { topicListText, topicListKeyboard } = await import('./menus.js');
    await bot.sendMessage(chatId, topicListText(channel, topics), { parse_mode: 'HTML', ...topicListKeyboard(channel, topics) });
    return true;
  }
  if (now() - pending.at > 5 * 60 * 1000) {
    pendingNumericInputs.delete(String(chatId));
    await bot.sendMessage(chatId, 'That input expired. Tap the filter input button again.');
    return true;
  }
  const value = parseNumericInput(text);
  if (value == null) {
    await bot.sendMessage(chatId, 'Invalid number. Try 5, 50000, 100k, 1.5m, or off.');
    return true;
  }
  pendingNumericInputs.delete(String(chatId));
  if (userMessageId) bot.deleteMessage(chatId, userMessageId).catch(() => {});
  if (pending.type === 'strategy') {
    const strat = activeStrategy();
    if (strat.id !== pending.strategyId) {
      await bot.sendMessage(chatId, 'Strategy changed while input was pending. Open Strategy menu and try again.');
      return true;
    }
    const newConfig = { ...strat, [pending.key]: value };
    delete newConfig.id;
    delete newConfig.name;
    updateStrategyConfig(strat.id, newConfig);
    if (pending.messageId) {
      await bot.editMessageText(strategyMenuText(), {
        chat_id: chatId,
        message_id: pending.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...strategyKeyboard(),
      }).catch(() => bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() }));
    } else {
      await bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
  } else {
    setSetting(pending.key, String(value));
    if (pending.messageId) {
      await bot.editMessageText(filtersText(), {
        chat_id: chatId,
        message_id: pending.messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...filtersKeyboard(),
      }).catch(() => bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() }));
    } else {
      await bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() });
    }
  }
  return true;
}

async function editMenuMessage(query, text, extra = {}) {
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