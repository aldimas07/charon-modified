import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { bot } from './bot.js';
import { editMenuMessage } from './callbacks.js';

const BUCKETS = { '6h': 6, '12h': 12, '1d': 24 };
const PER_PAGE = 8;
const STRATS = ['all', 'sniper', 'dip_buy', 'smart_money', 'degen'];

function wibDate(ts) {
  return new Date(Number(ts) + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function bucketKey(ts, hours) {
  const d = new Date(Number(ts) + 7 * 3600 * 1000);
  if (hours === 24) return d.toISOString().slice(0, 10);
  if (hours === 12) {
    const h = d.getUTCHours();
    return d.toISOString().slice(0, 10) + (h < 12 ? ' AM' : ' PM');
  }
  const h = Math.floor(d.getUTCHours() / 6) * 6;
  return d.toISOString().slice(0, 10) + ` ${String(h).padStart(2, '0')}:00`;
}

function pnlEmoji(pnl) {
  if (pnl > 20) return '🟢';
  if (pnl > 0) return '🔵';
  if (pnl > -10) return '⚪';
  if (pnl > -25) return '🟡';
  return '🔴';
}

function exitEmoji(reason) {
  if (!reason) return '⏳';
  if (reason === 'TP') return '🎯';
  if (reason === 'SL') return '🛑';
  if (reason === 'TRAILING') return '📉';
  if (reason === 'MANUAL') return '✋';
  if (reason === 'HOLD_TIMEOUT') return '⏰';
  return '❓';
}

function pnlSign(v) { return v >= 0 ? '+' : ''; }

// ── Bucket summary ──

function buildSummary(bucketHours) {
  const rows = db.prepare(`
    SELECT opened_at_ms, pnl_percent, pnl_sol
    FROM dry_run_positions WHERE status = 'closed'
    ORDER BY opened_at_ms ASC
  `).all();

  if (!rows.length) return '📊 Belum ada trades.';

  const groups = {};
  for (const r of rows) {
    const key = bucketKey(r.opened_at_ms, bucketHours);
    if (!groups[key]) groups[key] = { trades: 0, wins: 0, totalPnl: 0, totalSol: 0 };
    groups[key].trades++;
    if (Number(r.pnl_percent) > 0) groups[key].wins++;
    groups[key].totalPnl += Number(r.pnl_percent || 0);
    groups[key].totalSol += Number(r.pnl_sol || 0);
  }

  const bucketLines = Object.entries(groups).reverse().slice(0, 12).map(([key, d]) => {
    const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) : '0';
    const avgPnl = d.trades > 0 ? (d.totalPnl / d.trades).toFixed(1) : '0';
    const em = d.totalSol > 0 ? '🟢' : d.totalSol < -0.01 ? '🔴' : '⚪';
    return `${em} ${key}  ${d.trades}t · ${d.wins}/${d.trades}w (${wr}%) · ${pnlSign(d.totalPnl)}${avgPnl}% · ${pnlSign(d.totalSol)}${d.totalSol.toFixed(4)}`;
  });

  const totalTrades = rows.length;
  const totalWins = rows.filter(r => Number(r.pnl_percent) > 0).length;
  const totalSol = rows.reduce((s, r) => s + Number(r.pnl_sol || 0), 0);
  const totalPnl = rows.reduce((s, r) => s + Number(r.pnl_percent || 0), 0);
  const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0';

  const label = bucketHours === 6 ? '6h' : bucketHours === 12 ? '12h' : '1d';

  return [
    `📊 <b>History</b> · ${label}`,
    '',
    ...bucketLines,
    '',
    `<b>Total ${totalTrades}t</b> · ${totalWins}w (${wr}%) · ${pnlSign(totalSol)}${totalSol.toFixed(4)} SOL`,
  ].join('\n');
}

// ── Trade cards (compact) ──

function fetchTrades(strategy, limit = 500) {
  if (strategy === 'all') {
    return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
  }
  return db.prepare('SELECT * FROM dry_run_positions WHERE strategy_id = ? ORDER BY id DESC LIMIT ?').all(strategy, limit);
}

function tradeCard(r) {
  const pnl = Number(r.pnl_percent || 0);
  const pnlSol = Number(r.pnl_sol || 0);
  const em = pnlEmoji(pnl);
  const ex = exitEmoji(r.exit_reason);
  const name = escapeHtml(r.symbol || short(r.mint));
  const entryMcap = fmtUsd(r.entry_mcap);
  const highMcap = r.high_water_mcap ? fmtUsd(r.high_water_mcap) : '-';
  const strat = r.strategy_id || 'sniper';
  const time = wibDate(r.opened_at_ms).slice(5, 16);

  return [
    `${em} <b>#${r.id}</b> ${name}  ${pnlSign(pnl)}${pnl.toFixed(1)}% (${pnlSign(pnlSol)}${pnlSol.toFixed(4)} SOL)`,
    `   ${fmtSol(r.size_sol)} SOL · ${entryMcap} → high ${highMcap} · ${strat} ${ex} · ${time}`,
  ].join('\n');
}

function tradeCardFull(r) {
  const pnl = Number(r.pnl_percent || 0);
  const pnlSol = Number(r.pnl_sol || 0);
  const em = pnlEmoji(pnl);
  const ex = exitEmoji(r.exit_reason);
  const name = escapeHtml(r.symbol || short(r.mint));
  const entryMcap = fmtUsd(r.entry_mcap);
  const exitMcap = r.exit_mcap ? fmtUsd(r.exit_mcap) : '-';
  const highMcap = r.high_water_mcap ? fmtUsd(r.high_water_mcap) : '-';
  const strat = r.strategy_id || 'sniper';
  const time = wibDate(r.opened_at_ms).slice(5, 16);

  return [
    `${em} <b>#${r.id}</b>  <a href="${gmgnLink(r.mint)}">${name}</a>  ${strat}  ${ex}${r.exit_reason || 'open'}`,
    `   PnL ${pnlSign(pnl)}${pnl.toFixed(1)}% (${pnlSign(pnlSol)}${pnlSol.toFixed(4)} SOL) · ${fmtSol(r.size_sol)} SOL`,
    `   Entry ${entryMcap} · Exit ${exitMcap} · High ${highMcap}`,
    `   ${time}`,
  ].join('\n');
}

// ── Build page ──

function buildPage(bucket, strategy, page, view) {
  const hours = BUCKETS[bucket] || 12;
  const summary = buildSummary(hours);

  const allTrades = fetchTrades(strategy);
  const totalPages = Math.max(1, Math.ceil(allTrades.length / PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = allTrades.slice(safePage * PER_PAGE, (safePage + 1) * PER_PAGE);

  const cardFn = view === 'full' ? tradeCardFull : tradeCard;
  const tradeLines = slice.map(cardFn).join('\n\n');

  const stratLabel = strategy === 'all' ? '' : ` · ${strategy}`;
  const pageInfo = `${safePage + 1}/${totalPages}`;
  const header = `${summary}\n\n📋 <b>Trades${stratLabel}</b> · ${pageInfo}\n`;

  const text = header + '\n' + tradeLines;

  const keyboard = buildKeyboard(bucket, strategy, safePage, totalPages, view);

  return { text, keyboard };
}

// ── Inline keyboard ──

function buildKeyboard(bucket, strategy, page, totalPages, view) {
  const s = STRATS.indexOf(strategy);
  const btn = (label, cur) => label === cur ? `·${label}·` : label;

  return {
    inline_keyboard: [
      // Row 1: pagination
      [
        { text: '◀️', callback_data: page > 0 ? `hist:${bucket}:${page - 1}:${view}:${strategy}` : 'noop' },
        { text: `${page + 1}/${totalPages}`, callback_data: 'noop' },
        { text: '▶️', callback_data: page < totalPages - 1 ? `hist:${bucket}:${page + 1}:${view}:${strategy}` : 'noop' },
      ],
      // Row 2: bucket switch
      [
        { text: btn('6h', bucket), callback_data: `hist:6h:0:${view}:${strategy}` },
        { text: btn('12h', bucket), callback_data: `hist:12h:0:${view}:${strategy}` },
        { text: btn('1d', bucket), callback_data: `hist:1d:0:${view}:${strategy}` },
      ],
      // Row 3: view + strategy
      [
        { text: view === 'compact' ? '·compact·' : 'compact', callback_data: `hist:${bucket}:0:compact:${strategy}` },
        { text: view === 'full' ? '·full·' : 'full', callback_data: `hist:${bucket}:0:full:${strategy}` },
      ],
      // Row 4: strategy filter
      ...buildStratRow(bucket, strategy, view),
    ],
  };
}

function buildStratRow(bucket, strategy, view) {
  const rows = [];
  // Split into rows of max 3 buttons (Telegram limit)
  for (let i = 0; i < STRATS.length; i += 3) {
    const chunk = STRATS.slice(i, i + 3);
    rows.push(chunk.map(s => ({
      text: s === strategy ? `·${s}·` : s,
      callback_data: `hist:${bucket}:0:${view}:${s}`,
    })));
  }
  return rows;
}

// ── Public API ──

export function sendHistory(chatId, args) {
  const parts = (args || '').split(/\s+/).filter(Boolean);
  let bucket = '12h';
  let strategy = 'all';

  for (const t of parts) {
    if (BUCKETS[t]) bucket = t;
    else if (STRATS.includes(t)) strategy = t;
  }

  const { text, keyboard } = buildPage(bucket, strategy, 0, 'compact');
  return { text, keyboard };
}

export async function handleHistoryCallback(query) {
  const data = query.data || '';
  if (!data.startsWith('hist:')) return false;

  const [, bucket, pageStr, view, strategy] = data.split(':');
  const page = Number(pageStr) || 0;

  const { text, keyboard } = buildPage(bucket, strategy, page, view);
  await editMenuMessage(query, text, { reply_markup: keyboard });
  return true;
}
