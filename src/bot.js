const { Telegraf, Markup } = require('telegraf');
const { TELEGRAM_BOT_TOKEN } = require('./config');
const { getUser } = require('./helpers');

// Однократное восстановление данных
if (process.env.RUN_RESTORE === 'true') {
  try {
    const db = require('./db');
    const ins_u = db.prepare('INSERT OR IGNORE INTO users (id, username, created_at) VALUES (?, ?, ?)');
    const ins_c = db.prepare('INSERT OR IGNORE INTO categories (id, user_id, name, color) VALUES (?, ?, ?, ?)');
    const ins_t = db.prepare('INSERT OR IGNORE INTO tasks (id, user_id, title, description, status, priority, category_id, plan_id, due_date, notion_page_id, waiting_reason, waiting_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const ins_s = db.prepare('INSERT OR IGNORE INTO subtasks (id, task_id, title, is_done, position, notion_block_id) VALUES (?, ?, ?, ?, ?, ?)');
    ins_u.run(426892086, "abdAlzB", "2026-03-16 09:55:57");
    ins_c.run(1, 426892086, "Общее", null);
    ins_c.run(3, 426892086, "Дом", null);
    ins_c.run(4, 426892086, "Здоровье", null);
    ins_c.run(8, 426892086, "Спорт", null);
    ins_t.run(39, 426892086, "Положить часть суммы на карту для покупки колец", "Пополнить карту, чтобы иметь возможность купить кольца для приложения", "not_started", "medium", 1, null, "2026-03-17", "325939ac-3f4c-819b-bcb9-fd1a386cf3bb", null, null, "2026-03-16 15:05:08", "2026-03-16 15:05:09");
    ins_t.run(49, 426892086, "Купить пылесос для дома", "Выбрать и купить пылесос с учётом характеристик, бюджета и способа покупки.", "in_progress", "medium", 3, null, null, "326939ac-3f4c-813c-850b-d486a6deb257", null, null, "2026-03-17 05:51:10", "2026-03-17 09:27:44");
    ins_t.run(59, 426892086, "Купить Dyson выпрямитель волос для Жанели", "Подарок на день рождения или просто так — Dyson выпрямитель волос", "not_started", "medium", 1, null, null, "326939ac-3f4c-81d1-9866-c84b64862d11", null, null, "2026-03-17 09:34:20", "2026-03-17 09:34:22");
    ins_t.run(60, 426892086, "Купить серёжки для Жанели", "Серёжки уже выбраны, купить как сюрприз", "not_started", "medium", 1, null, null, "326939ac-3f4c-817f-9417-e83edd8300ab", null, null, "2026-03-17 09:34:57", "2026-03-17 09:35:13");
    ins_t.run(61, 426892086, "Обновить подписку на телеграм Манга Бота", null, "not_started", "medium", 1, null, "2026-05-20", "326939ac-3f4c-8159-926d-d3c8a8e3a536", null, null, "2026-03-17 09:37:46", "2026-03-17 09:38:03");
    ins_t.run(68, 426892086, "Обсуждение свадебного предложения с семьёй Жанели", "21 марта мама Жанели обсуждает с родственниками. 25-28 марта приезжают родители.", "not_started", "high", 1, null, "2026-03-25", "326939ac-3f4c-8115-872a-d47bbd27b4e8", null, null, "2026-03-17 10:15:01", "2026-03-17 10:15:03");
    ins_t.run(76, 426892086, "Операция коррекции зрения для Жанели", null, "not_started", null, 4, null, null, "327939ac-3f4c-81e3-8eb7-eda1b9b15491", null, null, "2026-03-18 07:35:05", "2026-03-18 07:35:06");
    ins_t.run(77, 426892086, "Курс лечения очищения миндалин у АС Мироновой в ЛОР-практикум", "Приём в 11:10. Курс лечения/очищения миндалин.", "waiting", null, 4, null, "2026-03-23", "327939ac-3f4c-813d-86da-f642a1d5e22b", "Жду следующего понедельника.", "2026-03-23", "2026-03-18 07:36:13", "2026-03-21 09:13:57");
    ins_t.run(88, 426892086, "Купить вешалки", null, "waiting", null, 3, null, null, "32a939ac-3f4c-8178-9a92-cf6c57bbce18", "22 марта нужно забрать вешалки с Wildberries", "2026-03-21", "2026-03-21 09:03:12", "2026-03-21 09:03:25");
    ins_s.run(32, 49, "Определить требования: тип пылесоса, мощность, фильтрация", 0, 0, "326939ac-3f4c-818c-8807-d3da0750aa9c");
    ins_s.run(33, 49, "Изучить характеристики и сравнить популярные модели", 0, 1, "326939ac-3f4c-8176-ab80-c9a12acfcceb");
    ins_s.run(34, 49, "Обсудить с женой выбор модели и бюджет", 0, 2, "326939ac-3f4c-81fb-a9e1-d64ed8d807bb");
    ins_s.run(35, 49, "Сравнить цены на Kaspi, Freedom и других площадках", 0, 3, "326939ac-3f4c-81c1-af83-e5f7a0a960cc");
    ins_s.run(36, 49, "Решить способ покупки: онлайн-заказ или поход в магазин", 0, 4, "326939ac-3f4c-8199-9af8-fe0c480b668f");
    ins_s.run(37, 49, "Оформить покупку", 0, 5, "326939ac-3f4c-8125-80cf-ce60e6a567f1");
    ins_s.run(69, 59, "Выбрать модель Dyson выпрямителя волос", 0, 0, "326939ac-3f4c-8178-a407-d788e82d3f76");
    ins_s.run(70, 59, "Сравнить цены в магазинах и онлайн", 0, 1, "326939ac-3f4c-81eb-a6b7-c7d6fcfaec22");
    ins_s.run(71, 59, "Оформить заказ или купить в магазине", 0, 2, "326939ac-3f4c-81d9-ac94-cf79c41859a9");
    ins_s.run(72, 59, "Упаковать и подготовить подарок", 0, 3, "326939ac-3f4c-81b8-98da-c8e750183384");
    ins_s.run(73, 60, "Уточнить когда планируется подарить серёжки", 0, 0, "326939ac-3f4c-818e-bfbe-ce190f2536a5");
    ins_s.run(74, 60, "Найти магазин или сайт с выбранными серёжками", 0, 1, "326939ac-3f4c-81a7-a6b6-db37132d313b");
    ins_s.run(75, 60, "Оформить заказ или купить в магазине", 0, 2, "326939ac-3f4c-81d2-a583-c853a755ece8");
    ins_s.run(76, 60, "Упаковать серёжки в подарочную коробку", 0, 3, "326939ac-3f4c-8140-ad66-c42fb1824c8e");
    ins_s.run(77, 60, "Выбрать подходящий момент и подарить Жанеле", 0, 4, "326939ac-3f4c-8152-9ece-d65b2c2ee090");
    ins_s.run(98, 68, "21 марта: мама Жанели обсуждает предложение с родственниками", 0, 0, "326939ac-3f4c-81dd-bbf3-db6ea98a5c49");
    ins_s.run(99, 68, "Подготовиться к приезду родителей (25 марта)", 0, 1, "326939ac-3f4c-81c7-aa1a-cbf743143cd3");
    ins_s.run(100, 68, "25-28 марта: встреча родителей с семьёй Жанели", 0, 2, "326939ac-3f4c-8127-9d41-f8a888879a9c");
    ins_s.run(101, 68, "Согласовать детали обсуждения между семьями", 0, 3, "326939ac-3f4c-8151-b3d7-e3ce42e6a97b");
    ins_s.run(127, 76, "Пройти консультацию у офтальмолога", 0, 0, "327939ac-3f4c-81da-9d64-d83b6b11d8e2");
    ins_s.run(128, 76, "Выбрать клинику и метод коррекции (LASIK, LASEK, ReLEx SMILE)", 0, 1, "327939ac-3f4c-81b7-9b59-ef91ddc1f426");
    ins_s.run(129, 76, "Пройти предоперационное обследование", 0, 2, "327939ac-3f4c-81c3-aa3c-d351e1642eb5");
    ins_s.run(130, 76, "Провести операцию и соблюдать режим восстановления", 0, 3, "327939ac-3f4c-8108-9308-f03c07aef673");
    ins_s.run(131, 76, "Пройти контрольные осмотры через 1 день, 1 неделю и 1 месяц", 0, 4, "327939ac-3f4c-813c-9342-e05ef53d70eb");
    console.log('✅ Данные восстановлены');
  } catch (e) {
    console.error('❌ Ошибка восстановления:', e.message);
  }
}
const { isConfigured: notionConfigured } = require('./integrations/notion');
const { buildSettingsText, buildSettingsKeyboard } = require('./handlers/settings');

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ─── Команды ─────────────────────────────────────────────

bot.start((ctx) => {
  getUser(ctx);
  ctx.reply(
    'Привет! 👋 Я помогу создавать задачи.\n\n' +
    'Отправь голосовое сообщение или напиши задачу текстом.\n\n' +
    'Пример: «Купить провод для ремонта, категория дом, срок эти выходные»\n\n' +
    '/tasks — список задач\n' +
    '/today — задачи на сегодня'
  );
});

bot.help((ctx) => {
  ctx.reply(
    'Как пользоваться:\n\n' +
    '1. Отправь голосовое или текстовое сообщение с задачей\n' +
    '2. Я покажу превью — проверь и подтверди\n' +
    '3. Задача сохранится локально' +
    (notionConfigured() ? ' и синхронизируется с Notion' : '') + '\n\n' +
    '/tasks — список активных задач\n' +
    '/today — задачи на сегодня\n' +
    '/add — добавить задачу'
  );
});

bot.command('settings', (ctx) => {
  getUser(ctx);
  ctx.reply(buildSettingsText(), { parse_mode: 'Markdown', ...buildSettingsKeyboard() });
});

// /add — явная команда добавить задачу
bot.command('add', (ctx) => {
  const text = ctx.message.text.replace('/add', '').trim();
  if (!text) return ctx.reply('Напиши задачу после команды: /add Купить молоко');
  const { handleText } = require('./handlers/intent');
  handleText(ctx, text);
});

// ─── Глобальный обработчик ошибок ────────────────────────

bot.catch((err, ctx) => {
  console.error(`[bot.catch] update=${ctx?.update?.update_id}`, err);
  ctx?.reply('⚠️ Что-то пошло не так. Попробуй ещё раз.').catch(() => {});
});

// ─── Регистрация обработчиков ─────────────────────────────

require('./handlers/tasks').register(bot);
require('./handlers/plans').register(bot);
require('./handlers/subtasks').register(bot);
require('./handlers/settings').register(bot);
require('./handlers/assistant').register(bot);
require('./handlers/intent').register(bot);

// ─── Запуск ───────────────────────────────────────────────

bot.launch().then(() => {
  console.log('Бот запущен!');
  bot.telegram.setMyCommands([
    { command: 'add',      description: 'Добавить задачу' },
    { command: 'tasks',    description: 'Список задач' },
    { command: 'today',    description: 'Задачи на сегодня' },
    { command: 'plans',    description: 'Планы' },
    { command: 'morning',  description: 'План на день' },
    { command: 'review',   description: 'Вечерний разбор' },
    { command: 'focus',    description: 'Что делать прямо сейчас' },
    { command: 'progress', description: 'Прогресс' },
    { command: 'settings', description: 'Настройки и интеграции' },
    { command: 'help',     description: 'Помощь' },
  ]);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
