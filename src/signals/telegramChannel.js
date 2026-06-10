/**
 * Telegram Channel Signal Listener (MTProto)
 * Monitors public channels for token signals via gramjs userbot.
 * 
 * Requires: TG_API_ID, TG_API_HASH, TG_SESSION_STRING in .env
 */

// Suppress gramjs orphaned Promise.reject(TIMEOUT) from internal timeout() race.
// Must be registered BEFORE importing gramjs so it's first in the listener chain.
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.message === 'TIMEOUT') return;
});

import { StringSession } from 'telegram/sessions/index.js';
import { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events/index.js';
import { parseChannelMessage, signalQualityCheck } from './telegramParser.js';
import { storeSignalEvent } from './trending.js';
import { numSetting, boolSetting, setting } from '../db/settings.js';
import { now } from '../utils.js';

let client = null;
let candidateHandler = null;
let degenHandler = null;
const seenMints = new Map(); // mint → timestamp (dedup)

export function setCandidateHandler(fn) { candidateHandler = fn; }
export function setDegenHandler(fn) { degenHandler = fn; }

/** Expose MTProto client for topic fetching */
export function getClient() { return client; }

function prune(map, ttlMs) {
  const cutoff = now() - ttlMs;
  for (const [key, ts] of map) {
    if (ts < cutoff) map.delete(key);
  }
}

/**
 * Parse channel config from settings
 * Format: "channel_username:min_mcap:max_mcap" (comma-separated for multiple)
 */
function getChannelConfig() {
  const raw = setting('tg_signal_channels', '');
  if (!raw) return [];
  return raw.split(',').map(entry => {
    const parts = entry.trim().split(':');
    return {
      username: parts[0]?.trim(),
      minMcap: parseInt(parts[1] || '0', 10),
      maxMcap: parseInt(parts[2] || '200000', 10),
    };
  }).filter(c => c.username);
}

/**
 * Handle incoming message from monitored channel
 */
async function handleMessage(event) {
  try {
    const msg = event.message;
    if (!msg?.text) return;
     // Topic filter: per-channel topic filtering from channel_topics table
     const msgTopicId = String(msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId || '');
     if (msgTopicId) {
       // Determine which channel this message is from
       const msgChannel = event.message?.chat?.username || '';
       const { db } = await import('../db/connection.js');
       const enabledTopics = db.prepare(
         'SELECT topic_id FROM channel_topics WHERE channel_username = ? AND enabled = 1'
       ).all(msgChannel);
       // If we have topic filters for this channel, enforce them
       if (enabledTopics.length > 0) {
         const allowed = new Set(enabledTopics.map(r => r.topic_id));
         if (!allowed.has(msgTopicId)) return;
       }
     }

    const text = msg.text;
    const parsed = parseChannelMessage(text);
    if (!parsed) return;

    // Dedup: skip if we've seen this mint recently (5 min)
    const dedupMs = numSetting('tg_signal_dedup_ms', 5 * 60 * 1000);
    if (seenMints.has(parsed.mint) && (now() - seenMints.get(parsed.mint)) < dedupMs) {
      return;
    }
    seenMints.set(parsed.mint, now());
    prune(seenMints, dedupMs * 2);

    // Quality check
    const quality = signalQualityCheck(parsed, {
      minMarketCapUsd: numSetting('tg_min_mcap_usd', 1000),
      maxMarketCapUsd: numSetting('tg_max_mcap_usd', 200_000),
      maxTop10Percent: numSetting('tg_max_top10_pct', 50),
      requireMintLocked: boolSetting('tg_require_mint_locked', true),
      requireFreezeLocked: boolSetting('tg_require_freeze_locked', false),
    });

    if (!quality.pass) {
      console.log(`[tg:signal] skip ${parsed.mint.slice(0, 8)}... reason=${quality.reason}`);
      return;
    }

    // Store signal event
    storeSignalEvent(parsed.mint, 'telegram_channel', 'blackhat_sol', {
      kol: parsed.kol,
      symbol: parsed.symbol,
      marketCapUsd: parsed.marketCapUsd,
      top10Percent: parsed.top10Percent,
      ageMinutes: parsed.ageMinutes,
    });

    console.log(`[tg:signal] ${parsed.symbol || parsed.mint.slice(0, 8)}... MC=$${(parsed.marketCapUsd / 1000).toFixed(1)}K KOL=${parsed.kol} Top10=${parsed.top10Percent}%`);

    // Trigger candidate pipeline
    if (candidateHandler) {
      await candidateHandler({
        mint: parsed.mint,
        route: 'telegram_channel',
        source: 'telegram_channel',
        marketCapUsd: parsed.marketCapUsd,
        // Extra metadata for enrichment
        telegramSignal: {
          kol: parsed.kol,
          symbol: parsed.symbol,
          top10Percent: parsed.top10Percent,
          ageMinutes: parsed.ageMinutes,
          mintLocked: parsed.mintLocked,
          freezeLocked: parsed.freezeLocked,
        },
      });
    }
  } catch (err) {
    console.log(`[tg:signal] handler error: ${err.message}`);
  }
}

/**
 * Fetch forum topics from a channel via MTProto
 * Returns array of { id, title, date } sorted by date desc
 */
export async function fetchChannelTopics(username) {
  if (!client) return [];
  try {
    const entity = await client.getEntity(username);
    if (!entity?.forum) return [];

    // Try channels.getForumTopics first (gramjs raw API)
    try {
      const result = await client.invoke(
        new (await import('telegram/raw/index.js')).Api.channels.GetForumTopics({
          channel: entity,
          limit: 100,
        })
      );
      if (result?.topics?.length) {
        return result.topics
          .filter(t => t.id && t.title)
          .map(t => ({
            id: String(t.id),
            title: t.title,
            date: t.date || 0,
          }))
          .sort((a, b) => b.date - a.date);
      }
    } catch (e) {
      // GetForumTopics not available, fall through to message scanning
    }

    // Fallback: scan recent messages to discover topics
    const messages = await client.getMessages(entity, { limit: 200 });
    const topicMap = new Map();
    for (const msg of messages) {
      const topicId = msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId;
      if (!topicId) continue;
      const key = String(topicId);
      if (!topicMap.has(key)) {
        topicMap.set(key, {
          id: key,
          title: 'Topic ' + key,
          sample: (msg.text || '').split('\n')[0]?.slice(0, 60) || '',
          date: msg.date || 0,
        });
      }
    }
    return [...topicMap.values()].sort((a, b) => b.date - a.date);
  } catch (err) {
    console.log(`[tg:listener] fetchChannelTopics error: ${err.message}`);
    return [];
  }
}

/**
 * Start Telegram channel listener
 */
export async function startChannelListener() {
  const apiId = parseInt(process.env.TG_API_ID || '0', 10);
  const apiHash = process.env.TG_API_HASH || '';
  const sessionString = process.env.TG_SESSION_STRING || '';

  if (!apiId || !apiHash || !sessionString) {
    console.log('[tg:listener] disabled — missing TG_API_ID/TG_API_HASH/TG_SESSION_STRING');
    return false;
  }

  const channels = getChannelConfig();
  if (channels.length === 0) {
    console.log('[tg:listener] disabled — no channels in tg_signal_channels setting');
    return false;
  }

  try {
    const stringSession = new StringSession(sessionString);
    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 3000,
    });

    // Suppress gramjs internal logging BEFORE connect (update loop starts on connect)
    client.setLogLevel('none');

    await client.connect();

    console.log(`[tg:listener] connected, monitoring ${channels.length} channel(s)`);

    // Register event handler for new messages
    client.addEventHandler(handleMessage, new NewMessage({}));

    // Join/verify channels
    for (const ch of channels) {
      try {
        const entity = await client.getEntity(ch.username);
        console.log(`[tg:listener] watching @${ch.username} (${entity.title || 'unknown'})`);
      } catch (err) {
        console.log(`[tg:listener] cannot access @${ch.username}: ${err.message}`);
      }
    }

    return true;
  } catch (err) {
    console.log(`[tg:listener] connection failed: ${err.message}`);
    return false;
  }
}

/**
 * Stop Telegram channel listener
 */
export async function stopChannelListener() {
  if (client) {
    await client.disconnect();
    client = null;
    console.log('[tg:listener] disconnected');
  }
}