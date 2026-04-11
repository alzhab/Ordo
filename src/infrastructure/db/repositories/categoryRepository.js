const db = require('../connection');

// Категории создаваемые по умолчанию для каждого нового пользователя.
// Экспортируется для использования в userRepository при первом входе.
const DEFAULT_CATEGORIES = ['Общее', 'Работа', 'Дом', 'Здоровье', 'Инвестиции'];


function getCategories(userId) {
  return db.prepare('SELECT id, name, color FROM categories WHERE user_id = ? ORDER BY id').all(userId);
}

function getCategoryNames(userId) {
  return getCategories(userId).map(c => c.name);
}

function getCategoryByName(userId, name) {
  return db.prepare('SELECT * FROM categories WHERE user_id = ? AND name = ?').get(userId, name);
}

// INSERT OR IGNORE — если категория уже существует, возвращает существующую.
// Используется в application/tasks.createTask для авто-создания категории по имени.
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

// При удалении категории задачи открепляются (category_id = NULL), не удаляются
function deleteCategory(id) {
  db.prepare('UPDATE tasks SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

module.exports = {
  DEFAULT_CATEGORIES,
  getCategories,
  getCategoryNames,
  getCategoryByName,
  createCategory,
  getCategoryTaskCount,
  deleteCategory,
};
