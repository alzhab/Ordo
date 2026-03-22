/**
 * Мок-бот для тестирования зарегистрированных handlers.
 * Вызов register(bot) захватывает все bot.action/command/on.
 * Затем bot.trigger('action_data', ctx) вызывает нужный handler.
 */
function createMockBot() {
  const _actions  = []; // [{ pattern, fn }]
  const _commands = {}; // cmd → fn

  const bot = {
    action(pattern, fn)  { _actions.push({ pattern, fn }); },
    command(cmd, fn)     { _commands[cmd] = fn; },
    on(_event, _fn)      { /* не тестируем on-handlers */ },

    /** Вызвать handler по строке action (callback_data) */
    async trigger(data, ctx) {
      for (const { pattern, fn } of _actions) {
        if (typeof pattern === 'string' && pattern === data) {
          ctx.match = [data];
          return fn(ctx);
        }
        if (pattern instanceof RegExp) {
          const m = data.match(pattern);
          if (m) { ctx.match = m; return fn(ctx); }
        }
      }
      throw new Error(`Нет action handler для: "${data}"`);
    },

    /** Вызвать handler по имени команды (без /) */
    async triggerCommand(cmd, ctx) {
      if (!_commands[cmd]) throw new Error(`Нет command handler для: "${cmd}"`);
      return _commands[cmd](ctx);
    },
  };

  return bot;
}

module.exports = { createMockBot };
