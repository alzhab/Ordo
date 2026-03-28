const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('./config');
const { getTasks } = require('./taskService');
const { getPlansWithProgress } = require('./planService');
const db = require('./db');

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
  const allowed = ['morning_time', 'evening_time', 'timezone', 'morning_enabled', 'review_enabled', 'quiet_until'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  db.prepare(`UPDATE user_settings SET ${sets}, updated_at = datetime('now') WHERE user_id = ?`)
    .run(...vals, userId);
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
  const row = db.prepare(`
    SELECT 1 FROM notification_log
    WHERE user_id = ? AND type = ? AND date(sent_at) = date('now')
    LIMIT 1
  `).get(userId, type);
  return !!row;
}

function isQuietMode(userId) {
  const settings = getSettings(userId);
  if (!settings.quiet_until) return false;
  return new Date(settings.quiet_until) > new Date();
}

// ─── Утренний план ────────────────────────────────────────────

async function getMorningPlan(userId) {
  const tasks = getTasks(userId, {});
  if (!tasks.length) return null;

  const plans = getPlansWithProgress(userId);
  const today = new Date().toISOString().slice(0, 10);

  const tasksText = tasks.map(t => {
    const parts = [`[${t.id}] ${t.title}`];
    if (t.status) parts.push(`статус: ${t.status}`);
    if (t.due_date) parts.push(`дедлайн: ${t.due_date}`);
    if (t.waiting_until) parts.push(`ждёт до: ${t.waiting_until}`);
    if (t.plan_title) parts.push(`план: ${t.plan_title}`);
    if (t.updated_at) parts.push(`обновлено: ${t.updated_at.slice(0, 10)}`);
    return parts.join(', ');
  }).join('\n');

  const plansText = plans.length
    ? plans.map(p => `"${p.title}" (${p.done_count ?? 0}/${p.total_count ?? 0} задач)`).join(', ')
    : 'нет активных планов';

  const prompt = `Сегодня: ${today}. Ты — умный помощник по задачам Ordo.

Задачи пользователя:
${tasksText}

Активные планы: ${plansText}

Выбери наиболее важные задачи на сегодня. Учитывай:
- дедлайны (ближайшие важнее)
- задачи со статусом waiting у которых истёк waiting_until
- задачи которые давно не обновлялись
- контекст планов (если план важный — его задачи важнее)
- не перегружай: оптимальное количество задач на день, не больше

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
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

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
  for (const t of [...waitingExpired, ...waitingNoDate, ...stale, ...maybe]) {
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

  const today = new Date().toISOString().slice(0, 10);
  const tasksText = tasks.slice(0, 20).map(t => {
    const parts = [`[${t.id}] ${t.title}`];
    if (t.due_date) parts.push(`дедлайн: ${t.due_date}`);
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
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const doneToday = db.prepare(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE user_id = ? AND status = 'done' AND date(updated_at) = ?
  `).get(userId, today).cnt;

  const doneWeek = db.prepare(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE user_id = ? AND status = 'done' AND date(updated_at) >= ?
  `).get(userId, weekAgo).cnt;

  const plans = getPlansWithProgress(userId);

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
  logNotification,
  markReacted,
  wasNotifiedToday,
  isQuietMode,
  getMorningPlan,
  getReviewTasks,
  getFocusTask,
  getProgress,
};
