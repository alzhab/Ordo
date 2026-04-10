const subtaskRepo = require('../infrastructure/db/repositories/subtaskRepository');

const {
  getSubtasks,
  getSubtaskById,
  createSubtask,
  createSubtasks,
  updateSubtask,
  toggleSubtask,
  deleteSubtask,
  deleteAllSubtasks,
} = subtaskRepo;

module.exports = {
  getSubtasks,
  getSubtaskById,
  createSubtask,
  createSubtasks,
  updateSubtask,
  toggleSubtask,
  deleteSubtask,
  deleteAllSubtasks,
};
