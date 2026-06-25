require('./infrastructure/db/migrations'); // run migrations on startup
const bot = require('./delivery/telegram/bot');

const { PORT } = require('./shared/config');
if (PORT) {
  const oauthServer = require('./delivery/http/oauthServer');
  oauthServer.start(bot, PORT);
}
