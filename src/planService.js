const db = require('./db');

function createPlan(userId, { title, description = null }) {
  const result = db.prepare(
    'INSERT INTO plans (user_id, title, description) VALUES (?, ?, ?)'
  ).run(userId, title, description);
  return getPlanById(result.lastInsertRowid);
}

function getPlans(userId) {
  return db.prepare(
    "SELECT * FROM plans WHERE user_id = ? AND status != 'archived' ORDER BY created_at DESC"
  ).all(userId);
}

function getPlanById(id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
}

function getPlanByTitle(userId, title) {
  return db.prepare(
    'SELECT * FROM plans WHERE user_id = ? AND title LIKE ?'
  ).get(userId, `%${title}%`);
}

function updatePlan(id, fields) {
  const allowed     = ['title', 'description', 'status', 'notion_page_id'];
  const allowedKeys = Object.keys(fields).filter(k => allowed.includes(k));
  if (allowedKeys.length === 0) return getPlanById(id);

  const updates = allowedKeys.map(k => `${k} = ?`);
  const values  = allowedKeys.map(k => fields[k]);

  db.prepare(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return getPlanById(id);
}

function archivePlan(id) {
  return updatePlan(id, { status: 'archived' });
}

function getPlansWithProgress(userId) {
  return db.prepare(`
    SELECT p.*,
      COUNT(t.id) AS total,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
    FROM plans p
    LEFT JOIN tasks t ON t.plan_id = p.id AND t.status != 'deleted'
    WHERE p.user_id = ? AND p.status != 'archived'
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(userId);
}

function getTasksByPlan(planId) {
  return db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM tasks t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.plan_id = ? AND t.status != 'deleted'
    ORDER BY t.status, t.created_at DESC
  `).all(planId);
}

function deletePlan(id, withTasks = false) {
  if (withTasks) {
    db.prepare("UPDATE tasks SET status = 'deleted', plan_id = NULL WHERE plan_id = ?").run(id);
  } else {
    db.prepare('UPDATE tasks SET plan_id = NULL WHERE plan_id = ?').run(id);
  }
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
}

function getArchivedPlans(userId) {
  return db.prepare(
    "SELECT * FROM plans WHERE user_id = ? AND status = 'archived' ORDER BY created_at DESC"
  ).all(userId);
}

function restorePlan(id) {
  return updatePlan(id, { status: 'active' });
}

module.exports = { createPlan, getPlans, getPlansWithProgress, getTasksByPlan, getPlanById, getPlanByTitle, updatePlan, archivePlan, deletePlan, getArchivedPlans, restorePlan };
