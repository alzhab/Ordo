const db = require('./db');

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function create(userId, { title, event_time, days = null, day_of_month = null, reminder_before_minutes = 0 }) {
  const stmt = db.prepare(`
    INSERT INTO recurrent_tasks (user_id, title, event_time, days, day_of_month, reminder_before_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    userId, title, event_time,
    days ? JSON.stringify(days) : null,
    day_of_month ?? null,
    reminder_before_minutes
  );
  return db.prepare('SELECT * FROM recurrent_tasks WHERE id = ?').get(result.lastInsertRowid);
}

function getAll(userId) {
  return db.prepare('SELECT * FROM recurrent_tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function getById(id) {
  return db.prepare('SELECT * FROM recurrent_tasks WHERE id = ?').get(id);
}

function remove(id) {
  db.prepare('DELETE FROM recurrent_tasks WHERE id = ?').run(id);
}

// Вернуть все повторяющиеся задачи которые должны сработать прямо сейчас
// currentHHMM — текущее время 'HH:MM', currentDay — 0-6 (JS getDay()), currentDayOfMonth — 1-31
function getDueNow(currentHHMM, currentDay, currentDayOfMonth) {
  const all = db.prepare('SELECT * FROM recurrent_tasks').all();
  return all.filter(r => {
    // Вычислить время напоминания = event_time - reminder_before_minutes
    const [h, m] = r.event_time.split(':').map(Number);
    const totalMinutes = h * 60 + m - r.reminder_before_minutes;
    const remH = String(Math.floor(((totalMinutes % 1440) + 1440) % 1440 / 60)).padStart(2, '0');
    const remM = String(((totalMinutes % 60) + 60) % 60).padStart(2, '0');
    const reminderTime = `${remH}:${remM}`;

    if (reminderTime !== currentHHMM) return false;

    // Проверить день
    if (r.day_of_month != null) {
      return currentDayOfMonth === r.day_of_month;
    }
    if (r.days) {
      const days = JSON.parse(r.days);
      return days.includes(currentDay);
    }
    return true; // ежедневно
  });
}

function formatSchedule(r) {
  const parts = [];
  if (r.day_of_month != null) {
    parts.push(`${r.day_of_month}-го числа`);
  } else if (r.days) {
    const days = JSON.parse(r.days);
    if (days.length === 7) {
      parts.push('каждый день');
    } else if (JSON.stringify(days.sort()) === JSON.stringify([1,2,3,4,5])) {
      parts.push('пн–пт');
    } else {
      parts.push(days.map(d => DAY_NAMES[d]).join(', '));
    }
  } else {
    parts.push('каждый день');
  }
  parts.push(`в ${r.event_time}`);
  if (r.reminder_before_minutes > 0) {
    parts.push(`(напомню за ${r.reminder_before_minutes} мин.)`);
  }
  return parts.join(' ');
}

module.exports = { create, getAll, getById, remove, getDueNow, formatSchedule };
