const goalRepo = require('../infrastructure/db/repositories/goalRepository');

const {
  createGoal,
  getGoals,
  getGoalById,
  getGoalByTitle,
  getGoalsWithProgress,
  getTasksByGoal,
  updateGoal,
  archiveGoal,
  deleteGoal,
  getArchivedGoals,
  restoreGoal,
} = goalRepo;

module.exports = {
  createGoal,
  getGoals,
  getGoalById,
  getGoalByTitle,
  getGoalsWithProgress,
  getTasksByGoal,
  updateGoal,
  archiveGoal,
  deleteGoal,
  getArchivedGoals,
  restoreGoal,
};
