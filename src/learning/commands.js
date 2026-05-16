import { bot } from '../telegram/bot.js';
import { now, formatWindow, parseWindowMs } from '../utils.js';
import { escapeHtml } from '../format.js';
import { setting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { summarizeLearningWindow } from './summary.js';
import { generateLessons, storeLearningRun } from './lessons.js';
import { learningReportText } from './report.js';

export async function runLearning(chatId, windowArg = '12h') {
  const windowMs = parseWindowMs(windowArg);
  await bot.sendMessage(chatId, `Learning from the last ${formatWindow(windowMs)}...`);
  const summary = summarizeLearningWindow(windowMs);
  const { lessons, raw } = await generateLessons(summary);
  const runId = storeLearningRun(windowMs, summary, lessons, raw);
  return bot.sendMessage(chatId, learningReportText(runId, summary, lessons), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export async function sendLessons(chatId) {
  const rows = db.prepare(`
    SELECT id, created_at_ms, lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT 10
  `).all();
  const blocked = (setting('blocked_routes', '') || '').split(',').filter(Boolean);
  const parts = [];
  if (blocked.length) {
    parts.push(`🚫 <b>Blocked routes:</b> ${blocked.map(r => escapeHtml(r)).join(', ')}`);
    parts.push('');
  }
  if (rows.length) {
    parts.push(...rows.map((row, index) => `${index + 1}. ${escapeHtml(row.lesson)}`));
  } else {
    parts.push('No active lessons yet. Run /learn 12h after some dry-run exits.');
  }
  return bot.sendMessage(chatId, `🧠 <b>Active Lessons</b>\n\n${parts.join('\n')}`, { parse_mode: 'HTML' });
}
