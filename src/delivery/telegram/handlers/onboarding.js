const { Markup } = require('telegraf');
const { getUser, safeEdit } = require('../../../shared/helpers');
const { pendingTasks } = require('../../../shared/state');
const { updateSettings } = require('../../../application/settings');

async function startOnboarding(ctx) {
  const userId    = ctx.from.id;
  const firstName = ctx.from.first_name ?? 'друг';

  const state = pendingTasks.get(userId) ?? {};
  delete state.onboarding;
  pendingTasks.set(userId, state);

  await ctx.reply(
    `👋 Привет, ${firstName}!\n\n` +
    `Я — *Ordo*. Записываю задачи голосом и текстом, слежу чтобы ничего не забылось.\n\n` +
    `Покажу как это работает — займёт минуту.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('▶️ Начать', 'onb_start')]]),
    }
  );
}

async function showOnboardingTimeStep(ctx, taskTitle) {
  await ctx.reply(
    `✅ *${taskTitle}* — сохранено!\n\n` +
    `📅 *Почти готово*\n\n` +
    `Каждое утро пришлю план на день — список задач и что делать первым.\n\n` +
    `Когда присылать?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('08:00', 'onb_time_08'),
          Markup.button.callback('09:00', 'onb_time_09'),
          Markup.button.callback('10:00', 'onb_time_10'),
        ],
        [Markup.button.callback('⚙️ Другое время', 'onb_time_other')],
      ]),
    }
  );
}

const DONE_TEXT = (time) =>
  `✅ *Готово!* Ordo настроен.\n\n` +
  `📋 Буду присылать план в *${time}*.\n\n` +
  `Просто пиши или говори задачи — я всё запишу.\n\n` +
  `/plan — план на сегодня\n` +
  `/tasks — все задачи\n` +
  `/review — разбор зависших`;

function register(bot) {
  // Шаг 1: показать приглашение написать задачу
  bot.action('onb_start', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.onboarding = { step: 'waiting_task' };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx,
      `📝 *Шаг 1 из 2*\n\n` +
      `Напиши или скажи любую задачу прямо сейчас.\n\n` +
      `_Например: "Позвонить маме", "Купить молоко", "Оплатить счёт за квартиру"_`,
      { parse_mode: 'Markdown' }
    );
  });

  // Шаг 2 вариант А: выбрать время из кнопок
  bot.action(/^onb_time_(08|09|10)$/, async (ctx) => {
    const userId = getUser(ctx);
    const time   = `${ctx.match[1]}:00`;
    updateSettings(userId, { plan_time: time });
    await ctx.answerCbQuery();
    await safeEdit(ctx, DONE_TEXT(time), { parse_mode: 'Markdown' });
  });

  // Шаг 2 вариант Б: ввести время вручную
  bot.action('onb_time_other', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.onboarding = { step: 'waiting_time' };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx,
      `Напиши удобное время:\n_Например: "8:30", "7 утра", "11:00"_`,
      { parse_mode: 'Markdown' }
    );
  });

  // Обратная совместимость — старая кнопка из /start
  bot.action('onb_settings', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    const { buildSettingsText, buildSettingsKeyboard } = require('./settings');
    await ctx.reply(buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  });
}

module.exports = { register, startOnboarding, showOnboardingTimeStep, DONE_TEXT };
