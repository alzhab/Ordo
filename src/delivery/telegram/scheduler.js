const cron = require('node-cron');
const db = require('../../infrastructure/db/connection');
const { wasNotifiedToday, logNotification, getRecurringDueNow, getDueReminders } = require('../../application/notifications');
const { isQuietMode } = require('../../application/settings');
const { handlePlan, handleReview } = require('./handlers/assistant');
const { getReviewData } = require('../../application/assistant');
const { updateTask, advanceRecurring, cleanupDoneTasks } = require('../../application/tasks');

// Получить всех активных пользователей с их настройками
function getActiveUsers() {
  // Пользователь активен если писал боту последние 7 дней
  return db.prepare(`
    SELECT u.id, COALESCE(s.plan_time, '09:00') AS plan_time,
           COALESCE(s.review_time, '21:00') AS review_time,
           COALESCE(s.plan_enabled, 1) AS plan_enabled,
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
      timeZone: timezone || 'Asia/Oral',
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
    chat: { id: userId },
    telegram: bot.telegram,
    reply:           (text, extra) => bot.telegram.sendMessage(userId, text, extra),
    editMessageText: (text, extra) => bot.telegram.sendMessage(userId, text, extra),
    sendChatAction:  ()            => bot.telegram.sendChatAction(userId, 'typing'),
    answerCbQuery:   ()            => {},
  };
}

// Отслеживаем дату последней еженедельной очистки чтобы не запускать повторно
let lastWeeklyCleanup = null;

function runWeeklyCleanup() {
  const now  = new Date();
  // Воскресенье (0) в 02:00 UTC
  if (now.getUTCDay() !== 0 || now.getUTCHours() !== 2) return;
  const today = now.toISOString().slice(0, 10);
  if (lastWeeklyCleanup === today) return;
  lastWeeklyCleanup = today;
  try {
    const count = cleanupDoneTasks();
    console.log(`[scheduler] weekly cleanup: ${count} done tasks deleted`);
  } catch (e) {
    console.error('[scheduler] weekly cleanup error:', e.message);
  }
}

function start(bot) {
  // Каждую минуту проверяем всех пользователей
  const task = cron.schedule('* * * * *', async () => {
    // Еженедельная очистка выполненных задач (воскресенье 02:00 UTC)
    runWeeklyCleanup();

    let users;
    try {
      users = getActiveUsers();
    } catch (e) {
      console.error('[scheduler] getActiveUsers error:', e.message);
      return;
    }

    // Напоминания для обычных задач
    try {
      const reminders = getDueReminders();
      console.log(`[scheduler] reminders check: ${reminders.length} due`);
      for (const task of reminders) {
        console.log(`[scheduler] sending reminder "${task.title}" → user ${task.user_id}`);
        await bot.telegram.sendMessage(
          task.user_id,
          `🔔 *Напоминание:* ${task.title}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Сделал', callback_data: `ts_done_${task.id}` },
                { text: '📋 Открыть', callback_data: `tv_${task.id}` },
              ]],
            },
          }
        );
        updateTask(task.id, { reminder_sent: 1 });
      }
    } catch (e) {
      console.error('[scheduler] reminders error:', e.message);
    }

    // Повторяющиеся задачи — проверяем для каждого пользователя по его timezone
    try {
      for (const user of users) {
        const tz = user.timezone || 'Asia/Oral';
        const hhmm = getCurrentHHMM(tz);
        const localNow = new Date(new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date()));
        const due = getRecurringDueNow(hhmm, localNow.getDay(), localNow.getDate(), user.id);
        for (const r of due) {
          const text = r.recur_remind_before > 0
            ? `🔔 *${r.title}* — через ${r.recur_remind_before} мин.`
            : `🔔 *${r.title}*`;
          await bot.telegram.sendMessage(r.user_id, text, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Сделал', callback_data: `rc_done_${r.id}` },
              ]],
            },
          });
          advanceRecurring(r.id);
        }
      }
    } catch (e) {
      console.error('[scheduler] recurring error:', e.message);
    }

    for (const user of users) {
      try {
        const currentTime = getCurrentHHMM(user.timezone);

        // Тихий режим
        if (user.quiet_until && new Date(user.quiet_until) > new Date()) continue;

        // /plan
        if (
          user.plan_enabled &&
          currentTime === user.plan_time &&
          !wasNotifiedToday(user.id, 'plan')
        ) {
          const ctx = makeFakeCtx(bot, user.id);
          await handlePlan(ctx);
          logNotification(user.id, 'plan');
        }

        // /review — только если есть задачи для разбора
        if (
          user.review_enabled &&
          currentTime === user.review_time &&
          !wasNotifiedToday(user.id, 'review')
        ) {
          const reviewTasks = getReviewData(user.id);
          if (reviewTasks.length > 0) {
            const ctx = makeFakeCtx(bot, user.id);
            await handleReview(ctx);
            logNotification(user.id, 'review');
          }
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
