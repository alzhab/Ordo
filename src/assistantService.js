const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('./config');
const { getTasks } = require('./taskService');
const { getGoalsWithProgress } = require('./goalService');
const db = require('./db');
const { localNow, localToUtc } = require('./helpers');

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Настройки пользователя ───────────────────────────────────

function getSettings(userId) {
  let row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare(`
      INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)
    `).run(userId);
    row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  }
  return row;
}

function updateSettings(userId, fields) {
  const allowed = ['morning_time', 'evening_time', 'timezone', 'morning_enabled', 'review_enabled', 'quiet_until', 'notion_enabled'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  getSettings(userId); // гарантируем что строка существует
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  db.prepare(`UPDATE user_settings SET ${sets}, updated_at = datetime('now') WHERE user_id = ?`)
    .run(...vals, userId);
}

function getNotionEnabled(userId) {
  const row = getSettings(userId);
  return row.notion_enabled !== 0;
}

// ─── Лог уведомлений ─────────────────────────────────────────

function logNotification(userId, type, taskId = null) {
  db.prepare(`INSERT INTO notification_log (user_id, type, task_id) VALUES (?, ?, ?)`)
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
  const settings = getSettings(userId);
  const today = localNow(settings.timezone);
  const startUtc = localToUtc(`${today} 00:00`, settings.timezone);
  const endUtc   = localToUtc(`${today} 23:59`, settings.timezone);
  const row = db.prepare(`
    SELECT 1 FROM notification_log
    WHERE user_id = ? AND type = ? AND sent_at >= ? AND sent_at <= ?
    LIMIT 1
  `).get(userId, type, startUtc, endUtc);
  return !!row;
}

function isQuietMode(userId) {
  const settings = getSettings(userId);
  if (!settings.quiet_until) return false;
  return new Date(settings.quiet_until) > new Date();
}

// ─── Утренний план ────────────────────────────────────────────

async function getMorningPlan(userId, date) {
  const { getTasksByPlannedDate } = require('./taskService');
  const { timezone } = getSettings(userId);
  const targetDate = date ?? localNow(timezone);

  // Все активные задачи без planned_for — кандидаты для AI
  const allTasks = getTasks(userId, {});
  // Уже запланированные на эту дату
  const plannedTasks = getTasksByPlannedDate(userId, targetDate);
  const plannedIds = new Set(plannedTasks.map(t => t.id));

  // Кандидаты: без planned_for или с другой датой
  const candidates = allTasks.filter(t => !t.planned_for || t.planned_for === targetDate);
  const unplanned = candidates.filter(t => !plannedIds.has(t.id));

  if (!unplanned.length) return [];

  const goals = getGoalsWithProgress(userId);

  const tasksText = unplanned.map(t => {
    const parts = [`[${t.id}] ${t.title}`];
    if (t.status) parts.push(`статус: ${t.status}`);
    if (t.waiting_until) parts.push(`ждёт до: ${t.waiting_until}`);
    if (t.goal_title) parts.push(`цель: ${t.goal_title}`);
    if (t.updated_at) parts.push(`обновлено: ${t.updated_at.slice(0, 10)}`);
    return parts.join(', ');
  }).join('\n');

  const plansText = goals.length
    ? goals.map(g => `"${g.title}" (${g.done ?? 0}/${g.total ?? 0} задач)`).join(', ')
    : 'нет активных целей';

  const prompt = `Дата плана: ${targetDate}. Ты — умный помощник по задачам Ordo.

Задачи которые ещё не запланированы на эту дату:
${tasksText}

Активные планы: ${plansText}

Выбери задачи которые стоит добавить в план на ${targetDate}. Учитывай:
- задачи со статусом waiting у которых истёк waiting_until
- задачи которые давно не обновлялись
- контекст планов (если план важный — его задачи важнее)
- не перегружай: 3-5 задач максимум

Верни JSON:
{
  "tasks": [
    { "id": <id задачи>, "reason": "<почему именно эта задача, 1 строка>" },
    ...
  ]
}

Только JSON, без пояснений.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const json = JSON.parse(text.replace(/```json|```/g, '').trim());
  return json.tasks ?? [];
}

// ─── Вечерний разбор ─────────────────────────────────────────

function getReviewTasks(userId) {
  const { timezone } = getSettings(userId);
  const today = localNow(timezone);
  const sevenDaysAgo = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  // Незакрытые задачи из сегодняшнего плана
  const plannedToday = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND planned_for = ? AND status NOT IN ('done', 'deleted')
    ORDER BY created_at ASC LIMIT 3
  `).all(userId, today);

  // waiting без даты, висит 3+ дня
  const waitingNoDate = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'waiting' AND waiting_until IS NULL
    AND date(updated_at) <= date('now', '-3 days')
    AND status != 'deleted'
    ORDER BY updated_at ASC LIMIT 3
  `).all(userId);

  // waiting с истёкшей датой
  const waitingExpired = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'waiting' AND waiting_until < ?
    AND status != 'deleted'
    ORDER BY waiting_until ASC LIMIT 2
  `).all(userId, today);

  // todo без движения 7+ дней
  const stale = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'todo'
    AND date(updated_at) <= ?
    AND status != 'deleted'
    ORDER BY updated_at ASC LIMIT 3
  `).all(userId, sevenDaysAgo);

  // maybe (для еженедельного опроса)
  const maybe = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'maybe'
    AND date(updated_at) <= date('now', '-7 days')
    ORDER BY updated_at ASC LIMIT 2
  `).all(userId);

  const seen = new Set();
  const result = [];
  for (const t of [...plannedToday, ...waitingExpired, ...waitingNoDate, ...stale, ...maybe]) {
    if (!seen.has(t.id) && result.length < 5) {
      seen.add(t.id);
      result.push(t);
    }
  }
  return result;
}

// ─── Фокус — одна задача прямо сейчас ────────────────────────

async function getFocusTask(userId) {
  const tasks = getTasks(userId, { status: 'todo' });
  if (!tasks.length) return null;

  const { timezone } = getSettings(userId);
  const today = localNow(timezone);
  const tasksText = tasks.slice(0, 20).map(t => {
    const parts = [`[${t.id}] ${t.title}`];
    if (t.planned_for) parts.push(`запланировано: ${t.planned_for}`);
    if (t.updated_at) parts.push(`обновлено: ${t.updated_at.slice(0, 10)}`);
    return parts.join(', ');
  }).join('\n');

  const prompt = `Сегодня: ${today}. Выбери ОДНУ задачу которую пользователю стоит сделать прямо сейчас.

Задачи:
${tasksText}

Верни JSON:
{ "id": <id задачи>, "reason": "<почему именно сейчас, 1 короткая строка>" }

Только JSON.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ─── Прогресс ─────────────────────────────────────────────────

function getProgress(userId) {
  const { timezone } = getSettings(userId);
  const today = localNow(timezone);
  const weekAgo = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  const doneToday = db.prepare(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE user_id = ? AND status = 'done' AND date(updated_at) = ?
  `).get(userId, today).cnt;

  const doneWeek = db.prepare(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE user_id = ? AND status = 'done' AND date(updated_at) >= ?
  `).get(userId, weekAgo).cnt;

  const plans = getGoalsWithProgress(userId);

  const stale = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status NOT IN ('done', 'deleted')
    AND date(updated_at) <= date('now', '-7 days')
    ORDER BY updated_at ASC LIMIT 3
  `).all(userId);

  return { doneToday, doneWeek, plans, stale };
}

module.exports = {
  getSettings,
  updateSettings,
  getNotionEnabled,
  logNotification,
  markReacted,
  wasNotifiedToday,
  isQuietMode,
  getMorningPlan,
  getReviewTasks,
  getFocusTask,
  getProgress,
};
