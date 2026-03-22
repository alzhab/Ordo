const db = require('./db');

const DEFAULT_CATEGORIES = ['Общее', 'Работа', 'Дом', 'Здоровье', 'Инвестиции'];

const PRIORITY_MAP = {
  'Высокий': 'high',
  'Средний': 'medium',
  'Низкий':  'low',
  'high':    'high',
  'medium':  'medium',
  'low':     'low',
};

const PRIORITY_LABEL = {
  'high':   'Высокий',
  'medium': 'Средний',
  'low':    'Низкий',
};

function ensureUser(userId, username) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(userId, username ?? null);
    seedDefaultCategories(userId);
  }
}

function seedDefaultCategories(userId) {
  const insert = db.prepare('INSERT OR IGNORE INTO categories (user_id, name) VALUES (?, ?)');
  for (const name of DEFAULT_CATEGORIES) {
    insert.run(userId, name);
  }
}

function getCategories(userId) {
  return db.prepare('SELECT id, name, color FROM categories WHERE user_id = ? ORDER BY id').all(userId);
}

function getCategoryNames(userId) {
  return getCategories(userId).map(c => c.name);
}

function getCategoryByName(userId, name) {
  return db.prepare('SELECT * FROM categories WHERE user_id = ? AND name = ?').get(userId, name);
}

function createCategory(userId, name, color = null) {
  const result = db.prepare('INSERT OR IGNORE INTO categories (user_id, name, color) VALUES (?, ?, ?)').run(userId, name, color);
  if (result.changes === 0) return getCategoryByName(userId, name);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
}

function getCategoryTaskCount(categoryId) {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE category_id = ? AND status != 'deleted'"
  ).get(categoryId);
  return row?.cnt ?? 0;
}

function deleteCategory(id) {
  db.prepare('UPDATE tasks SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

module.exports = { ensureUser, getCategories, getCategoryNames, getCategoryByName, createCategory, getCategoryTaskCount, deleteCategory, PRIORITY_MAP, PRIORITY_LABEL };
