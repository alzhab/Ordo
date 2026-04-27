import {defineConfig} from 'vitepress'

export default defineConfig({
  title: 'Ordo',
  description: 'Telegram-бот с AI-ассистентом. Выгружаешь всё из головы — получаешь план на день. Голова свободна.',
  lang: 'ru-RU',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/Ordo/logo.svg' }],
    ['meta', { name: 'og:title', content: 'Ordo — голова свободна' }],
    ['meta', { name: 'og:description', content: 'Telegram-бот с AI-ассистентом. Выгружаешь задачи голосом — получаешь план на день с объяснением почему именно эти три.' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [],

    sidebar: [
			{
				items: [
					{ text: 'Главная', link: '/' },
					{ text: 'Запись задач', link: '/capture' },
					{ text: 'Утренний план', link: '/plan' },
					{ text: 'Вечерний разбор', link: '/review' },
					{ text: 'Цели и проекты', link: '/goals' },
					{ text: 'Все команды', link: '/commands' },
				],
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
