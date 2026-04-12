const db = require('../connection');

// Базовый SELECT для задач — используется в getTaskById и getTasks.
// Алиасы goal_id AS plan_id и goal_title AS plan_title для обратной совместимости
// с хендлерами которые ещё обращаются к task.plan_id / task.plan_title.
const TASK_SELECT = `
  SELECT t.*, t.goal_id AS plan_id, c.name AS category_name,
         g.title AS goal_title, g.title AS plan_title,
         g.notion_page_id AS goal_notion_page_id
  FROM tasks t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN goals g ON g.id = t.goal_id
`;

// Вычисляет дату следующего срабатывания для повторяющейся задачи.
// fromTomorrow=true — начинать со завтра (используется при смещении после срабатывания).
function computeNextOccurrence(recur_days, recur_day_of_month, fromTomorrow = false) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (fromTomorrow) start.setDate(start.getDate() + 1);

  if (recur_day_of_month) {
    const next = new Date(start.getFullYear(), start.getMonth(), recur_day_of_month);
    if (next < start) next.setMonth(next.getMonth() + 1);
    return next.toISOString().split('T')[0];
  }

  const days = recur_days
    ? (typeof recur_days === 'string' ? JSON.parse(recur_days) : recur_days)
    : null;

  if (!days) return start.toISOString().split('T')[0]; // ежедневно

  for (let i = 0; i <= 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    if (days.includes(d.getDay())) return d.toISOString().split('T')[0];
  }
  return start.toISOString().split('T')[0];
}

// Принимает уже разрешённые поля: category_id, goal_id.
// Бизнес-логика резолвинга (категория по имени, цель по заголовку) — в application/tasks.js.
function createTask(userId, parsed) {
  const recurDays = parsed.recur_days != null
    ? (typeof parsed.recur_days === 'string' ? parsed.recur_days : JSON.stringify(parsed.recur_days))
    : null;

  const result = db.prepare(`
    INSERT INTO tasks (
      user_id, title, description, status, category_id, goal_id, planned_for,
      waiting_reason, waiting_until, reminder_at,
      is_recurring, recur_days, recur_day_of_month, recur_time, recur_remind_before
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    parsed.title,
    parsed.description ?? null,
    parsed.status ?? 'todo',
    parsed.category_id ?? null,
    parsed.goal_id ?? null,
    parsed.plannedFor ?? null,
    parsed.waiting_reason ?? null,
    parsed.waiting_until ?? null,
    parsed.reminder_at ?? null,
    parsed.is_recurring ? 1 : 0,
    recurDays,
    parsed.recur_day_of_month ?? null,
    parsed.recur_time ?? null,
    parsed.recur_remind_before ?? 0,
  );

  return getTaskById(result.lastInsertRowid);
}

function getTaskById(id) {
  return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
}

// Универсальная выборка с фильтрами. Без фильтра status по умолчанию
// исключает done и deleted — показываем только активные задачи.
// includeArchived = false исключает задачи из архивированных целей.
function getTasks(userId, filter = {}) {
  const { status, category, goalId, planId, search, includeArchived = false, plannedToday = false, isRecurring } = filter;
  const conditions = ['t.user_id = ?'];
  const params = [userId];

  if (status) {
    conditions.push('t.status = ?');
    params.push(status);
  } else {
    conditions.push("t.status NOT IN ('deleted', 'done')");
  }
  if (!includeArchived) {
    conditions.push("(t.goal_id IS NULL OR g.status != 'archived')");
  }
  if (category) {
    conditions.push('c.name = ?');
    params.push(category);
  }
  const effectiveGoalId = goalId ?? planId ?? null;
  if (effectiveGoalId) {
    conditions.push('t.goal_id = ?');
    params.push(effectiveGoalId);
  }
  if (plannedToday) {
    conditions.push("t.planned_for = date('now')");
  }
  if (isRecurring === true) {
    conditions.push('t.is_recurring = 1');
  } else if (isRecurring === false) {
    conditions.push('t.is_recurring = 0');
  }
  if (search) {
    conditions.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  // waiting сортируем по дате: сначала с конкретной датой, потом без даты
  const orderBy = status === 'waiting'
    ? `CASE WHEN t.waiting_until IS NULL THEN 1 ELSE 0 END, t.waiting_until ASC`
    : `t.created_at DESC`;

  return db.prepare(`
    ${TASK_SELECT}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params);
}

function getTasksByPlannedDate(userId, date) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.planned_for = ? AND t.status NOT IN ('done', 'deleted')
    ORDER BY t.created_at ASC
  `).all(userId, date);
}

function getTasksByGoal(userId, goalId) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.goal_id = ? AND t.status != 'deleted'
    ORDER BY t.created_at DESC
  `).all(userId, goalId);
}

// Алиас для обратной совместимости — handlers используют и goalId и planId
const getTasksByPlan = getTasksByGoal;

// Whitelist полей защищает от случайного UPDATE произвольных колонок.
// plan_id → goal_id: handlers ещё могут передавать plan_id, нормализуем здесь.
function updateTask(id, fields) {
  if ('plan_id' in fields && !('goal_id' in fields)) {
    fields = { ...fields, goal_id: fields.plan_id };
    delete fields.plan_id;
  }
  const allowed = ['title', 'description', 'status', 'category_id', 'goal_id', 'planned_for', 'notion_page_id', 'waiting_reason', 'waiting_until', 'reminder_at', 'reminder_sent', 'is_recurring', 'recur_days', 'recur_day_of_month', 'recur_time', 'recur_remind_before'];
  const allowedKeys = Object.keys(fields).filter(k => allowed.includes(k));
  if (allowedKeys.length === 0) return getTaskById(id);

  const updates = allowedKeys.map(k => `${k} = ?`);
  const values = allowedKeys.map(k => fields[k]);

  db.prepare(`
    UPDATE tasks SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?
  `).run(...values, id);

  return getTaskById(id);
}

// Soft delete — задача остаётся в БД со статусом 'deleted'
function deleteTask(id) {
  return updateTask(id, { status: 'deleted' });
}

// Еженедельная очистка выполненных задач.
// Повторяющиеся (is_recurring=1) не трогаем — они живут в вечном цикле.
// Возвращает количество затронутых строк.
function cleanupDoneTasks() {
  return db.prepare(`
    UPDATE tasks SET status = 'deleted', updated_at = datetime('now')
    WHERE status = 'done' AND is_recurring = 0
  `).run().changes;
}

// Задачи без notion_page_id — кандидаты для первичной синхронизации с Notion
function getUnsyncedTasks(userId) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name, g.title AS goal_title
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.user_id = ? AND t.status != 'deleted' AND (t.notion_page_id IS NULL OR t.notion_page_id = '')
  `).all(userId);
}

// Задачи с истёкшим reminder_at которые ещё не были отправлены.
// Вызывается из scheduler каждую минуту.
function getDueReminders() {
  return db.prepare(`
    SELECT *
    FROM tasks
    WHERE reminder_at IS NOT NULL
      AND reminder_sent = 0
      AND status NOT IN ('done', 'deleted')
      AND datetime(reminder_at) <= datetime('now')
  `).all();
}

// Повторяющиеся задачи у которых подошло время уведомления.
// Логика идентична старому recurringRepository.getDueNow.
function getRecurringDueNow(currentHHMM, currentDay, currentDayOfMonth, userId = null) {
  const tasks = userId
    ? db.prepare(`SELECT * FROM tasks WHERE is_recurring = 1 AND status != 'deleted' AND planned_for <= date('now') AND user_id = ?`).all(userId)
    : db.prepare(`SELECT * FROM tasks WHERE is_recurring = 1 AND status != 'deleted' AND planned_for <= date('now')`).all();

  return tasks.filter(task => {
    if (!task.recur_time) return false;
    const [eh, em] = task.recur_time.split(':').map(Number);
    const notifyMin = (eh * 60 + em) - (task.recur_remind_before ?? 0);
    const notifyHHMM = `${String(Math.floor(notifyMin / 60)).padStart(2, '0')}:${String(notifyMin % 60).padStart(2, '0')}`;
    if (notifyHHMM !== currentHHMM) return false;
    if (task.recur_day_of_month) return task.recur_day_of_month === currentDayOfMonth;
    const days = task.recur_days ? JSON.parse(task.recur_days) : null;
    if (days) return days.includes(currentDay);
    return true; // ежедневно
  });
}

// Сбрасывает updated_at на сейчас чтобы задача исчезла из /review на N дней.
function snoozeTask(id) {
  db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(id);
  return getTaskById(id);
}

// Сдвигает planned_for на следующее срабатывание после того как задача сработала.
function advanceRecurring(taskId) {
  const task = getTaskById(taskId);
  if (!task) return null;
  const nextDate = computeNextOccurrence(task.recur_days, task.recur_day_of_month, true);
  return updateTask(taskId, { planned_for: nextDate, status: 'todo' });
}

module.exports = {
  createTask,
  getTaskById,
  getTasks,
  getTasksByPlannedDate,
  getTasksByGoal,
  getTasksByPlan,
  updateTask,
  deleteTask,
  getUnsyncedTasks,
  getDueReminders,
  getRecurringDueNow,
  advanceRecurring,
  computeNextOccurrence,
  snoozeTask,
  cleanupDoneTasks,
};
