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
const topicCache = new Map(); // channelUsername → { topics: [], fetchedAt: number }
const TOPIC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

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
 * Parse skip patterns from settings
 * Format: "channel:regex_pattern,channel2:regex_pattern2"
 * Returns Map<channel, RegExp>
 */
function getChannelSkipPatterns() {
  const raw = setting('tg_channel_skip_patterns', '');
  if (!raw) return new Map();
  const map = new Map();
  for (const entry of raw.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 0) continue;
    const channel = entry.slice(0, colonIdx).trim();
    const pattern = entry.slice(colonIdx + 1).trim();
    if (channel && pattern) {
      try { map.set(channel, new RegExp(pattern, 'i')); } catch {}
    }
  }
  return map;
}

/**
 * Handle incoming message from monitored channel
 */
async function handleMessage(event) {
  try {
    const msg = event.message;
    if (!msg?.text) return;
     // Channel metadata for source tracking
     const msgChannel = msg.chat?.username || '';
     const msgChannelTitle = msg.chat?.title || msgChannel || '';
     // Topic resolution: always resolve topic name regardless of filter state
     const msgTopicId = String(msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId || '');
     let matchedTopicName = null;
     if (msgTopicId) {
       const { db } = await import('../db/connection.js');
       // 1. Try to get topic name from channel_topics table (any, not just enabled)
       const existingTopic = db.prepare(
         'SELECT topic_name FROM channel_topics WHERE channel_username = ? AND topic_id = ?'
       ).get(msgChannel, msgTopicId);
       const isGenericName = !existingTopic?.topic_name || existingTopic.topic_name === `Topic ${msgTopicId}`;
       if (!isGenericName) {
         matchedTopicName = existingTopic.topic_name;
       } else if (client && msgChannel) {
         // 2. Generic/missing name — fetch from Telegram (with cache) and store
         try {
           let topics;
           const cached = topicCache.get(msgChannel);
           if (cached && (now() - cached.fetchedAt) < TOPIC_CACHE_TTL_MS) {
             topics = cached.topics;
           } else {
             topics = await fetchChannelTopics(msgChannel);
             topicCache.set(msgChannel, { topics, fetchedAt: now() });
           }
           const found = topics.find(t => t.id === msgTopicId);
           if (found?.title && found.title !== `Topic ${msgTopicId}`) {
             matchedTopicName = found.title;
             db.prepare(
               `INSERT INTO channel_topics (channel_username, topic_id, topic_name, enabled, discovered_at_ms)
                VALUES (?, ?, ?, COALESCE((SELECT enabled FROM channel_topics WHERE channel_username = ? AND topic_id = ?), 0), ?)
                ON CONFLICT(channel_username, topic_id) DO UPDATE SET topic_name = excluded.topic_name`
             ).run(msgChannel, msgTopicId, found.title, msgChannel, msgTopicId, now());
           }
         } catch (e) {
           console.log(`[tg:signal] topic resolve failed for ${msgChannel}/${msgTopicId}: ${e.message}`);
         }
       }
       // 3. Enforce topic filter: only pass messages from enabled topics if filter is active
       const enabledTopics = db.prepare(
         'SELECT topic_id FROM channel_topics WHERE channel_username = ? AND enabled = 1'
       ).all(msgChannel);
       if (enabledTopics.length > 0) {
         const allowed = new Set(enabledTopics.map(r => r.topic_id));
         if (!allowed.has(msgTopicId)) return;
       }
     }

    const text = msg.text;

    // Skip patterns: per-channel regex filter (e.g. skip DEAD/HIT messages)
    const skipPatterns = getChannelSkipPatterns();
    const skipRe = skipPatterns.get(msgChannel);
    if (skipRe && skipRe.test(text)) return;

    const parsed = parseChannelMessage(text);
    if (!parsed) return;

    // Dedup: skip if we've seen this mint recently (5 min)
    const dedupMs = numSetting('tg_signal_dedup_ms', 5 * 60 * 1000);
    if (seenMints.has(parsed.mint) && (now() - seenMints.get(parsed.mint)) < dedupMs) {
      return;
    }
    seenMints.set(parsed.mint, now());
    prune(seenMints, dedupMs * 2);

    // Pre-enrichment quality check (mint + generic confidence only)
    // Mcap/top10 checks moved to filterCandidate (post-enrichment)
    const quality = signalQualityCheck(parsed, {
      minGenericConfidence: numSetting('tg_min_generic_confidence', 2),
    });

    if (!quality.pass) {
      console.log(`[tg:signal] skip ${parsed.mint.slice(0, 8)}... reason=${quality.reason}`);
      return;
    }

    // Store signal event
    storeSignalEvent(parsed.mint, 'telegram_channel', msgChannel || 'unknown', {
      kol: parsed.kol,
      symbol: parsed.symbol,
      marketCapUsd: parsed.marketCapUsd,
      top10Percent: parsed.top10Percent,
      ageMinutes: parsed.ageMinutes,
    });

    const sourceLabel = matchedTopicName
      ? `@${msgChannel}/${matchedTopicName}`
      : `@${msgChannel}`;
    console.log(`[tg:signal] ${parsed.symbol || parsed.mint.slice(0, 8)}... MC=$${(parsed.marketCapUsd / 1000).toFixed(1)}K KOL=${parsed.kol} Source=${sourceLabel}`);

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
          channelUsername: msgChannel,
          channelTitle: msgChannelTitle,
          topicId: msgTopicId || null,
          topicName: matchedTopicName,
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
      const { Api } = await import('telegram/tl/index.js');
      const result = await client.invoke(
        new Api.channels.GetForumTopics({
          channel: entity,
          limit: 100,
        })
      );
      if (result?.topics?.length) {
        const realTopics = result.topics
          .filter(t => t.id && t.title)
          .map(t => ({
            id: String(t.id),
            title: t.title,
            date: t.date || 0,
          }))
          .sort((a, b) => b.date - a.date);
        if (realTopics.length) return realTopics;
      }
    } catch (e) {
      console.log(`[tg:listener] GetForumTopics failed: ${e.message}`);
    }

    // Fallback: scan recent messages to discover topic IDs
    const messages = await client.getMessages(entity, { limit: 200 });
    const topicMap = new Map();
    for (const msg of messages) {
      const topicId = msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId;
      if (!topicId) continue;
      const key = String(topicId);
      if (!topicMap.has(key)) {
        topicMap.set(key, {
          id: key,
          topMsgId: topicId,
          title: 'Topic ' + key, // will try to resolve below
          date: msg.date || 0,
        });
      }
    }

    // Try to resolve topic titles from their top messages (service messages)
    const topicEntries = [...topicMap.values()];
    if (topicEntries.length) {
      try {
        const topMsgIds = topicEntries.map(t => t.topMsgId);
        const topMessages = await client.getMessages(entity, { ids: topMsgIds });
        for (const topic of topicEntries) {
          const svcMsg = topMessages.find(m => m?.id === topic.topMsgId);
          if (svcMsg?.action?.title) {
            topic.title = svcMsg.action.title;
          }
        }
      } catch (e) {
        console.log(`[tg:listener] topic title resolve via service messages failed: ${e.message}`);
      }
    }

    return topicEntries.sort((a, b) => b.date - a.date);
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