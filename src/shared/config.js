require('dotenv').config();

// При отсутствии обязательных переменных бот не запустится.
// Notion переменные не обязательны — интеграция опциональна.
const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Отсутствуют обязательные переменные окружения: ${missing.join(', ')}`);
  console.error('   Скопируй .env.example в .env и заполни значения.');
  process.exit(1);
}

// DEV=true переключает на data_dev.db и dev-базы Notion,
// чтобы тестировать не трогая продакшен данные.
const IS_DEV = process.env.DEV === 'true';

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  GROQ_API_KEY:       process.env.GROQ_API_KEY,
  ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY,
  NOTION_TOKEN:       process.env.NOTION_TOKEN,
  // В dev режиме используются отдельные Notion базы чтобы не засорять продакшен
  NOTION_DATABASE_ID:       IS_DEV ? process.env.NOTION_DATABASE_ID_DEV       : process.env.NOTION_DATABASE_ID,
  NOTION_PLANS_DATABASE_ID: IS_DEV ? process.env.NOTION_PLANS_DATABASE_ID_DEV : process.env.NOTION_PLANS_DATABASE_ID,
  IS_DEV,
};
