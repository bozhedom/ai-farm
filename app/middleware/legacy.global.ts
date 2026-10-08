/**
 * Old owner links were `/?view=<section>`. The root is now the public storefront, so those links
 * move to the office. Until each section has its own page (`/office/agents`, `/office/ideas`,
 * `/office/leads`, ...), the office keeps the `?view=` switch; update the targets here when the
 * pages exist: overview -> /office, strategies -> /office/agents, hypotheses -> /office/ideas,
 * opportunities -> /office/leads, others by name.
 */
const legacyViews: Record<string, { path: string; view?: string }> = {
  overview: { path: '/office' },
  directions: { path: '/office', view: 'directions' },
  opportunities: { path: '/office', view: 'opportunities' },
  guide: { path: '/office', view: 'guide' },
  hypotheses: { path: '/office', view: 'hypotheses' },
  strategies: { path: '/office', view: 'strategies' },
  orders: { path: '/office', view: 'orders' },
  audit: { path: '/office', view: 'audit' },
  settings: { path: '/office', view: 'settings' },
}

export default defineNuxtRouteMiddleware((to) => {
  if (to.path !== '/' || typeof to.query.view !== 'string') return
  const target = legacyViews[to.query.view] || { path: '/office' }
  const { view: _old, ...rest } = to.query
  return navigateTo(
    { path: target.path, query: target.view ? { ...rest, view: target.view } : rest },
    { redirectCode: 301, replace: true },
  )
})
