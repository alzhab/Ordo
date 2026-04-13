// In-memory состояние диалога — по одному объекту на пользователя.
// Сбрасывается при рестарте бота. Хранит только временное UI-состояние;
// всё постоянное (задачи, настройки) живёт в БД.

// Универсальный контейнер диалогового состояния.
// Один объект на пользователя, shape зависит от текущего сценария:
//
//   Создание одной задачи (ожидание confirm):
//     { task: ParsedTask, planId: number|null }
//
//   Пакетное создание задач (батч):
//     { tasks: ParsedTask[], currentIndex: number, created: number, skipped: number }
//
//   Редактирование сохранённой задачи:
//     { task: Task, editingField: 'title'|'description'|'planned_for'|...|null }
//
//   Редактирование подзадачи:
//     { subtaskId: number, editingField: 'title' }
//
//   Создание цели:
//     { creatingPlan: true, planData?: object, editingField: string|null }
//
//   Редактирование цели:
//     { plan: Goal, editingField: string|null }
//
// После завершения сценария запись удаляется через pendingTasks.delete(userId).
const pendingTasks = new Map();

// Активный фильтр списка задач для /tasks.
// Shape: { status?: string, category?: string, goalId?: number, search?: string }
// Персистируется между сообщениями — пользователь видит тот же фильтр
// пока явно не изменит его или не выйдет из списка.
const taskFilters = new Map();

// Запоминает из какого плана (goal) открыт список задач.
// userId → goalId (number)
// Нужен чтобы при создании задачи прямо из плана автоматически
// привязать её к этому плану (goal_id) без лишних вопросов.
const taskPlanContext = new Map();

// Слайдер для просмотра задач из /tasks.
// userId → { taskIds: number[], index: number }
const taskSliders = new Map();

// Mutex: userId которых сейчас обрабатывает бот.
// Защищает от двойного тапа по inline-кнопке — Telegram иногда шлёт
// один callback дважды если сервер отвечает медленно.
// Используй acquireProcessing / releaseProcessing вокруг тяжёлых операций.
const processingUsers = new Set();

// Возвращает текущий фильтр пользователя, создавая пустой если его нет.
function getFilter(userId) {
  if (!taskFilters.has(userId)) {
    taskFilters.set(userId, {});
  }
  return taskFilters.get(userId);
}

// Захватывает блокировку для userId.
// Возвращает true если можно продолжать, false если обработка уже идёт.
// Всегда вызывай releaseProcessing в finally-блоке.
function acquireProcessing(userId) {
  if (processingUsers.has(userId)) return false;
  processingUsers.add(userId);
  return true;
}

function releaseProcessing(userId) {
  processingUsers.delete(userId);3
}

module.exports = { pendingTasks, taskFilters, getFilter, taskPlanContext, taskSliders, acquireProcessing, releaseProcessing };
