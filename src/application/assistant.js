const { ask, askJson } = require('../infrastructure/ai/claudeClient');
const { getTasks, getTasksByPlannedDate } = require('./tasks');
const { getGoalsWithProgress } = require('./goals');
const { getSettings } = require('./settings');
const { localNow } = require('../shared/helpers');
const db = require('../infrastructure/db/connection');

// ─── Рекомендации для /plan ───────────────────────────────────

const DAY_NAMES_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function daysStale(updatedAt) {
  const updated = new Date(updatedAt);
  const now = new Date();
  return Math.floor((now - updated) / 86400000);
}

async function getPlanRecommendations(userId, date) {
  const { timezone } = getSettings(userId);
  const targetDate = date ?? localNow(timezone);

  const allTasks = getTasks(userId, {});
  const plannedTasks = getTasksByPlannedDate(userId, targetDate);
  const plannedIds = new Set(plannedTasks.map(t => t.id));

  // Просроченные: planned_for < today, незакрытые, не в сегодняшнем плане
  const today = localNow(timezone);
  const overdue = allTasks.filter(t =>
    t.planned_for && t.planned_for < today &&
    !['done', 'deleted'].includes(t.status) &&
    !t.is_recurring &&
    !plannedIds.has(t.id)
  );

  // Кандидаты: inbox (без даты) + ещё не запланированные на targetDate
  const candidates = allTasks.filter(t =>
    !t.planned_for &&
    !['done', 'deleted'].includes(t.status) &&
    !t.is_recurring &&
    !plannedIds.has(t.id)
  );

  if (!overdue.length && !candidates.length) return [];

  const goals = getGoalsWithProgress(userId);

  const targetDay = new Date(targetDate + 'T00:00:00');
  const dayName = DAY_NAMES_RU[targetDay.getDay()];
  const isWeekend = targetDay.getDay() === 0 || targetDay.getDay() === 6;

  const goalsText = goals.length
    ? goals.map(g => `"${g.title}" (${g.done ?? 0}/${g.total ?? 0} задач выполнено)`).join('\n')
    : 'нет активных целей';

  function formatTask(t) {
    const parts = [`[${t.id}] ${t.title}`];
    if (t.status === 'waiting') {
      parts.push(t.waiting_until ? `ждёт до: ${t.waiting_until}` : 'ждёт (без даты)');
      if (t.waiting_reason) parts.push(`причина: ${t.waiting_reason}`);
    }
    if (t.goal_title) parts.push(`цель: "${t.goal_title}"`);
    parts.push(`без изменений: ${daysStale(t.updated_at)} дн.`);
    if (t.category_name) parts.push(`категория: ${t.category_name}`);
    return parts.join(', ');
  }

  const overdueText = overdue.length
    ? overdue.map(t => {
        const parts = [`[${t.id}] ${t.title}`];
        parts.push(`просрочена: было на ${t.planned_for}`);
        if (t.goal_title) parts.push(`цель: "${t.goal_title}"`);
        if (t.category_name) parts.push(`категория: ${t.category_name}`);
        return parts.join(', ');
      }).join('\n')
    : null;

  const candidatesText = candidates.length
    ? candidates.map(formatTask).join('\n')
    : null;

  const prompt = `Ты — планировщик задач. Помоги составить план на ${targetDate} (${dayName}${isWeekend ? ', выходной' : ', рабочий день'}).

${overdueText ? `## Просроченные задачи (были запланированы, не выполнены)\n${overdueText}\n` : ''}
${candidatesText ? `## Задачи без даты (inbox)\n${candidatesText}\n` : ''}
## Активные цели
${goalsText}

## Уже в плане на этот день: ${plannedTasks.length} задач

## Задача
Выбери 3–5 задач для плана. Приоритеты по убыванию:
1. Просроченные задачи — их нужно закрыть или перенести
2. Waiting-задачи у которых истёк или скоро истекает срок ожидания
3. Задачи из активных целей с малым прогрессом
4. Задачи без движения 7+ дней
5. ${isWeekend ? 'Выходной: предпочитай личные/бытовые задачи рабочим' : 'Рабочий день: рабочие задачи важнее бытовых'}

Не выбирай задачи если план уже содержит 5+ задач — верни пустой массив.

Верни JSON:
{
  "tasks": [
    { "id": <число>, "reason": "<конкретная причина: сколько дней без движения, какая цель, почему сейчас>" }
  ]
}

Только JSON, без пояснений.`;

  const json = await askJson(prompt, { maxTokens: 1024 });
  return json.tasks ?? [];
}

// ─── Данные для /review ───────────────────────────────────────

// Возвращает задачи по категориям для сводной карточки /review.
// Каждая категория — отдельный массив, без лимитов (показываем всё).
function getReviewData(userId) {
  const { timezone } = getSettings(userId);
  const today = localNow(timezone);
  const threeDaysAgo = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 3);
    return d.toISOString().slice(0, 10);
  })();

  // Незакрытые задачи из плана на сегодня (без повторяющихся)
  const unclosed = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND planned_for = ? AND status NOT IN ('done', 'deleted') AND is_recurring != 1
    ORDER BY created_at ASC
  `).all(userId, today);

  // waiting: и просроченные, и без даты 3+ дней — одна группа, кнопки различаются по типу
  const waiting = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'waiting' AND status != 'deleted'
    AND (
      (waiting_until IS NOT NULL AND waiting_until < ?)
      OR
      (waiting_until IS NULL AND date(updated_at) <= ?)
    )
    ORDER BY waiting_until ASC, updated_at ASC
  `).all(userId, today, threeDaysAgo);

  // inbox: todo без даты, не трогалась 3+ дня (без повторяющихся)
  const inbox = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status = 'todo' AND planned_for IS NULL AND is_recurring != 1
    AND date(updated_at) <= ?
    ORDER BY updated_at ASC
  `).all(userId, threeDaysAgo);

  const doneToday = db.prepare(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE user_id = ? AND status = 'done' AND date(updated_at) = ?
  `).get(userId, today).cnt;

  return { unclosed, waiting, inbox, doneToday };
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

module.exports = { getPlanRecommendations, getReviewData, getProgress };
