const { ask, askJson } = require('../infrastructure/ai/claudeClient');
const { getTasks, getTasksByPlannedDate } = require('./tasks');
const { getGoalsWithProgress } = require('./goals');
const { getSettings } = require('./settings');
const { localNow } = require('../shared/helpers');
const db = require('../infrastructure/db/connection');

// ─── Кэш рекомендаций /plan ──────────────────────────────────
// Ключ: `${userId}_${date}`, значение: { suggestions, expiresAt }
// Живёт до конца суток (по UTC) или 4 часов — что наступит раньше.

const planRecoCache = new Map();

function getCachedRecommendations(userId, date) {
  const cached = planRecoCache.get(`${userId}_${date}`);
  if (cached && cached.expiresAt > Date.now()) return cached.suggestions;
  planRecoCache.delete(`${userId}_${date}`);
  return null;
}

function setCachedRecommendations(userId, date, suggestions) {
  const endOfDayUTC = new Date(date + 'T23:59:59Z').getTime();
  const fourHours   = Date.now() + 4 * 3600_000;
  planRecoCache.set(`${userId}_${date}`, {
    suggestions,
    expiresAt: Math.min(endOfDayUTC, fourHours),
  });
}

function invalidatePlanCache(userId, date) {
  planRecoCache.delete(`${userId}_${date}`);
}

// ─── Рекомендации для /plan ───────────────────────────────────

const DAY_NAMES_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function daysStale(updatedAt) {
  const updated = new Date(updatedAt);
  const now = new Date();
  return Math.floor((now - updated) / 86400000);
}

async function getPlanRecommendations(userId, date, { forceRefresh = false } = {}) {
  const { timezone } = getSettings(userId);
  const targetDate = date ?? localNow(timezone);

  if (!forceRefresh) {
    const cached = getCachedRecommendations(userId, targetDate);
    if (cached !== null) return cached;
  }

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
    !['done', 'deleted', 'maybe'].includes(t.status) &&
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
Выбери до 3 задач для дополнения плана. Если план уже насыщен (7+ задач), можно вернуть пустой массив. Приоритеты по убыванию:
1. Просроченные задачи — их нужно закрыть или перенести
2. Waiting-задачи у которых истёк или скоро истекает срок ожидания
3. Задачи из активных целей с малым прогрессом
4. Задачи без движения 7+ дней
5. ${isWeekend ? 'Выходной: предпочитай личные/бытовые задачи рабочим' : 'Рабочий день: рабочие задачи важнее бытовых'}

Верни JSON:
{
  "tasks": [
    { "id": <число>, "reason": "<конкретная причина: сколько дней без движения, какая цель, почему сейчас>" }
  ]
}

Только JSON, без пояснений.`;

  const json = await askJson(prompt, { maxTokens: 1024 });
  const suggestions = json.tasks ?? [];
  setCachedRecommendations(userId, targetDate, suggestions);
  return suggestions;
}

// ─── Данные для /review ───────────────────────────────────────

// Возвращает плоский список задач для разбора (до 5), упорядоченных по срочности.
// Каждая задача дополняется полем reason — почему она здесь.
function getReviewData(userId) {
  const { timezone } = getSettings(userId);
  const today = localNow(timezone);

  const tasks = db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ?
      AND t.status IN ('todo', 'waiting', 'maybe')
      AND t.is_recurring != 1
      AND (
        (t.status = 'waiting' AND t.waiting_until IS NOT NULL AND t.waiting_until < ?)
        OR (t.status = 'waiting' AND t.waiting_until IS NULL
            AND julianday(?) - julianday(t.updated_at) > 5)
        OR (t.status = 'todo' AND t.planned_for IS NULL
            AND julianday(?) - julianday(t.updated_at) > 7)
        OR (t.status = 'maybe'
            AND julianday(?) - julianday(t.updated_at) > 7)
      )
    ORDER BY
      CASE
        WHEN t.status = 'waiting' AND t.waiting_until IS NOT NULL AND t.waiting_until < ? THEN 1
        WHEN t.status = 'waiting' AND t.waiting_until IS NULL THEN 2
        WHEN t.status = 'todo' THEN 3
        WHEN t.status = 'maybe' THEN 4
      END,
      t.updated_at ASC
    LIMIT 5
  `).all(userId, today, today, today, today, today);

  const now = Date.now();
  return tasks.map(t => {
    const days = Math.max(0, Math.floor(
      (now - new Date(t.updated_at.replace(' ', 'T') + 'Z').getTime()) / 86400000
    ));
    let reason;
    if (t.status === 'waiting' && t.waiting_until && t.waiting_until < today) {
      reason = `Срок ожидания вышел`;
      if (t.waiting_reason) reason += ` (${t.waiting_reason})`;
    } else if (t.status === 'waiting') {
      reason = `Ждёт уже ${days} дн.`;
      if (t.waiting_reason) reason += ` — ${t.waiting_reason}`;
    } else if (t.status === 'maybe') {
      reason = `Отложено ${days} дн. назад`;
    } else {
      reason = `Висит ${days} дн. без даты`;
    }
    return { ...t, reason };
  });
}

module.exports = { getPlanRecommendations, getReviewData, invalidatePlanCache };
