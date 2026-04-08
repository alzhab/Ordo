const db = require('./db');
const { getCategoryByName, createCategory, PRIORITY_MAP } = require('./categoryService');
const { getGoalByTitle } = require('./goalService');

function createTask(userId, parsed) {
  // Категория: найти или создать
  let categoryId = null;
  if (parsed.category) {
    let cat = getCategoryByName(userId, parsed.category);
    if (!cat) cat = createCategory(userId, parsed.category);
    categoryId = cat.id;
  }

  // Цель: резолвим название в id (поддержка legacy plan_id)
  let goalId = parsed.goal_id ?? parsed.plan_id ?? null;
  if (!goalId && parsed.plan) {
    const goal = getGoalByTitle(userId, parsed.plan);
    goalId = goal?.id ?? null;
  }

	console.log(JSON.stringify(parsed, null, 2))

  const result = db.prepare(`
    INSERT INTO tasks (user_id, title, description, status, priority, category_id, goal_id, planned_for, waiting_reason, waiting_until, reminder_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    parsed.title,
    parsed.description ?? null,
    parsed.status ?? 'not_started',
    PRIORITY_MAP[parsed.priority] ?? null,
    categoryId,
    goalId,
    parsed.plannedFor ?? null,
    parsed.waiting_reason ?? null,
    parsed.waiting_until ?? null,
    parsed.reminder_at ?? null,
  );

  return getTaskById(result.lastInsertRowid);
}

function getTaskById(id) {
  return db.prepare(`
    SELECT t.*, t.goal_id AS plan_id, c.name AS category_name, g.title AS goal_title, g.title AS plan_title, g.notion_page_id AS goal_notion_page_id
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.id = ?
  `).get(id);
}

function getTasks(userId, filter = {}) {
  const { status, category, goalId, planId, search, includeArchived = false } = filter;
  const conditions = ['t.user_id = ?'];
  const params = [userId];

  if (status) {
    conditions.push('t.status = ?');
    params.push(status);
  } else {
    // "Все активные" — всё кроме выполненных и удалённых
    conditions.push("t.status NOT IN ('deleted', 'done')");
  }
  if (!includeArchived) {
    conditions.push("(t.goal_id IS NULL OR g.status != 'archived')");
  }
  if (category) {
    conditions.push('c.name = ?');
    params.push(category);
  }
  // Support both goalId (new) and planId (legacy alias)
  const effectiveGoalId = goalId ?? planId ?? null;
  if (effectiveGoalId) {
    conditions.push('t.goal_id = ?');
    params.push(effectiveGoalId);
  }
  if (search) {
    conditions.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const orderBy = status === 'waiting'
    ? `CASE WHEN t.waiting_until IS NULL THEN 1 ELSE 0 END, t.waiting_until ASC`
    : `t.created_at DESC`;

  return db.prepare(`
    SELECT t.*, t.goal_id AS plan_id, c.name AS category_name, g.title AS goal_title, g.title AS plan_title, g.notion_page_id AS goal_notion_page_id
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN goals g ON g.id = t.goal_id
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

// Legacy alias
const getTasksByPlan = getTasksByGoal;

function updateTask(id, fields) {
  // Normalize legacy plan_id → goal_id
  if ('plan_id' in fields && !('goal_id' in fields)) {
    fields = { ...fields, goal_id: fields.plan_id };
    delete fields.plan_id;
  }
  const allowed = ['title', 'description', 'status', 'priority', 'category_id', 'goal_id', 'planned_for', 'notion_page_id', 'waiting_reason', 'waiting_until', 'reminder_at', 'reminder_sent'];
  const allowedKeys = Object.keys(fields).filter(k => allowed.includes(k));
  if (allowedKeys.length === 0) return getTaskById(id);

  const updates = allowedKeys.map(k => `${k} = ?`);
  const values = allowedKeys.map(k => fields[k]);

  db.prepare(`
    UPDATE tasks SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?
  `).run(...values, id);

  return getTaskById(id);
}

function deleteTask(id) {
  return updateTask(id, { status: 'deleted' });
}

function getUnsyncedTasks(userId) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name, g.title AS goal_title
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.user_id = ? AND t.status != 'deleted' AND (t.notion_page_id IS NULL OR t.notion_page_id = '')
  `).all(userId);
}

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

module.exports = { createTask, getTaskById, getTasks, getTasksByPlannedDate, getTasksByGoal, getTasksByPlan, updateTask, deleteTask, getUnsyncedTasks, getDueReminders };
