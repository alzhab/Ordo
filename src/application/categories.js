const categoryRepo = require('../infrastructure/db/repositories/categoryRepository');
const { ensureUser } = require('../infrastructure/db/repositories/userRepository');

const {
  getCategories,
  getCategoryNames,
  getCategoryByName,
  createCategory,
  getCategoryTaskCount,
  deleteCategory,
  PRIORITY_MAP,
  PRIORITY_LABEL,
} = categoryRepo;

module.exports = {
  ensureUser,
  getCategories,
  getCategoryNames,
  getCategoryByName,
  createCategory,
  getCategoryTaskCount,
  deleteCategory,
  PRIORITY_MAP,
  PRIORITY_LABEL,
};
