// src/handlers/plans.js - backwards compat shim
const goals = require('./goals');
module.exports = {
  register: goals.register,
  syncNewPlanToNotion: goals.syncNewPlanToNotion,
  syncNewGoalToNotion: goals.syncNewGoalToNotion,
  replyWithPlansList: goals.replyWithPlansList,
  replyWithGoalsList: goals.replyWithGoalsList,
};
