/**
 * Фабрика мок-контекста Telegraf для тестов обработчиков.
 * ctx.reply возвращает { message_id: 101 } — как реальный Telegram ответ.
 */
function mockCtx({ userId = 1, isCallback = false } = {}) {
  return {
    from:          { id: userId, username: 'testuser' },
    chat:          { id: userId },
    message:       { message_id: 100 },
    callbackQuery: isCallback ? { message: { message_id: 100 }, data: '' } : null,
    match:         [],
    reply:         jest.fn().mockResolvedValue({ message_id: 101 }),
    editMessageText: jest.fn().mockResolvedValue({}),
    deleteMessage:   jest.fn().mockResolvedValue({}),
    answerCbQuery:   jest.fn().mockResolvedValue({}),
    telegram: {
      deleteMessage: jest.fn().mockResolvedValue({}),
      getFileLink:   jest.fn().mockResolvedValue({ href: 'https://example.com/voice.oga' }),
    },
  };
}

module.exports = { mockCtx };
