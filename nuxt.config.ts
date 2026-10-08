export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  // Design tokens are global. New components are scoped to `.ds` and load last, so old office
  // styles keep working until their pages are rewritten.
  css: [
    '~/assets/tokens.css',
    '~/assets/main.css',
    '~/assets/live.css',
    '~/assets/workspace.css',
    '~/assets/components.css',
  ],
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'AI Farm · текстовые сервисы',
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
