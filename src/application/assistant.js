const { ask, askJson } = require('../infrastructure/ai/claudeClient');
const { getTasks, getTasksByPlannedDate } = require('./tasks');
const { getGoalsWithProgress } = require('./goals');
const { getSettings } = require('./settings');
const { localNow } = require('../shared/helpers');
const db = require('../infrastructure/db/connection');

// ─── Утренний план ────────────────────────────────────────────

async function getMorningPlan(userId, date) {
  const { timezone } = getSettings(userId);
  const targetDate = date ?? localNow(timezone);

  const allTasks = getTasks(userId, {});
  const plannedTasks = getTasksByPlannedDate(userId, targetDate);
  const plannedIds = new Set(plannedTasks.map(t => t.id));

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

  const json = await askJson(prompt, { maxTokens: 1024 });
  return json.tasks ?? [];
}

// ─── Вечерний разбор ─────────────────────────────────────────

function getReviewTasks(userId) {
  const { timezone } = getSettings(userId);
  const today = localNow(timezone);
  const threeDaysAgo = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 3);
    return d.toISOString().slice(0, 10);
  })();

  // waiting с истёкшей датой — нужно решить что делать дальше
  const waitingExpired = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'waiting' AND waiting_until < ?
    AND status != 'deleted'
    ORDER BY waiting_until ASC LIMIT 2
  `).all(userId, today);

  // waiting без даты — висит 3+ дня, пора уточнить статус
  const waitingNoDate = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'waiting' AND waiting_until IS NULL
    AND date(updated_at) <= ?
    AND status != 'deleted'
    ORDER BY updated_at ASC LIMIT 3
  `).all(userId, threeDaysAgo);

  // inbox: todo без даты, не трогалась 3+ дня — пора запланировать или убрать
  const inbox = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'todo' AND planned_for IS NULL
    AND date(updated_at) <= ?
    ORDER BY updated_at ASC LIMIT 3
  `).all(userId, threeDaysAgo);

  // maybe — висит 7+ дней, всё ещё актуально?
  const maybe = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'maybe'
    AND date(updated_at) <= date('now', '-7 days')
    ORDER BY updated_at ASC LIMIT 2
  `).all(userId);

  const seen = new Set();
  const result = [];
  for (const t of [...waitingExpired, ...waitingNoDate, ...inbox, ...maybe]) {
    if (!seen.has(t.id) && result.length < 5) {
      seen.add(t.id);
      result.push(t);
    }
  }
  return result;
}

// Незакрытые задачи из плана на сегодня — отдельно от основного review
function getUnclosedPlannedTasks(userId) {
  const { timezone } = getSettings(userId);
  const today = localNow(timezone);
  return db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND planned_for = ? AND status NOT IN ('done', 'deleted')
    ORDER BY created_at ASC
  `).all(userId, today);
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

module.exports = { getMorningPlan, getReviewTasks, getUnclosedPlannedTasks, getProgress };
