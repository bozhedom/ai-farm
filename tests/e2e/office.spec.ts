import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import { officeFixtures, type OfficeFixtures } from './fixtures/office'

/**
 * Walks every owner office section at 1440 and 390 px with the office API stubbed by typed
 * fixtures. Fails on console errors and horizontal scroll. Screenshots: output/playwright/stream-c.
 */

const shots = join(process.cwd(), 'output/playwright/stream-c')
mkdirSync(shots, { recursive: true })

type Posted = { url: string; body: unknown }

async function stubOffice(page: Page, fx: OfficeFixtures, options: { offline?: boolean } = {}) {
  const posted: Posted[] = []
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const page10 = <T>(items: T[], offset: number) => ({
    items: items.slice(offset, offset + 10),
    total: items.length,
    offset,
    limit: 10,
    hasMore: offset + 10 < items.length,
  })
  await page.route(/\/api\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.method() === 'POST') {
      posted.push({ url: path, body: request.postDataJSON() })
      if (path === '/api/orders') return json(route, { id: fx.deliveredOrder.id })
      if (path.endsWith('/relink'))
        return json(route, { token: 'T'.repeat(43), url: `/order/${'T'.repeat(43)}` })
      return json(route, { ok: true })
    }
    if (options.offline && path.startsWith('/api/office/'))
      return json(route, { statusMessage: 'DOWN' }, 503)
    const offset = Number(url.searchParams.get('offset') || 0)
    if (path === '/api/office/overview') return json(route, fx.overview)
    if (path === '/api/office/agents') return json(route, fx.agents)
    if (path === '/api/office/money') return json(route, fx.money)
    if (path === '/api/office/settings') return json(route, fx.settings)
    if (path === '/api/office/products') return json(route, { items: fx.products })
    if (path === '/api/office/reports') return json(route, { items: fx.reports })
    if (path === '/api/office/orders') return json(route, page10(fx.orders, offset))
    if (path === '/api/office/ideas') {
      const status = url.searchParams.get('status')
      const category = url.searchParams.get('category')
      const view = url.searchParams.get('view')
      const inView = (idea: (typeof fx.ideas)[number], name: string | null) =>
        !name ||
        (name === 'farm' && idea.farmExecutable && idea.status !== 'rejected') ||
        (name === 'human' && !idea.farmExecutable && idea.status !== 'rejected') ||
        (name === 'rejected' && idea.status === 'rejected') ||
        (name === 'taken' && idea.ownerStatus === 'taken')
      const inCategory = (idea: (typeof fx.ideas)[number]) =>
        !category || idea.categoryId === category || idea.category === category
      const items = fx.ideas.filter(
        (idea) => (!status || idea.status === status) && inCategory(idea) && inView(idea, view),
      )
      const scope = fx.ideas.filter(inCategory)
      const byCategory: Record<string, number> = {}
      for (const idea of fx.ideas)
        byCategory[idea.categoryId!] = (byCategory[idea.categoryId!] || 0) + 1
      return json(route, {
        ...page10(items, offset),
        categories: fx.categories,
        counts: {
          all: scope.length,
          farm: scope.filter((i) => inView(i, 'farm')).length,
          human: scope.filter((i) => inView(i, 'human')).length,
          rejected: scope.filter((i) => inView(i, 'rejected')).length,
          taken: scope.filter((i) => inView(i, 'taken')).length,
          byCategory,
        },
      })
    }
    const idea = path.match(/^\/api\/office\/ideas\/([^/]+)$/)
    if (idea) {
      const found = fx.ideas.find((item) => item.id === idea[1])
      return found ? json(route, found) : json(route, { statusMessage: 'NOT_FOUND' }, 404)
    }
    if (path === '/api/office/leads' || path === '/api/opportunities')
      return json(route, page10(fx.leads, offset))
    if (path === `/api/orders/${fx.reviewOrder.id}`) return json(route, fx.reviewOrder)
    if (path.startsWith('/api/orders/')) return json(route, fx.deliveredOrder)
    if (/^\/api\/products\/[^/]+\/versions$/.test(path)) return json(route, fx.versions)
    if (path === '/api/readiness') return json(route, fx.readiness, 503)
    if (path === '/api/dashboard') return json(route, fx.journal)
    return json(route, { statusMessage: 'NOT_STUBBED' }, 404)
  })
  return posted
}

function watchConsole(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // The real readiness check answers 503 while something is degraded; the page reads the body.
    if (message.location().url.includes('/api/readiness')) return
    errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const wide = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const box = el.getBoundingClientRect()
        return box.width > 0 && box.right > width + 1 && getComputedStyle(el).position !== 'fixed'
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
    return { scroll: document.documentElement.scrollWidth - width, wide }
  })
  expect(
    overflow.scroll,
    `горизонтальная прокрутка: ${overflow.wide.join(', ')}`,
  ).toBeLessThanOrEqual(0)
}

const fx = officeFixtures()
const sections: { name: string; path: string; ready: string }[] = [
  { name: 'home', path: '/office', ready: 'Что произошло сегодня' },
  { name: 'ideas', path: '/office/ideas', ready: fx.ideas[0]!.title },
  {
    name: 'idea',
    path: `/office/ideas/${fx.ideas.find((i) => !i.farmExecutable)!.id}`,
    ready: 'План запуска',
  },
  {
    name: 'idea-build-failed',
    path: `/office/ideas/${fx.ideas.find((i) => i.buildError)!.id}`,
    ready: 'Сборка не прошла проверку',
  },
  { name: 'reports', path: '/office/ideas?tab=reports', ready: 'Лучший день по принятым идеям' },
  { name: 'agents', path: '/office/agents', ready: 'Поколения' },
  { name: 'products', path: '/office/products', ready: fx.products[0]!.name },
  { name: 'orders', path: '/office/orders', ready: fx.orders[1]!.product.name },
  { name: 'order', path: `/office/orders/${fx.reviewOrder.id}`, ready: 'Закрыть без выдачи' },
  { name: 'leads', path: '/office/leads', ready: fx.leads[0]!.title },
  { name: 'money', path: '/office/money', ready: 'Реальная выручка' },
  { name: 'settings', path: '/office/settings', ready: 'Состояние сервера' },
  { name: 'login', path: '/office/login', ready: 'Вход в кабинет' },
]

for (const width of [1440, 390]) {
  test.describe(`office ${width}`, () => {
    test.use({ viewport: { width, height: width > 1000 ? 900 : 844 } })
    for (const section of sections) {
      test(section.name, async ({ page }) => {
        const errors = watchConsole(page)
        await stubOffice(page, fx)
        await page.goto(section.path)
        await expect(page.getByText(section.ready).first()).toBeVisible()
        await page.waitForTimeout(400)
        await noHorizontalScroll(page)
        // Like the design shots: the mobile tab bar sits at the end of a full-page picture.
        if (width < 1024) await page.addStyleTag({ content: '.tabbar{position:static!important}' })
        await page.screenshot({ path: join(shots, `${section.name}-${width}.png`), fullPage: true })
        expect(errors).toEqual([])
      })
    }
  })
}

test.describe('office behaviour', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('stop asks once more before stopping the farm', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    await page.goto('/office')
    await page.getByRole('button', { name: 'Стоп' }).click()
    await expect(page.getByRole('button', { name: 'Точно остановить?' })).toBeVisible()
    expect(posted).toEqual([])
    await page.getByRole('button', { name: 'Точно остановить?' }).click()
    await expect.poll(() => posted.map((p) => p.body)).toContainEqual({ action: 'emergency_stop' })
  })

  test('ideas filter by launch type and open a card', async ({ page }) => {
    await stubOffice(page, fx)
    await page.goto('/office/ideas')
    await expect(page.getByText(fx.ideas[0]!.title)).toBeVisible()
    await page.getByRole('button', { name: /^Нужен человек/ }).click()
    const human = fx.ideas.filter((i) => !i.farmExecutable)
    await expect(page.getByText(human[0]!.title)).toBeVisible()
    await expect(page.getByText(fx.ideas.find((i) => i.farmExecutable)!.title)).toHaveCount(0)
    await page.getByText(human[0]!.title).click()
    await page.getByRole('link', { name: 'Открыть карточку' }).first().click()
    await expect(page.getByRole('heading', { name: human[0]!.title })).toBeVisible()
  })

  test('an idea that needs a person can be taken into work', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    const idea = fx.ideas.find((i) => i.status === 'needs_human' && !i.ownerStatus)!
    await page.goto(`/office/ideas/${idea.id}`)
    await page.getByRole('button', { name: 'Взять в работу' }).click()
    await expect
      .poll(() => posted.find((p) => p.url === `/api/office/ideas/${idea.id}`)?.body)
      .toEqual({ ownerStatus: 'taken' })
  })

  test('a failed build shows its reason and a demo product is not called on site', async ({
    page,
  }) => {
    await stubOffice(page, fx)
    const idea = fx.ideas.find((i) => i.buildError)!
    await page.goto(`/office/ideas/${idea.id}`)
    await expect(page.getByLabel('Сборка не прошла проверку')).toContainText(idea.buildError!)
    await page.goto('/office/products')
    const demo = fx.products.find((p) => p.demoHidden)!
    const card = page.locator(`#product-${demo.id}`)
    await expect(card).toContainText('Демо, на сайте не виден')
    await expect(card.getByRole('link', { name: 'Открыть на сайте' })).toHaveCount(0)
    await page.goto('/office/leads')
    await expect(page.getByText('Отклик не готовим: запрос старше 60 дней.')).toBeVisible()
  })

  test('order page warns before issuing a new buyer link', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    await page.goto(`/office/orders/${fx.reviewOrder.id}`)
    await expect(
      page.getByRole('heading', { name: `Заказ №${fx.reviewOrder.number}` }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Открыть как покупатель' }).click()
    await expect(page.getByText('старая сразу перестанет открываться')).toBeVisible()
    expect(posted.map((p) => p.url)).not.toContain(`/api/orders/${fx.reviewOrder.id}/relink`)
    await page.getByRole('button', { name: 'Выдать новую ссылку' }).click()
    await expect(page.getByRole('link', { name: 'Открыть как покупатель' })).toHaveAttribute(
      'href',
      new RegExp(`/order/${'T'.repeat(43)}$`),
    )
  })

  test('settings pick the daily run hour in local time', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    await page.goto('/office/settings')
    // Europe/Moscow is UTC+3: 12:00 local is 09:00 UTC.
    await page.getByLabel('Час ежедневного запуска').selectOption({ label: '12:00' })
    await expect
      .poll(() => posted.find((p) => p.url === '/api/office/settings')?.body)
      .toEqual({ scheduleHourUtc: 9 })
  })

  test('agents run a selection round on request', async ({ page }) => {
    const ready = officeFixtures()
    ready.agents.evolution.ready = true
    ready.agents.evolution.missing = []
    const posted = await stubOffice(page, ready)
    await page.goto('/office/agents')
    await page.getByRole('button', { name: 'Провести отбор сейчас' }).click()
    await expect.poll(() => posted.map((p) => p.url)).toContain('/api/office/agents/evolve')
  })

  test('leads mark a reply as sent', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const posted = await stubOffice(page, fx)
    await page.goto('/office/leads')
    await page.getByRole('button', { name: 'Скопировать отклик' }).first().click()
    await expect(page.getByText('Отклик скопирован').first()).toBeVisible()
    await page.getByRole('button', { name: 'Отправил' }).first().click()
    await expect
      .poll(() => posted.map((p) => p.body))
      .toContainEqual({ stage: 'contacted', note: '' })
  })

  test('order closes without delivery only with a reason', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    await page.goto(`/office/orders/${fx.reviewOrder.id}`)
    const close = page.getByRole('button', { name: 'Закрыть без выдачи' })
    await expect(close).toBeDisabled()
    await page.getByLabel('Почему закрываете').fill('Клиент передумал, текст не нужен.')
    await close.click()
    await expect
      .poll(() => posted.map((p) => p.url))
      .toContain(`/api/orders/${fx.reviewOrder.id}/resolve`)
  })

  test('settings save evolution limits', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    await page.goto('/office/settings')
    await page.getByLabel('Минимум идей для отбора').fill('2')
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect
      .poll(() => posted.find((p) => p.url === '/api/office/settings')?.body)
      .toMatchObject({ evolutionMinIdeas: 2 })
  })

  test('shows the last state when the connection drops', async ({ page }) => {
    await stubOffice(page, fx, { offline: true })
    await page.goto('/office')
    await expect(page.getByText('Нет связи').first()).toBeVisible()
    await page.screenshot({ path: join(shots, 'offline-1440.png') })
  })

  test('login sends the password and opens the trading office', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    await page.goto('/office/login')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Пароль', { exact: true }).fill('owner-password')
    await page.getByRole('button', { name: 'Войти' }).click()
    await expect(page).toHaveURL(/\/office\/trading$/)
    expect(posted[0]).toEqual({ url: '/api/auth/login', body: { password: 'owner-password' } })
  })

  test('old links lead to the new sections', async ({ page }) => {
    await stubOffice(page, fx)
    await page.goto('/?view=strategies')
    await expect(page).toHaveURL(/\/office\/agents$/)
    await page.goto('/office?view=opportunities')
    await expect(page).toHaveURL(/\/office\/leads$/)
  })
})
