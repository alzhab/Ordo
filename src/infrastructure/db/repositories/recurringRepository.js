const db = require('../connection');

// days хранится в БД как JSON строка ("[1,3,5]"), при чтении парсится обратно в массив.
// NULL означает ежедневное повторение.
function create(userId, { title, event_time, days = null, day_of_month = null, reminder_before_minutes = 0 }) {
  const result = db.prepare(`
    INSERT INTO recurrent_tasks (user_id, title, event_time, days, day_of_month, reminder_before_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, title, event_time, days ? JSON.stringify(days) : null, day_of_month ?? null, reminder_before_minutes);
  return getById(result.lastInsertRowid);
}

function getById(id) {
  const row = db.prepare('SELECT * FROM recurrent_tasks WHERE id = ?').get(id);
  return row ? { ...row, days: row.days ? JSON.parse(row.days) : null } : null;
}

function getAll(userId) {
  return db.prepare('SELECT * FROM recurrent_tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    .map(r => ({ ...r, days: r.days ? JSON.parse(r.days) : null }));
}

function remove(id) {
  db.prepare('DELETE FROM recurrent_tasks WHERE id = ?').run(id);
}

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// Форматирует расписание в читаемую строку для отображения пользователю.
// Живёт здесь т.к. работает напрямую с полями recurrent_task и нигде больше не нужна.
function formatSchedule(r) {
  if (r.day_of_month) return `${r.day_of_month}-го числа каждого месяца`;
  if (!r.days || r.days.length === 7) return 'каждый день';
  return r.days.map(d => DAY_NAMES[d]).join(', ');
}

// Определяет какие повторяющиеся задачи нужно отправить прямо сейчас.
// Вызывается из scheduler каждую минуту с текущим временем HH:MM, днём недели и числом месяца.
//
// Логика: время уведомления = event_time - reminder_before_minutes.
// Приоритет совпадения: day_of_month > days (дни недели) > ежедневно (days = null).
function getDueNow(currentHHMM, currentDay, currentDayOfMonth) {
  const all = db.prepare('SELECT * FROM recurrent_tasks').all();
  return all.filter(r => {
    const days = r.days ? JSON.parse(r.days) : null;
    const reminderMinutes = r.reminder_before_minutes ?? 0;

    const [eh, em] = r.event_time.split(':').map(Number);
    const eventMinutes = eh * 60 + em;
    const notifyMinutes = eventMinutes - reminderMinutes;
    const notifyH = String(Math.floor(notifyMinutes / 60)).padStart(2, '0');
    const notifyM = String(notifyMinutes % 60).padStart(2, '0');
    const notifyHHMM = `${notifyH}:${notifyM}`;

    if (notifyHHMM !== currentHHMM) return false;
    if (r.day_of_month) return r.day_of_month === currentDayOfMonth;
    if (days && days.length > 0) return days.includes(currentDay);
    return true; // days = null → ежедневно
  });
}

module.exports = { create, getById, getAll, remove, formatSchedule, getDueNow };
