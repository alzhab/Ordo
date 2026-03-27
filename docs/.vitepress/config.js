import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Ordo',
  description: 'Telegram-бот для управления задачами через голос и текст',
  lang: 'ru-RU',

  themeConfig: {
    nav: [
      { text: 'Главная', link: '/' },
      { text: 'Команды', link: '/commands' },
      { text: 'Notion', link: '/notion' },
      { text: 'Деплой', link: '/deploy' },
    ],

    sidebar: [
      { text: 'Начало', link: '/' },
      { text: 'Команды и примеры', link: '/commands' },
      { text: 'Интеграция с Notion', link: '/notion' },
      { text: 'Деплой своего бота', link: '/deploy' },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/alzhan/ordo' },
    ],

    footer: {
      message: 'Ordo — порядок в задачах',
    },

    search: {
      provider: 'local',
    },
  },

  base: '/ordo/',
})
