import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Ordo',
  description: 'Telegram-бот для управления задачами через голос и текст',
  lang: 'ru-RU',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/Ordo/logo.svg' }],
    ['meta', { name: 'og:title', content: 'Ordo — задачи голосом и текстом' }],
    ['meta', { name: 'og:description', content: 'Telegram-бот с AI-парсингом задач. Говоришь или пишешь — бот сам разбирает всё остальное.' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Главная', link: '/' },
      { text: 'Команды', link: '/commands' },
      { text: 'Notion', link: '/notion' },
      { text: 'Деплой', link: '/deploy' },
    ],

    sidebar: [
      { text: 'Главная', link: '/' },
      {
        text: 'Документация',
        items: [
          { text: 'Команды и примеры', link: '/commands' },
          { text: 'Интеграция с Notion', link: '/notion' },
          { text: 'Деплой своего бота', link: '/deploy' },
        ]
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/alzhab/Ordo' },
    ],

    footer: {
      message: 'Ordo — порядок в задачах',
      copyright: 'Open source · MIT License',
    },

    search: {
      provider: 'local',
    },
  },

  base: '/Ordo/',
})
