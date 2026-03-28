// src/planService.js - backwards compat shim
const goalService = require('./goalService');
module.exports = {
  createPlan: goalService.createGoal,
  getPlans: goalService.getGoals,
  getPlansWithProgress: goalService.getGoalsWithProgress,
  getTasksByPlan: goalService.getTasksByGoal,
  getPlanById: goalService.getGoalById,
  getPlanByTitle: goalService.getGoalByTitle,
  updatePlan: goalService.updateGoal,
  archivePlan: goalService.archiveGoal,
  deletePlan: goalService.deleteGoal,
  getArchivedPlans: goalService.getArchivedGoals,
  restorePlan: goalService.restoreGoal,
};
