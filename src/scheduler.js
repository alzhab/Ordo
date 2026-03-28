const cron = require('node-cron');
const db = require('./db');
const { wasNotifiedToday, isQuietMode } = require('./assistantService');
const { handleMorning, handleReview } = require('./handlers/assistant');

// Получить всех активных пользователей с их настройками
function getActiveUsers() {
  // Пользователь активен если писал боту последние 7 дней
  return db.prepare(`
    SELECT u.id, COALESCE(s.morning_time, '09:00') AS morning_time,
           COALESCE(s.evening_time, '21:00') AS evening_time,
           COALESCE(s.morning_enabled, 1) AS morning_enabled,
           COALESCE(s.review_enabled, 1) AS review_enabled,
           s.quiet_until
    FROM users u
    LEFT JOIN user_settings s ON s.user_id = u.id
    WHERE EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.user_id = u.id
      AND t.updated_at >= datetime('now', '-7 days')
    )
  `).all();
}

// Текущее время в формате HH:MM (UTC+5 Almaty по умолчанию, или через timezone)
function getCurrentHHMM(timezone) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Almaty',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const h = parts.find(p => p.type === 'hour').value.padStart(2, '0');
    const m = parts.find(p => p.type === 'minute').value.padStart(2, '0');
    return `${h}:${m}`;
  } catch {
    // Fallback: UTC+5
    const now = new Date(Date.now() + 5 * 3600000);
    const h = String(now.getUTCHours()).padStart(2, '0');
    const m = String(now.getUTCMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
}

function makeFakeCtx(bot, userId) {
  return {
    from: { id: userId },
    reply: (text, extra) => bot.telegram.sendMessage(userId, text, extra),
    sendChatAction: () => bot.telegram.sendChatAction(userId, 'typing'),
    answerCbQuery: () => {},
  };
}

function start(bot) {
  // Каждую минуту проверяем всех пользователей
  const task = cron.schedule('* * * * *', async () => {
    let users;
    try {
      users = getActiveUsers();
    } catch (e) {
      console.error('[scheduler] getActiveUsers error:', e.message);
      return;
    }

    for (const user of users) {
      try {
        const currentTime = getCurrentHHMM(user.timezone);

        // Тихий режим
        if (user.quiet_until && new Date(user.quiet_until) > new Date()) continue;

        // Утренний план
        if (
          user.morning_enabled &&
          currentTime === user.morning_time &&
          !wasNotifiedToday(user.id, 'morning')
        ) {
          console.log(`[scheduler] morning → user ${user.id}`);
          const ctx = makeFakeCtx(bot, user.id);
          await handleMorning(ctx);
        }

        // Вечерний разбор
        if (
          user.review_enabled &&
          currentTime === user.evening_time &&
          !wasNotifiedToday(user.id, 'review')
        ) {
          console.log(`[scheduler] review → user ${user.id}`);
          const ctx = makeFakeCtx(bot, user.id);
          await handleReview(ctx);
        }
      } catch (e) {
        console.error(`[scheduler] user ${user.id}:`, e.message);
      }
    }
  });

  console.log('📅 Scheduler запущен');
  return task;
}

function stop(task) {
  if (task) task.stop();
  console.log('📅 Scheduler остановлен');
}

module.exports = { start, stop };
