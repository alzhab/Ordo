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

// Буфер для альбомов: media_group_id → { ctx, userId, items, caption, timer }
const albumBuffer = new Map();
const ALBUM_FLUSH_MS = 500;

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

// Создаёт задачу по тексту title и прикрепляет все items (массив медиа)
async function createTaskWithMedia(ctx, userId, title, items) {
  const mediaItems = Array.isArray(items) ? items : [items];
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
  for (const item of mediaItems) addAttachment(saved.id, item);
  return saved;
}

function attachmentSummary(items) {
  if (items.length === 1) return TYPE_LABEL[items[0].type] ?? 'Вложение';
  const counts = {};
  for (const it of items) counts[it.type] = (counts[it.type] ?? 0) + 1;
  return Object.entries(counts).map(([t, n]) => `${TYPE_LABEL[t] ?? t} ×${n}`).join(', ');
}

function confirmKeyboard(saved) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 Открыть задачу', `tv_${saved.id}`)],
    [Markup.button.callback('✏️ Изменить', `edit_saved_${saved.id}`), Markup.button.callback('🗑 Отменить', `undo_task_${saved.id}`)],
  ]);
}

// Обработка сформированного альбома или одиночного медиа
async function processMedia(ctx, userId, items, caption) {
  if (caption?.trim()) {
    const statusMsg = await ctx.reply('⏳ Анализирую...');
    const saved = await createTaskWithMedia(ctx, userId, caption.trim(), items);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    return ctx.reply(
      `✅ *${saved.title}* — сохранено\n📎 ${attachmentSummary(items)} прикреплено`,
      { parse_mode: 'Markdown', ...confirmKeyboard(saved) }
    );
  }

  // Нет подписи — сохраняем все items и спрашиваем название
  pendingMedia.set(userId, items);
  const label = items.length > 1
    ? `${items.length} файлов`
    : (TYPE_LABEL[items[0].type] ?? 'Файл');
  return ctx.reply(
    `📎 ${label} получено. Как назвать задачу?`,
    { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel_media')]]) }
  );
}

async function handleMediaMessage(ctx, media, caption) {
  const userId  = getUser(ctx);
  const groupId = ctx.message?.media_group_id;

  if (groupId) {
    // Часть альбома — буферизуем, ждём остальные фото
    let group = albumBuffer.get(groupId);
    if (!group) {
      group = { ctx, userId, items: [], caption: null };
      albumBuffer.set(groupId, group);
    }
    group.items.push(media);
    if (caption) group.caption = caption; // caption только у первого фото в альбоме

    clearTimeout(group.timer);
    group.timer = setTimeout(() => {
      albumBuffer.delete(groupId);
      processMedia(group.ctx, group.userId, group.items, group.caption)
        .catch(e => console.error('[media] album error:', e.message));
    }, ALBUM_FLUSH_MS);
    return;
  }

  // Одиночное медиа — обрабатываем сразу
  return processMedia(ctx, userId, [media], caption);
}

// Отправляет задачу вместе с вложениями в одном сообщении.
// - Нет вложений → обычное текстовое сообщение
// - Одно фото/видео/документ/аудио/анимация → медиа с caption = текст + кнопки
// - Ссылка → добавляется в текст задачи строкой
// - Стикер → текст+кнопки, потом стикер отдельно (Telegram не поддерживает caption)
// - Несколько медиа → первое с caption+кнопками, остальные media group следом
async function replyTaskWithMedia(ctx, taskText, keyboard, taskId) {
  const { getAttachments } = require('../../../infrastructure/db/repositories/attachmentRepository');
  const attachments = getAttachments(taskId);

  // Ссылки — добавляем в текст, не как отдельное сообщение
  const links    = attachments.filter(a => a.type === 'link');
  const mediaArr = attachments.filter(a => a.type !== 'link');

  let fullText = taskText;
  for (const link of links) fullText += `\n🔗 ${link.url}`;

  if (mediaArr.length === 0) {
    return ctx.reply(fullText, { parse_mode: 'Markdown', ...keyboard });
  }

  // caption ограничен 1024 символами в Telegram
  const caption = fullText.length <= 1024 ? fullText : fullText.slice(0, 1021) + '…';
  const captionOpts = { caption, parse_mode: 'Markdown', ...keyboard };

  const first = mediaArr[0];
  const rest  = mediaArr.slice(1);

  switch (first.type) {
    case 'photo':     await ctx.replyWithPhoto(first.file_id, captionOpts); break;
    case 'video':     await ctx.replyWithVideo(first.file_id, captionOpts); break;
    case 'document':  await ctx.replyWithDocument(first.file_id, captionOpts); break;
    case 'audio':     await ctx.replyWithAudio(first.file_id, captionOpts); break;
    case 'animation': await ctx.replyWithAnimation(first.file_id, captionOpts); break;
    case 'sticker':
      await ctx.reply(fullText, { parse_mode: 'Markdown', ...keyboard });
      await ctx.replyWithSticker(first.file_id);
      break;
    default:
      await ctx.reply(fullText, { parse_mode: 'Markdown', ...keyboard });
  }

  if (rest.length > 0) {
    const groupable = rest.filter(a => ['photo', 'video'].includes(a.type));
    const solo      = rest.filter(a => !['photo', 'video'].includes(a.type));
    if (groupable.length > 0) {
      const mg = groupable.slice(0, 10).map(a => ({ type: a.type, media: a.file_id }));
      await ctx.replyWithMediaGroup(mg).catch(e => console.error('[attachments] group error:', e.message));
    }
    for (const a of solo) {
      try {
        if (a.type === 'document')       await ctx.replyWithDocument(a.file_id);
        else if (a.type === 'audio')     await ctx.replyWithAudio(a.file_id);
        else if (a.type === 'animation') await ctx.replyWithAnimation(a.file_id);
        else if (a.type === 'sticker')   await ctx.replyWithSticker(a.file_id);
      } catch (e) { console.error('[attachments] send error:', e.message); }
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

module.exports = { register, replyTaskWithMedia, createTaskWithMedia, TYPE_LABEL };
