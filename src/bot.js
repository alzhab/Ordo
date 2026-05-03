require('./infrastructure/db/migrations'); // run migrations on startup
const bot = require('./delivery/telegram/bot');

const { GOOGLE_REDIRECT_URI, PORT } = require('./shared/config');
if (GOOGLE_REDIRECT_URI && PORT) {
  const oauthServer = require('./delivery/http/oauthServer');
  oauthServer.start(bot, PORT);
}
