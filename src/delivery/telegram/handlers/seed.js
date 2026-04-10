// Тестовые данные для ручного тестирования функционала.
// /seed  — создаёт набор задач покрывающих все сценарии
// /unseed — удаляет все задачи с категорией "🧪 Тест"

const { getUser } = require('../../../shared/helpers');
const { createTask } = require('../../../application/tasks');
const { getCategoryByName } = require('../../../application/categories');
const { createSubtasks } = require('../../../application/subtasks');
const db = require('../../../infrastructure/db/connection');

const SEED_CATEGORY = '🧪 Тест';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

async function handleSeed(ctx) {
  const userId = getUser(ctx);
  const today  = daysFromNow(0);
  const cat    = SEED_CATEGORY;
  const msg    = await ctx.reply('⏳ Создаю тестовые задачи...');

  const tasks = [
    // Inbox — todo без даты, только что создана
    { title: 'Записаться к стоматологу', status: 'todo', category: cat },

    // Inbox — todo без даты, создана 5 дней назад (поднимется в /review)
    { title: 'Разобрать шкаф', status: 'todo', category: cat, _created_ago: 5 },

    // В плане на сегодня
    { title: 'Написать отчёт за неделю', status: 'todo', planned_for: today, category: cat },

    // В плане на завтра
    { title: 'Позвонить маме', status: 'todo', planned_for: daysFromNow(1), category: cat },

    // Waiting с истёкшей датой (поднимется в /review)
    { title: 'Жду ответа от HR', status: 'waiting', waiting_reason: 'Ждал оффер', waiting_until: daysAgo(2), category: cat },

    // Waiting без даты, создана 4 дня назад (поднимется в /review)
    { title: 'Договориться с подрядчиком', status: 'waiting', waiting_reason: 'Он должен перезвонить', category: cat, _created_ago: 4 },

    // Maybe, создана 10 дней назад (поднимется в /review)
    { title: 'Выучить испанский', status: 'maybe', category: cat, _created_ago: 10 },

    // Todo с подзадачами
    { title: 'Подготовить презентацию', status: 'todo', category: cat, _subtasks: ['Собрать данные', 'Сделать слайды', 'Прорепетировать'] },
  ];

  let created = 0;
  for (const { _created_ago, _subtasks, ...data } of tasks) {
    const task = createTask(userId, data);
    if (_subtasks) {
      createSubtasks(task.id, _subtasks);
    }
    // Сдвигаем created_at и updated_at назад если нужно для тестирования review
    if (_created_ago) {
      const date = daysAgo(_created_ago);
      db.prepare(`UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?`)
        .run(`${date} 10:00:00`, `${date} 10:00:00`, task.id);
    }
    created++;
  }

  await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
    `✅ Создано *${created}* тестовых задач с категорией *${SEED_CATEGORY}*\n\n` +
    `Что покрыто:\n` +
    `• Inbox (todo без даты)\n` +
    `• Задачи в плане на сегодня и завтра\n` +
    `• Waiting с истёкшим сроком\n` +
    `• Waiting без даты\n` +
    `• Maybe\n` +
    `• Todo с подзадачами\n\n` +
    `Удалить всё: /unseed`,
    { parse_mode: 'Markdown' }
  );
}

async function handleUnseed(ctx) {
  const userId = getUser(ctx);

  // Ищем все категории пользователя с нужным именем (диагностика)
  const allCats = db.prepare('SELECT * FROM categories WHERE user_id = ?').all(userId);
  const cat = allCats.find(c => c.name === SEED_CATEGORY);

  if (!cat) {
    const names = allCats.map(c => `"${c.name}"`).join(', ');
    return ctx.reply(`Категория не найдена.\nКатегории в БД: ${names || 'нет'}`);
  }

  const result = db.prepare(`
    UPDATE tasks SET status = 'deleted'
    WHERE user_id = ? AND category_id = ? AND status != 'deleted'
  `).run(userId, cat.id);

  ctx.reply(`🗑 Удалено *${result.changes}* тестовых задач.`, { parse_mode: 'Markdown' });
}

function register(bot) {
  bot.command('seed',   handleSeed);
  bot.command('unseed', handleUnseed);
}

module.exports = { register };
