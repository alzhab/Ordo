const db = require('./db');
const { getCategoryByName, createCategory, PRIORITY_MAP } = require('./categoryService');
const { getPlanByTitle } = require('./planService');

function createTask(userId, parsed) {
  // Категория: найти или создать
  let categoryId = null;
  if (parsed.category) {
    let cat = getCategoryByName(userId, parsed.category);
    if (!cat) cat = createCategory(userId, parsed.category);
    categoryId = cat.id;
  }

  // План: резолвим название в id
  let planId = parsed.plan_id ?? null;
  if (!planId && parsed.plan) {
    const plan = getPlanByTitle(userId, parsed.plan);
    planId = plan?.id ?? null;
  }

  const result = db.prepare(`
    INSERT INTO tasks (user_id, title, description, status, priority, category_id, plan_id, due_date, waiting_reason, waiting_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    parsed.title,
    parsed.description ?? null,
    parsed.status ?? 'not_started',
    PRIORITY_MAP[parsed.priority] ?? null,
    categoryId,
    planId,
    parsed.dueDate ?? null,
    parsed.waiting_reason ?? null,
    parsed.waiting_until ?? null,
  );

  return getTaskById(result.lastInsertRowid);
}

function getTaskById(id) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name, p.title AS plan_title, p.notion_page_id AS plan_notion_page_id
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN plans p ON p.id = t.plan_id
    WHERE t.id = ?
  `).get(id);
}

function getTasks(userId, filter = {}) {
  const { status, category, planId, search, includeArchived = false } = filter;
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
    conditions.push("(t.plan_id IS NULL OR p.status != 'archived')");
  }
  if (category) {
    conditions.push('c.name = ?');
    params.push(category);
  }
  if (planId) {
    conditions.push('t.plan_id = ?');
    params.push(planId);
  }
  if (search) {
    conditions.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const orderBy = status === 'waiting'
    ? `CASE WHEN t.waiting_until IS NULL THEN 1 ELSE 0 END, t.waiting_until ASC`
    : `t.created_at DESC`;

  return db.prepare(`
    SELECT t.*, c.name AS category_name, p.title AS plan_title, p.notion_page_id AS plan_notion_page_id
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN plans p ON p.id = t.plan_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderBy}
  `).all(...params);
}

function getTasksToday(userId) {
  const today = new Date().toISOString().split('T')[0];
  return db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.due_date = ? AND t.status != 'deleted'
    ORDER BY t.created_at DESC
  `).all(userId, today);
}

function getTasksByPlan(userId, planId) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.plan_id = ? AND t.status != 'deleted'
    ORDER BY t.created_at DESC
  `).all(userId, planId);
}

function updateTask(id, fields) {
  const allowed = ['title', 'description', 'status', 'priority', 'category_id', 'plan_id', 'due_date', 'notion_page_id', 'waiting_reason', 'waiting_until'];
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
    SELECT t.*, c.name AS category_name, p.title AS plan_title
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN plans p ON p.id = t.plan_id
    WHERE t.user_id = ? AND t.status != 'deleted' AND (t.notion_page_id IS NULL OR t.notion_page_id = '')
  `).all(userId);
}

module.exports = { createTask, getTaskById, getTasks, getTasksToday, getTasksByPlan, updateTask, deleteTask, getUnsyncedTasks };
