const db = require('../connection');

function createGoal(userId, { title, description = null }) {
  const result = db.prepare(
    'INSERT INTO goals (user_id, title, description) VALUES (?, ?, ?)'
  ).run(userId, title, description);
  return getGoalById(result.lastInsertRowid);
}

// Только активные цели (status != 'archived')
function getGoals(userId) {
  return db.prepare(
    "SELECT * FROM goals WHERE user_id = ? AND status != 'archived' ORDER BY created_at DESC"
  ).all(userId);
}

function getGoalById(id) {
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
}

// LIKE поиск по подстроке — используется в application/tasks.createTask
// когда пользователь называет цель текстом ("свадьба") а не id
function getGoalByTitle(userId, title) {
  return db.prepare(
    'SELECT * FROM goals WHERE user_id = ? AND title LIKE ?'
  ).get(userId, `%${title}%`);
}

// Whitelist полей — защита от случайного обновления произвольных колонок
function updateGoal(id, fields) {
  const allowed     = ['title', 'description', 'status', 'notion_page_id'];
  const allowedKeys = Object.keys(fields).filter(k => allowed.includes(k));
  if (allowedKeys.length === 0) return getGoalById(id);

  const updates = allowedKeys.map(k => `${k} = ?`);
  const values  = allowedKeys.map(k => fields[k]);

  db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return getGoalById(id);
}

function archiveGoal(id) {
  return updateGoal(id, { status: 'archived' });
}

// Возвращает цели с агрегированными счётчиками задач.
// total — все задачи кроме deleted, done — только выполненные.
// Используется в /plan (getPlanRecommendations) для контекста AI.
function getGoalsWithProgress(userId) {
  return db.prepare(`
    SELECT g.*,
      COUNT(t.id) AS total,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
    FROM goals g
    LEFT JOIN tasks t ON t.goal_id = g.id AND t.status != 'deleted'
    WHERE g.user_id = ? AND g.status != 'archived'
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `).all(userId);
}

// Запрашивает tasks из репозитория goals — удобно для рендера страницы цели
// где нужно показать все задачи без userId (goalId уже привязан к пользователю)
function getTasksByGoal(goalId) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.goal_id = ? AND t.status != 'deleted'
    ORDER BY t.status, t.created_at DESC
  `).all(goalId);
}

// withTasks = true → задачи цели тоже помечаются deleted
// withTasks = false → задачи остаются но открепляются от цели (goal_id = NULL)
function deleteGoal(id, withTasks = false) {
  if (withTasks) {
    db.prepare("UPDATE tasks SET status = 'deleted', goal_id = NULL WHERE goal_id = ?").run(id);
  } else {
    db.prepare('UPDATE tasks SET goal_id = NULL WHERE goal_id = ?').run(id);
  }
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
}

function getArchivedGoals(userId) {
  return db.prepare(
    "SELECT * FROM goals WHERE user_id = ? AND status = 'archived' ORDER BY created_at DESC"
  ).all(userId);
}

function restoreGoal(id) {
  return updateGoal(id, { status: 'active' });
}

module.exports = {
  createGoal,
  getGoals,
  getGoalsWithProgress,
  getTasksByGoal,
  getGoalById,
  getGoalByTitle,
  updateGoal,
  archiveGoal,
  deleteGoal,
  getArchivedGoals,
  restoreGoal,
};
