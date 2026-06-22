const db = require('../infrastructure/db/connection');
const { getSettings } = require('./settings');
const { localNow, localToUtc } = require('../shared/helpers');
const taskRepo = require('../infrastructure/db/repositories/taskRepository');
const syncErrorRepo = require('../infrastructure/db/repositories/syncErrorRepository');

function logNotification(userId, type, taskId = null) {
  db.prepare('INSERT INTO notification_log (user_id, type, task_id) VALUES (?, ?, ?)')
    .run(userId, type, taskId);
}

function markReacted(userId, type) {
  db.prepare(`
    UPDATE notification_log SET reacted = 1
    WHERE user_id = ? AND type = ? AND reacted = 0
    ORDER BY sent_at DESC LIMIT 1
  `).run(userId, type);
}

function wasNotifiedToday(userId, type) {
  const { timezone } = getSettings(userId);
  const today = localNow(timezone);
  const startUtc = localToUtc(`${today} 00:00`, timezone);
  const endUtc   = localToUtc(`${today} 23:59`, timezone);
  return !!db.prepare(`
    SELECT 1 FROM notification_log
    WHERE user_id = ? AND type = ? AND sent_at >= ? AND sent_at <= ?
    LIMIT 1
  `).get(userId, type, startUtc, endUtc);
}

function getDueReminders() {
  return taskRepo.getDueReminders();
}

// Проверяет, отправлялось ли daily_reminder в текущий слот (последние 59 минут).
// Слоты всегда расстоянием ≥ 60 мин, поэтому 59-минутное окно гарантирует одну отправку.
function wasNotifiedInSlot(userId) {
  return !!db.prepare(`
    SELECT 1 FROM notification_log
    WHERE user_id = ? AND type = 'daily_reminder'
      AND sent_at >= datetime('now', '-59 minutes')
    LIMIT 1
  `).get(userId);
}

// Возвращает Set task_id, перенесённых сегодня из просрочки.
function getOverdueMovedToday(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT task_id FROM notification_log
    WHERE user_id = ? AND type = 'overdue_moved' AND date(sent_at) = ?
  `).all(userId, today);
  return new Set(rows.map(r => r.task_id));
}

function getRecurringDueNow(currentHHMM, currentDay, currentDayOfMonth) {
  return taskRepo.getRecurringDueNow(currentHHMM, currentDay, currentDayOfMonth);
}

module.exports = {
  logNotification,
  markReacted,
  wasNotifiedToday,
  getDueReminders,
  getRecurringDueNow,
  wasNotifiedInSlot,
  getOverdueMovedToday,
  logSyncError: syncErrorRepo.logSyncError,
  getSyncErrors: syncErrorRepo.getSyncErrors,
  clearSyncErrors: syncErrorRepo.clearSyncErrors,
};
