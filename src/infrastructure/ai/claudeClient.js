// Тонкая обёртка над Anthropic SDK для простых запросов без system промпта.
// Используется в application/assistant.js для getPlanRecommendations и др.
//
// Не используется в parser.js — там нужен system промпт с контекстом пользователя,
// который в этот интерфейс не вписывается.

const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('../../shared/config');

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Отправляет один запрос, возвращает текст ответа.
async function ask(prompt, { maxTokens = 1024, model = 'claude-sonnet-4-6' } = {}) {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text.trim();
}

// Как ask, но парсит JSON из ответа.
// Убирает ```json ... ``` если Claude обернул ответ в markdown-блок.
async function askJson(prompt, options = {}) {
  const text = await ask(prompt, options);
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

module.exports = { ask, askJson };
