const { Markup } = require('telegraf');
const { getUser, normalizeWaiting, parserReminderToUtc } = require('../../../shared/helpers');
const { pendingMedia } = require('../../../shared/state');
const { saveTask } = require('../../../application/tasks');
const { addAttachment } = require('../../../infrastructure/db/repositories/attachmentRepository');
const { getSettings } = require('../../../application/settings');
const { parseIntent } = require('../../../infrastructure/ai/parser');
const { getCategoryNames } = require('../../../application/categories');
const { getGoalsWithProgress } = require('../../../application/goals');

const TYPE_LABEL = {
  photo:     '🖼 Фото',
  video:     '🎬 Видео',
  document:  '📄 Документ',
  audio:     '🎵 Аудио',
  animation: '🎞 GIF',
  sticker:   '🎭 Стикер',
  link:      '🔗 Ссылка',
};

function extractMediaFromMsg(msg) {
  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    return { type: 'photo', file_id: largest.file_id, file_name: null, url: null };
  }
  if (msg.video) {
    return { type: 'video', file_id: msg.video.file_id, file_name: msg.video.file_name ?? null, url: null };
  }
  if (msg.document) {
    return { type: 'document', file_id: msg.document.file_id, file_name: msg.document.file_name ?? null, url: null };
  }
  if (msg.audio) {
    return { type: 'audio', file_id: msg.audio.file_id, file_name: msg.audio.title ?? msg.audio.file_name ?? null, url: null };
  }
  if (msg.animation) {
    return { type: 'animation', file_id: msg.animation.file_id, file_name: null, url: null };
  }
  if (msg.sticker) {
    return { type: 'sticker', file_id: msg.sticker.file_id, file_name: null, url: null };
  }
  return null;
}

async function createTaskWithMedia(ctx, userId, title, media) {
  const tz = getSettings(userId).timezone;
  let parsed;
  try {
    const categories = getCategoryNames(userId);
    const goalNames  = getGoalsWithProgress(userId).map(g => g.title);
    parsed = await parseIntent(title, categories, goalNames, tz);
  } catch {
    parsed = { intent: 'create_task', title };
  }

  const taskData = (parsed.intent === 'create_task') ? parsed
    : (parsed.intent === 'create_tasks_batch' && parsed.tasks?.length) ? parsed.tasks[0]
    : { title };

  if (taskData.status === 'waiting') {
    const norm = normalizeWaiting(taskData.waiting_reason, taskData.waiting_until);
    taskData.waiting_reason = norm.waiting_reason;
    taskData.waiting_until  = norm.waiting_until;
  }
  if (taskData.reminder_at) taskData.reminder_at = parserReminderToUtc(taskData.reminder_at, tz);

  const saved = saveTask(userId, taskData);
  addAttachment(saved.id, media);
  return saved;
}

async function handleMediaMessage(ctx, media, caption) {
  const userId = getUser(ctx);

  if (caption?.trim()) {
    const statusMsg = await ctx.reply('⏳ Анализирую...');
    const saved = await createTaskWithMedia(ctx, userId, caption.trim(), media);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    return ctx.reply(
      `✅ *${saved.title}* — сохранено\n📎 ${TYPE_LABEL[media.type] ?? 'Вложение'} прикреплено`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 Открыть задачу', `tv_${saved.id}`)],
          [Markup.button.callback('✏️ Изменить', `edit_saved_${saved.id}`), Markup.button.callback('🗑 Отменить', `undo_task_${saved.id}`)],
        ]),
      }
    );
  }

  // Нет подписи — сохраняем медиа и спрашиваем название
  pendingMedia.set(userId, media);
  return ctx.reply(
    `${TYPE_LABEL[media.type] ?? 'Файл'} получен. Как назвать задачу?`,
    { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel_media')]]) }
  );
}

// Отправляет все вложения задачи в чат
async function sendAttachments(ctx, taskId) {
  const { getAttachments } = require('../../../infrastructure/db/repositories/attachmentRepository');
  const attachments = getAttachments(taskId);
  for (const a of attachments) {
    try {
      if (a.type === 'photo')          await ctx.replyWithPhoto(a.file_id);
      else if (a.type === 'video')     await ctx.replyWithVideo(a.file_id);
      else if (a.type === 'animation') await ctx.replyWithAnimation(a.file_id);
      else if (a.type === 'sticker')   await ctx.replyWithSticker(a.file_id);
      else if (a.type === 'audio')     await ctx.replyWithAudio(a.file_id);
      else if (a.type === 'document')  await ctx.replyWithDocument(a.file_id);
      else if (a.type === 'link')      await ctx.reply(a.url);
    } catch (e) {
      console.error('[attachments] send error:', e.message);
    }
  }
}

function register(bot) {
  bot.on('photo',     (ctx) => handleMediaMessage(ctx, extractMediaFromMsg(ctx.message), ctx.message.caption));
  bot.on('video',     (ctx) => handleMediaMessage(ctx, extractMediaFromMsg(ctx.message), ctx.message.caption));
  bot.on('document',  (ctx) => handleMediaMessage(ctx, extractMediaFromMsg(ctx.message), ctx.message.caption));
  bot.on('audio',     (ctx) => handleMediaMessage(ctx, extractMediaFromMsg(ctx.message), ctx.message.caption));
  bot.on('animation', (ctx) => handleMediaMessage(ctx, extractMediaFromMsg(ctx.message), ctx.message.caption));
  bot.on('sticker',   (ctx) => handleMediaMessage(ctx, extractMediaFromMsg(ctx.message), ctx.message.caption));

  bot.action('cancel_media', async (ctx) => {
    const userId = getUser(ctx);
    pendingMedia.delete(userId);
    await ctx.answerCbQuery('Отменено');
    await ctx.editMessageText('❌ Отменено.').catch(() => {});
  });
}

module.exports = { register, sendAttachments, createTaskWithMedia, TYPE_LABEL };
