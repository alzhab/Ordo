// Webhook handler для навыка Яндекс Алисы.
// POST /alice — принимает запросы от платформы Яндекс Диалоги.
//
// Поддерживаемые команды:
//   - Привязка аккаунта (6-значный код из Telegram)
//   - Создание задачи (любой текст → AI parser)
//   - Список задач («мои задачи», «задачи», «что есть»)
//   - Задачи на сегодня («план», «план на сегодня»)
//   - Отметить задачу выполненной («задача N готова», «отметь N»)
//   - Помощь («помощь», «что ты умеешь»)

const { ALICE_SKILL_TOKEN } = require('../../shared/config');
const { aliceLinkCodes }    = require('../../shared/state');
const { findByAliceUserId, setAliceUserId } = require('../../infrastructure/db/repositories/userRepository');
const { parseIntent }       = require('../../infrastructure/ai/parser');
const { saveTask, getTasks, getTaskByNumber, updateTask } = require('../../application/tasks');
const { getCategoryNames }  = require('../../application/categories');
const { getGoalsWithProgress } = require('../../application/goals');
const { getSettings }       = require('../../application/settings');

// ─── Helpers ─────────────────────────────────────────────

function respond(res, text, endSession = false, sessionState = {}) {
  const body = JSON.stringify({
    response:      { text, end_session: endSession },
    session_state: sessionState,
    version:       '1.0',
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end',  () => {
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── Простые команды (без AI) ─────────────────────────────

const HELP_TEXT =
  'Вы можете: сказать задачу — и я запишу. ' +
  'Спросить "мои задачи" — покажу список. ' +
  'Сказать "план на сегодня" — задачи на сегодня. ' +
  'Сказать "задача 3 выполнена" — отмечу как готовую.';

function formatTaskList(tasks, header) {
  if (!tasks.length) return `${header}: задач нет.`;
  const lines = tasks.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}`);
  const suffix = tasks.length > 5 ? ` И ещё ${tasks.length - 5}.` : '';
  return `${header}: ${lines.join('. ')}.${suffix}`;
}

// ─── Обработка AI intent после parseIntent ────────────────

async function executeAliceIntent(res, userId, parsed) {
  switch (parsed.intent) {
    case 'create_task': {
      const task = saveTask(userId, parsed);
      return respond(res, `Задача записана: ${task.title}`);
    }

    case 'create_tasks_batch': {
      const created = (parsed.tasks ?? []).map(t => saveTask(userId, t));
      if (!created.length) return respond(res, 'Не удалось разобрать задачи. Попробуйте ещё раз.');
      const titles = created.map(t => t.title).join(', ');
      return respond(res, `Записал ${created.length} задачи: ${titles}.`);
    }

    case 'manage_task': {
      const task = parsed.task_number
        ? getTaskByNumber(userId, parsed.task_number)
        : null;
      if (!task) return respond(res, 'Задача не найдена. Уточните номер.');
      if (parsed.action === 'update_status' && parsed.status === 'done') {
        updateTask(task.id, { status: 'done' }, userId);
        return respond(res, `Отлично! Задача выполнена: ${task.title}.`);
      }
      if (parsed.action === 'delete') {
        updateTask(task.id, { status: 'deleted' }, userId);
        return respond(res, `Задача удалена: ${task.title}.`);
      }
      return respond(res, `Понял. Задача ${task.title} обновлена.`);
    }

    case 'query_tasks': {
      const filter = {};
      if (parsed.date === 'today') filter.plannedToday = true;
      const tasks = getTasks(userId, filter);
      return respond(res, formatTaskList(tasks, 'Ваши задачи'));
    }

    case 'open_plan': {
      const todayStr = new Date().toISOString().slice(0, 10);
      const date = parsed.date ?? todayStr;
      const tasks = getTasks(userId, { plannedToday: date === todayStr });
      const header = date === todayStr ? 'На сегодня' : `На ${date}`;
      return respond(res, formatTaskList(tasks, header));
    }

    default:
      return respond(res, 'Понял. Но эта команда пока не поддерживается через Алису. Попробуйте в Telegram.');
  }
}

// ─── Главный обработчик ───────────────────────────────────

async function handleAlice(req, res) {
  // Валидация токена навыка (если задан в env)
  if (ALICE_SKILL_TOKEN) {
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `OAuth ${ALICE_SKILL_TOKEN}`) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
  }

  let body;
  try {
    body = await parseBody(req);
  } catch {
    res.writeHead(400); res.end('Bad Request');
    return;
  }

  const aliceUserId    = body.session?.user?.user_id;
  const isNewSession   = body.session?.new ?? false;
  const command        = (body.request?.command ?? '').trim().toLowerCase();
  const utterance      = (body.request?.original_utterance ?? command).trim();
  const sessionState   = body.state?.session ?? {};

  if (!aliceUserId) {
    return respond(res, 'Ошибка: не удалось определить пользователя.', true);
  }

  // Выход из навыка
  if (/^(стоп|пока|хватит|выход|закрыть|закрой|до свидания)/.test(command)) {
    return respond(res, 'Пока! Обращайся когда нужно.', true);
  }

  const user = findByAliceUserId(aliceUserId);

  // ── Аккаунт не привязан ──────────────────────────────────
  if (!user) {
    if (sessionState.awaitingCode) {
      const codeMatch = command.replace(/\s/g, '').match(/\d{6}/);
      if (codeMatch) {
        const code    = codeMatch[0];
        const entry   = aliceLinkCodes.get(code);
        if (entry && Date.now() < entry.expiresAt) {
          aliceLinkCodes.delete(code);
          setAliceUserId(entry.userId, aliceUserId);
          return respond(res,
            'Отлично! Аккаунт Telegram привязан. Теперь говорите задачи — я запишу.',
            false,
            { awaitingCode: false }
          );
        }
        return respond(res,
          'Код не найден или истёк срок. Получите новый код в боте Ordo и назовите его.',
          false,
          { awaitingCode: true }
        );
      }
      return respond(res,
        'Пожалуйста, назовите шестизначный код из Telegram.',
        false,
        { awaitingCode: true }
      );
    }

    return respond(res,
      'Добро пожаловать в Орdo! Чтобы начать, откройте бота Орdo в Телеграм, ' +
      'нажмите на кнопку «Привязать Алису» в настройках, ' +
      'затем назовите мне шестизначный код.',
      false,
      { awaitingCode: true }
    );
  }

  // ── Аккаунт привязан ────────────────────────────────────
  const userId = user.id;

  if (isNewSession) {
    const tasks = getTasks(userId, {});
    const hint  = tasks.length > 0
      ? `У вас ${tasks.length} активных задач.`
      : 'Задач пока нет.';
    return respond(res, `Привет! Я Орdo. ${hint} Говорите задачу или спросите «мои задачи».`);
  }

  if (/^помощь|что ты умеешь/.test(command)) {
    return respond(res, HELP_TEXT);
  }

  if (/^(мои задачи|задачи|покажи задачи|что есть|что у меня|список задач|все задачи)/.test(command)) {
    const tasks = getTasks(userId, {});
    return respond(res, formatTaskList(tasks, 'Ваши задачи'));
  }

  if (/^(план|план на сегодня|задачи на сегодня|что на сегодня)/.test(command)) {
    const tasks = getTasks(userId, { plannedToday: true });
    return respond(res, formatTaskList(tasks, 'На сегодня'));
  }

  // «задача 5 готова» / «отметь 5» / «5 готова»
  const doneMatch = command.match(/задача\s+(\d+)\s+(готова|выполнена|сделана|готово)|отметь\s+(\d+)|(\d+)\s+(готова|выполнена|сделана|готово)/);
  if (doneMatch) {
    const num  = parseInt(doneMatch[1] ?? doneMatch[3] ?? doneMatch[4], 10);
    const task = getTaskByNumber(userId, num);
    if (!task) return respond(res, `Задача с номером ${num} не найдена.`);
    updateTask(task.id, { status: 'done' }, userId);
    return respond(res, `Отлично! Задача выполнена: ${task.title}.`);
  }

  // Всё остальное → AI parser
  try {
    const settings   = getSettings(userId);
    const categories = getCategoryNames(userId);
    const goals      = getGoalsWithProgress(userId).map(g => g.title);
    const parsed     = await parseIntent(utterance, categories, goals, settings.timezone);
    return await executeAliceIntent(res, userId, parsed);
  } catch (e) {
    console.error('[alice] parseIntent error:', e.message);
    return respond(res, 'Не понял. Попробуйте сказать иначе.');
  }
}

module.exports = { handleAlice };
