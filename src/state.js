// Общее состояние в памяти (per-user, сбрасывается при рестарте бота)

const pendingTasks = new Map();    // userId → pending state object
const taskFilters = new Map();     // userId → active filter object
const taskPlanContext = new Map(); // userId → planId (когда задача открыта из плана)
const processingUsers = new Set(); // userId — защита от двойного тапа

function getFilter(userId) {
  if (!taskFilters.has(userId)) {
    taskFilters.set(userId, {});
  }
  return taskFilters.get(userId);
}

// Возвращает true если можно выполнить, false если уже идёт обработка
function acquireProcessing(userId) {
  if (processingUsers.has(userId)) return false;
  processingUsers.add(userId);
  return true;
}

function releaseProcessing(userId) {
  processingUsers.delete(userId);
}

module.exports = { pendingTasks, taskFilters, getFilter, taskPlanContext, acquireProcessing, releaseProcessing };
