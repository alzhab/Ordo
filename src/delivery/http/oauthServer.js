// Минимальный HTTP-сервер только для OAuth callback.
// Запускается на PORT (Railway автоматически выставляет его).
// Получает code от Google, обменивает на токены, сообщает пользователю в Telegram.

const http = require('http');
const { URL } = require('url');
const gcal  = require('../../infrastructure/integrations/googleCalendar');

function html(title, body) {
  return (
    `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;` +
    `max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#1a1a1a}` +
    `h1{font-size:2rem;margin-bottom:1rem}</style></head>` +
    `<body><h1>${title}</h1><p>${body}</p></body></html>`
  );
}

async function handleGoogleCallback(bot, url, res) {
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('Авторизация отменена', 'Можно закрыть эту вкладку.'));
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('Ошибка', 'Неверный запрос.'));
    return;
  }

  const userId = gcal.resolveState(state);
  if (!userId) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('Ссылка устарела', 'Запроси новую ссылку в боте и попробуй снова.'));
    return;
  }

  try {
    const { email } = await gcal.exchangeCode(userId, code);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html(
      '✅ Подключено!',
      `Google Calendar подключён${email ? ` (${email})` : ''}.<br>Можно закрыть эту вкладку и вернуться в Telegram.`
    ));

    const text = (
      `✅ *Google Calendar подключён!*` +
      (email ? `\n\nАккаунт: ${email}` : '') +
      `\n\nТеперь задачи с датой будут автоматически появляться в твоём календаре.`
    );
    await bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[oauth] google callback error:', e.message);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('Ошибка подключения', `${e.message}. Попробуй снова.`));
  }
}

function start(bot, port) {
  if (!port) {
    console.log('[oauth] PORT не задан — HTTP-сервер не запущен');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost`);
      if (url.pathname === '/oauth/google/callback') {
        await handleGoogleCallback(bot, url, res);
      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch (e) {
      console.error('[oauth] request handler error:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[oauth] HTTP-сервер запущен на :${port}`);
  });
  server.on('error', e => console.error('[oauth] server error:', e.message));

  return server;
}

module.exports = { start };
