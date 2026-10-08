/**
 * Old owner links were `/?view=<section>` and `/office?view=<section>`. Each section now has its
 * own page under /office, so those links go straight there.
 */
const legacyViews: Record<string, string> = {
  overview: '/office',
  guide: '/office',
  directions: '/office/ideas',
  hypotheses: '/office/ideas',
  strategies: '/office/agents',
  opportunities: '/office/leads',
  orders: '/office/orders',
  products: '/office/products',
  catalog: '/office/products',
  money: '/office/money',
  audit: '/office/settings',
  settings: '/office/settings',
}

export default defineNuxtRouteMiddleware((to) => {
  if ((to.path !== '/' && to.path !== '/office') || typeof to.query.view !== 'string') return
  const path = legacyViews[to.query.view] || '/office'
  const { view: _old, ...rest } = to.query
  return navigateTo(
    { path, query: rest, hash: to.query.view === 'audit' ? '#journal' : undefined },
    { redirectCode: 301, replace: true },
  )
})
