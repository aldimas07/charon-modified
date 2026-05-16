import { escapeHtml, fmtPct, fmtSol } from '../format.js';
import { formatWindow } from '../utils.js';
import { setting } from '../db/settings.js';

export function learningReportText(runId, summary, lessons) {
  const blocked = (setting('blocked_routes', '') || '').split(',').filter(Boolean);
  const routeLines = (summary.positions.byRoute || []).map(r =>
    `  ${r.route}: ${r.count} trades · ${fmtPct(r.winRate)} WR · ${fmtPct(r.avgPnlPercent)} avg`
  );
  return [
    '🧠 <b>Charon Learning</b>',
    '',
    `Run: <b>#${runId}</b> · Window: <b>${formatWindow(summary.windowMs)}</b>`,
    `Closed: ${summary.positions.closed}/${summary.positions.opened} · Win rate: ${fmtPct(summary.positions.winRate)}`,
    `Avg PnL: ${fmtPct(summary.positions.avgPnlPercent)} · Total: ${fmtSol(summary.positions.totalPnlSol)} SOL`,
    summary.positions.byRoute?.length ? `Best route: <b>${escapeHtml(summary.positions.byRoute[0].route)}</b> avg ${fmtPct(summary.positions.byRoute[0].avgPnlPercent)} (${summary.positions.byRoute[0].count})` : null,
    '',
    '<b>Route Performance</b>',
    ...routeLines,
    blocked.length ? `\n🚫 <b>Blocked routes:</b> ${blocked.map(r => escapeHtml(r)).join(', ')}` : null,
    '',
    '<b>Lessons</b>',
    ...lessons.map((item, index) => `${index + 1}. ${escapeHtml(item.lesson)}`),
  ].filter(Boolean).join('\n');
}
