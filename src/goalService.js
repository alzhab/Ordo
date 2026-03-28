const db = require('./db');

function createGoal(userId, { title, description = null }) {
  const result = db.prepare(
    'INSERT INTO goals (user_id, title, description) VALUES (?, ?, ?)'
  ).run(userId, title, description);
  return getGoalById(result.lastInsertRowid);
}

function getGoals(userId) {
  return db.prepare(
    "SELECT * FROM goals WHERE user_id = ? AND status != 'archived' ORDER BY created_at DESC"
  ).all(userId);
}

function getGoalById(id) {
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
}

function getGoalByTitle(userId, title) {
  return db.prepare(
    'SELECT * FROM goals WHERE user_id = ? AND title LIKE ?'
  ).get(userId, `%${title}%`);
}

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

function getTasksByGoal(goalId) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.goal_id = ? AND t.status != 'deleted'
    ORDER BY t.status, t.created_at DESC
  `).all(goalId);
}

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

module.exports = { createGoal, getGoals, getGoalsWithProgress, getTasksByGoal, getGoalById, getGoalByTitle, updateGoal, archiveGoal, deleteGoal, getArchivedGoals, restoreGoal };
