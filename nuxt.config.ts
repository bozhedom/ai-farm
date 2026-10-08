export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  // Design tokens are global; components apply under the `ds` class on <html>.
  css: ['~/assets/tokens.css', '~/assets/components.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'AI Farm',
      // Indexing is decided per response by `X-Robots-Tag` in server/middleware/security.ts.
    },
  },
  // The owner office moved under /office. Old bookmarks keep working.
  routeRules: {
    '/login': { redirect: { to: '/office/login', statusCode: 301 } },
    '/catalog': { redirect: { to: '/office/products', statusCode: 301 } },
    '/orders/**': { redirect: { to: '/office/orders/**', statusCode: 301 } },
  },
  nitro: {
    preset: 'node-server',
    externals: { external: ['pg'] },
    esbuild: { options: { target: 'es2022' } },
  },
  typescript: { strict: true },
})
