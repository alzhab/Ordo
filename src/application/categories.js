const categoryRepo = require('../infrastructure/db/repositories/categoryRepository');
const { ensureUser } = require('../infrastructure/db/repositories/userRepository');

const {
  getCategories,
  getCategoryNames,
  getCategoryByName,
  createCategory,
  getCategoryTaskCount,
  deleteCategory,
} = categoryRepo;

module.exports = {
  ensureUser,
  getCategories,
  getCategoryNames,
  getCategoryByName,
  createCategory,
  getCategoryTaskCount,
  deleteCategory,
};
