export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  css: ['~/assets/main.css', '~/assets/live.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'AI Farm · лаборатория продуктов',
      meta: [{ name: 'robots', content: 'noindex, nofollow' }],
    },
  },
  nitro: {
    preset: 'node-server',
    externals: { external: ['pg'] },
    esbuild: { options: { target: 'es2022' } },
  },
  typescript: { strict: true },
})
