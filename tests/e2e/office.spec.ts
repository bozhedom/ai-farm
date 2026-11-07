import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import { officeFixtures, type OfficeFixtures } from './fixtures/office'
import {
  defaultTradingRules,
  type TradingInstructionsView,
} from '../../core/contracts/trading-instructions'

/**
 * Walks every owner office section at 1440 and 390 px with the office API stubbed by typed
 * fixtures. Fails on console errors and horizontal scroll. Screenshots: output/playwright/stream-c.
 */

const shots = join(process.cwd(), 'output/playwright/stream-c')
mkdirSync(shots, { recursive: true })

type Posted = { url: string; body: unknown }

async function stubOffice(page: Page, fx: OfficeFixtures, options: { offline?: boolean } = {}) {
  const posted: Posted[] = []
  const instructions: TradingInstructionsView = {
    revision: 0,
    profileRevision: 0,
    rules: defaultTradingRules(),
    managerNotes: [],
    appliedAt: null,
    source: null,
    synchronized: true,
  }
  const modelView = {
    defaultModel: 'openai/gpt-6-astra',
    switchAvailable: true,
    master: 'Общие правила сервера.',
    roles: [
      {
        id: 'director',
        name: 'Руководитель',
        instruction: '',
        model: '',
        revision: 0,
        effectivePrompt:
          'Общие правила сервера. Руководитель проверяет расходы и подтверждённый доход.',
      },
      {
        id: 'manager',
        name: 'Торговый менеджер',
        instruction: '',
        model: '',
        revision: 0,
        effectivePrompt: 'Общие правила сервера. Только Paper.',
      },
    ],
    contexts: [] as { id: string; role: string; title: string; content: string }[],
  }

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
    if (request.method() === 'DELETE' && path.startsWith('/api/office/models/context/')) {
      posted.push({ url: path, body: request.postDataJSON() })
      modelView.contexts = modelView.contexts.filter((c) => !path.endsWith(c.id))
      return json(route, { ok: true })
    }
    if (request.method() === 'POST') {
      posted.push({ url: path, body: request.postDataJSON() })
      if (path === '/api/office/models/model') {
        const body = request.postDataJSON()
        const role = modelView.roles.find((r) => r.id === body.role)!
        Object.assign(role, { model: body.model, revision: body.revision + 1 })
        if (body.role === 'manager') instructions.profileRevision = role.revision
        return json(route, { revision: role.revision })
      }
      if (path === '/api/office/models/context')
        modelView.contexts.push({ id: 'ctx-1', ...request.postDataJSON() })
      if (path === '/api/office/models' || path === '/api/office/trading-instructions') {
        const body = request.postDataJSON()
        Object.assign(
          modelView.roles.find((r) => r.id === body.role)!,
          { ...body, revision: body.revision + 1 },
        )
        if (path === '/api/office/trading-instructions') {
          Object.assign(instructions, {
            revision: instructions.revision + 1,
            profileRevision: body.revision + 1,
            appliedAt: new Date().toISOString(),
            source: 'model',
            managerNotes: ['Исследовать комиссии и частоту сделок.'],
          })
          return json(route, { applied: true, issues: [], current: instructions })
        }
      }
      if (path === '/api/orders') return json(route, { id: fx.deliveredOrder.id })
      if (path.endsWith('/relink'))
        return json(route, { token: 'T'.repeat(43), url: `/order/${'T'.repeat(43)}` })
      return json(route, { ok: true })
    }
    if (options.offline && path.startsWith('/api/office/'))
      return json(route, { statusMessage: 'DOWN' }, 503)
    const offset = Number(url.searchParams.get('offset') || 0)
    if (path === '/api/office/focus')
      return json(route, {
        enabled: false,
        active: false,
        selected: ['trading', 'manager'],
        until: null,
        revision: 0,
      })
    if (path === '/api/office/models') return json(route, modelView)
    if (path === '/api/office/trading-instructions') return json(route, instructions)
    if (path === '/api/office/models/catalog')
      return json(route, [
        {
          id: 'vendor/eligible',
          name: 'Доступная модель',
          browser: true,
          pricing: { inputNano: 100, outputNano: 400, contextLength: 128000 },
        },
        {
          id: 'vendor/small:free',
          name: 'Бесплатная модель',
          browser: false,
          pricing: { inputNano: 0, outputNano: 0, contextLength: 32000 },
        },
      ])
    if (path === '/api/office/directions')
      return json(route, [
        {
          id: 'spot-bybit',
          title: 'Спот · BYBIT',
          group: 'real',
          activity: 'Live · торговля включена',
          status: 'работает',
          active: true,
          detail: 'Торговое подключение проверено. Live запущен.',
          link: '/office/trading',
        },
        {
          id: 'funding',
          title: 'Фандинг Bybit',
          group: 'test',
          activity: 'Paper · симуляция',
          status: 'тестовый режим',
          active: true,
          detail: 'Активна тренировка на виртуальных средствах.',
          link: '/office/earnings?track=yield',
        },
        {
          id: 'prediction',
          title: 'Kalshi',
          group: 'other',
          activity: 'Реальные операции не подключены',
          status: 'требует подключения',
          active: false,
          detail: 'Аккаунт не подключён.',
          link: '/office/earnings?track=prediction',
        },
      ])
    if (path === '/api/earnings')
      return json(route, { monitor: { enabled: true }, report: null, arbitrage: null })
    if (path === '/api/office/overview') return json(route, fx.overview)
    if (path === '/api/office/income') return json(route, fx.income)
    if (path === '/api/office/launch') return json(route, fx.launch)
    if (path === '/api/office/agents') return json(route, fx.agents)
    if (path === '/api/office/money') return json(route, fx.money)
    if (path === '/api/office/wallet') return json(route, fx.wallet)
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
    if (path === '/api/computer-use')
      return json(route, {
        state: { enabled: true, autoProposals: true, autoProposalsAllowed: true },
        platforms: [{ domain: 'kwork.ru', loggedIn: true }],
      })
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
  { name: 'models', path: '/office/models', ready: 'Настройка роли' },
  { name: 'trading-instructions', path: '/office/trading-instructions', ready: 'Правила торговли' },
  { name: 'directions', path: '/office/earnings', ready: 'Спот · BYBIT' },
  { name: 'overview', path: '/office', ready: 'Источники заработка' },
  { name: 'launch', path: '/office/launch', ready: 'Готовность к заработку' },
  { name: 'farm', path: '/office/farm', ready: 'Что произошло сегодня' },
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

/** The launch checklist and the overview card in both themes; shots: output/playwright/launch. */
const launchShots = join(process.cwd(), 'output/playwright/launch')
mkdirSync(launchShots, { recursive: true })
for (const theme of ['light', 'dark'] as const)
  for (const width of [1440, 390]) {
    test.describe(`launch ${theme} ${width}`, () => {
      test.use({ viewport: { width, height: width > 1000 ? 900 : 844 } })
      for (const section of sections.filter((s) => s.name === 'launch' || s.name === 'overview')) {
        test(section.name, async ({ page }) => {
          const errors = watchConsole(page)
          await stubOffice(page, fx)
          // The init script may run before <html> exists: apply the theme as soon as it does.
          if (theme === 'dark')
            await page.addInitScript(() => {
              const apply = () => {
                if (!document.documentElement) return false
                document.documentElement.setAttribute('data-theme', 'dark')
                return true
              }
              if (!apply())
                new MutationObserver((_, observer) => {
                  if (apply()) observer.disconnect()
                }).observe(document, { childList: true })
            })
          await page.goto(section.path)
          await expect(page.getByText(section.ready).first()).toBeVisible()
          await expect(page.getByText('Готовность к заработку').first()).toBeVisible()
          await page.waitForTimeout(400)
          await noHorizontalScroll(page)
          if (width < 1024)
            await page.addStyleTag({ content: '.tabbar{position:static!important}' })
          await page.screenshot({
            path: join(launchShots, `${section.name}-${theme}-${width}.png`),
            fullPage: true,
          })
          expect(errors).toEqual([])
        })
      }
    })
  }

test.describe('launch behaviour', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the overview card names the next step and leads to it', async ({ page }) => {
    await stubOffice(page, fx)
    await page.goto('/office')
    const card = page.locator('section.launch')
    await expect(card).toContainText(
      `Готовность к заработку: ${fx.launch.done} из ${fx.launch.total}`,
    )
    await expect(card).toContainText(fx.launch.next!.title)
    await card.getByRole('link', { name: 'Что сделать' }).click()
    await expect(page).toHaveURL(new RegExp(`/office/launch#step-${fx.launch.next!.id}$`))
    await expect(page.getByRole('heading', { name: 'Запуск' })).toBeVisible()
    const step = page.locator(`#step-${fx.launch.next!.id}`)
    await expect(step).toContainText('Нужно сделать')
    await expect(step).toContainText('Виртуальная машина не отвечает')
    // Honest words about test money and the real state of the platforms.
    await expect(
      page.getByText('Тренировка и Demo идут на тестовые деньги, это не доход.'),
    ).toBeVisible()
    await expect(page.locator('#step-platforms')).toContainText('Начните с: kwork.ru, fl.ru')
    await expect(page.locator('#step-bybit-live-key')).toContainText('Spot Trade')
    await expect(page.getByRole('link', { name: 'Запуск' }).first()).toBeVisible()
  })
})

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

  test('settings open a new research season after the old one closed', async ({ page }) => {
    const closed = officeFixtures()
    closed.settings.researchEnabled = false
    const posted = await stubOffice(page, closed)
    await page.goto('/office/settings')
    await expect(page.getByText('Сезон исследований закрыт.')).toBeVisible()
    await page.getByRole('button', { name: 'Начать новый сезон' }).click()
    await expect
      .poll(() => posted.find((p) => p.url === '/api/control')?.body)
      .toEqual({ action: 'restart_research' })
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
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
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

  test('login sends the password and opens the main overview', async ({ page }) => {
    const posted = await stubOffice(page, fx)
    await page.goto('/office/login')
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Пароль', { exact: true }).fill('owner-password')
    await page.getByRole('button', { name: 'Войти' }).click()
    await expect(page).toHaveURL(/\/office$/)
    expect(posted[0]).toEqual({ url: '/api/auth/login', body: { password: 'owner-password' } })
  })

  test('the site root shows the public storefront, not the office login', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: /Тексты для малого бизнеса/ })).toBeVisible()
    await expect(page.getByText('Вход в кабинет')).toHaveCount(0)
  })

  test('old links lead to the new sections', async ({ page }) => {
    await stubOffice(page, fx)
    await page.goto('/?view=strategies')
    await expect(page).toHaveURL(/\/office\/agents$/)
    await page.goto('/office?view=opportunities')
    await expect(page).toHaveURL(/\/office\/leads$/)
  })
})

const overviewShots = join(process.cwd(), 'output/playwright/overview')
mkdirSync(overviewShots, { recursive: true })

for (const width of [1440, 390]) {
  test.describe(`income overview ${width}`, () => {
    test.use({ viewport: { width, height: width > 1000 ? 900 : 844 } })

    test('shows how the farm earns, keeping test money apart', async ({ page }) => {
      const errors = watchConsole(page)
      await stubOffice(page, fx)
      await page.goto('/office')
      await expect(page.getByRole('heading', { name: 'Как ферма зарабатывает' })).toBeVisible()
      const kpis = page.getByLabel('Деньги за период')
      await expect(kpis).toContainText('Реальный доход')
      await expect(kpis).toContainText('пока нет: торговля в тренировке')
      await expect(kpis).toContainText('Не выручка')
      await expect(kpis).toContainText(/−118,40\s₽/)
      await page.getByRole('button', { name: 'Сегодня' }).click()
      await expect(kpis).toContainText(/−4,12\s₽/)

      const sources = page.locator('.sources')
      await expect(sources.locator('li')).toHaveCount(fx.income.sources.length)
      await expect(sources).toContainText('Компьютер ИИ')
      await expect(sources).toContainText('Только тренировка')
      await expect(page.getByRole('heading', { name: 'Нужен человек' })).toBeVisible()
      await expect(page.getByText('Bybit: нет ключей')).toBeVisible()
      await expect(page.getByText('Bybit · Тест биржи: продал BTC').first()).toBeVisible()

      await page.getByRole('button', { name: /^Тест биржи/ }).click()
      await expect(page.locator('.lc-legend')).toContainText('Bybit')
      await expect(page.locator('.lc-legend')).not.toContainText('OKX')
      await page.getByRole('button', { name: /^Реальные/ }).click()
      await expect(page.getByText('за 30 дней нет отметок капитала')).toBeVisible()
      await page.getByRole('button', { name: /^Тренировка/ }).click()

      await expect(page.getByText('Оплачено деньгами')).toBeVisible()
      await expect(page.locator('.products')).toContainText(/1\s490\s₽/)
      await page.waitForTimeout(400)
      await noHorizontalScroll(page)
      if (width < 1024) await page.addStyleTag({ content: '.tabbar{position:static!important}' })
      await page.screenshot({ path: join(overviewShots, `overview-${width}.png`), fullPage: true })
      if (width > 1000) {
        await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
        await page.waitForTimeout(200)
        await noHorizontalScroll(page)
        await page.screenshot({
          path: join(overviewShots, `overview-dark-${width}.png`),
          fullPage: true,
        })
      }
      expect(errors).toEqual([])
    })
  })
}

const walletShots = join(process.cwd(), 'output/playwright/wallet')
mkdirSync(walletShots, { recursive: true })

for (const width of [1440, 390]) {
  test.describe(`wallet ${width}`, () => {
    test.use({ viewport: { width, height: width > 1000 ? 900 : 844 } })

    test('shows deposits apart from rubles and lets the owner classify them', async ({ page }) => {
      const errors = watchConsole(page)
      const posted = await stubOffice(page, fx)
      await page.goto('/office')
      const section = page.locator('section.wallet')
      await expect(section.getByRole('heading', { name: 'Поступления на кошелёк' })).toBeVisible()
      await expect(section).toContainText('только от зарубежных клиентов')
      await expect(section.locator('.is-income dd')).toHaveText('150,00 USDT')
      await expect(section.locator('.is-open dd')).toHaveText('75,00 USDT')
      await page.waitForTimeout(400)
      await noHorizontalScroll(page)
      if (width < 1024) await page.addStyleTag({ content: '.tabbar{position:static!important}' })
      await page.screenshot({ path: join(walletShots, `overview-${width}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Сегодня' }).click()
      await expect(section.locator('.is-income dd')).toHaveText('0 USDT')
      await expect(page.locator('.sources')).toContainText('Оплата криптой (Bybit)')
      await section.getByRole('button', { name: 'Не доход' }).first().click()
      await expect
        .poll(() => posted.map((p) => p.url))
        .toContain('/api/office/wallet/deposits/00000000-0000-4000-8000-000000000102')
      expect(posted.at(-1)!.body).toEqual({ classification: 'not_income' })

      await page.goto('/office/money')
      const card = page.locator('#wallet')
      await expect(card.getByRole('heading', { name: 'Оплата криптой (Bybit)' })).toBeVisible()
      await expect(card).toContainText(
        'Только для зарубежных клиентов; оплата криптой за услуги от резидентов РФ запрещена.',
      )
      await expect(card).toContainText('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf')
      await expect(card).toContainText('Только чтение: проверено')
      await expect(card.locator('.deposits li')).toHaveCount(fx.wallet.recent.length)
      await page.waitForTimeout(400)
      await noHorizontalScroll(page)
      if (width < 1024) await page.addStyleTag({ content: '.tabbar{position:static!important}' })
      await page.screenshot({ path: join(walletShots, `money-${width}.png`), fullPage: true })
      expect(errors).toEqual([])
    })
  })
}

test('logout clears assistant history without a render error and the next login starts empty', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = watchConsole(page)
  await stubOffice(page, fx)
  await page.route('**/api/office/assistant', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        text: 'Выберите группы агентов в разделе «Направления».',
        sections: ['earnings'],
        at: new Date().toISOString(),
        source: 'guide',
        reason: '',
      }),
    }),
  )
  await page.goto('/office')
  await expect(
    page.getByRole('heading', { name: 'Источники заработка', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Помощник', exact: true }).click()
  await page.getByLabel('Ваш вопрос', { exact: true }).fill('Как оставить только криптоторговлю?')
  await page.getByRole('button', { name: 'Отправить вопрос' }).click()
  await expect(page.getByRole('log')).toContainText('Выберите группы агентов')
  await page.getByRole('button', { name: 'Закрыть помощника' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page).toHaveURL(/\/office\/login$/)
  expect(errors).toEqual([])
  await page.getByLabel('Пароль', { exact: true }).fill('test-only-owner-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page).toHaveURL(/\/office$/)
  await expect(
    page.getByRole('heading', { name: 'Источники заработка', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Помощник', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Помогу разобраться в настройках')
  await expect(page.getByRole('log')).not.toContainText('Как оставить только криптоторговлю?')
  await expect(page.getByRole('log')).not.toContainText('Выберите группы агентов')
  expect(errors).toEqual([])
})

test('owner changes a role model, uploads manager context and deletes it', async ({ page }) => {
  const posted = await stubOffice(page, fx)
  await page.goto('/office/models?role=manager')
  await expect(page.getByLabel('Роль', { exact: true })).toHaveValue('manager')
  await expect(page.locator('#role-model option[value="vendor/eligible"]')).toHaveCount(1)
  await page.getByLabel('Модель', { exact: true }).selectOption('vendor/eligible')
  await page
    .getByLabel('Ваши инструкции для роли')
    .fill('Сначала исследовать комиссии и частоту сделок.')
  await page.getByRole('button', { name: 'Сохранить и применить' }).click()
  await expect
    .poll(() => posted.find((p) => p.url === '/api/office/trading-instructions')?.body)
    .toMatchObject({ role: 'manager', model: 'vendor/eligible' })
  await expect(page.getByRole('heading', { name: 'Действует версия 1' })).toBeVisible()
  await page.getByLabel('Загрузить текстовый файл').setInputFiles({
    name: 'market.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Наблюдаем комиссии на бумажном портфеле.'),
  })
  await page.getByRole('button', { name: 'Добавить контекст' }).click()
  await expect(page.locator('.context-item')).toContainText('market.txt')
  await expect
    .poll(() => posted.find((p) => p.url === '/api/office/models/context')?.body)
    .toMatchObject({ role: 'manager', content: 'Наблюдаем комиссии на бумажном портфеле.' })
  await page.getByRole('button', { name: 'Удалить контекст' }).click()
  await expect(page.locator('.context-item')).toHaveCount(0)
})

test('trading model catalog loads automatically and changing a model preserves unapplied text and rules', async ({
  page,
}) => {
  const errors = watchConsole(page)
  const posted = await stubOffice(page, fx)
  await page.goto('/office/trading-instructions')
  await expect(page.locator('#role-model option[value="vendor/small:free"]')).toHaveCount(1)
  const instruction = page.getByLabel('Правила торговли, ограничения и подход')
  await instruction.fill('Не покупать BTC')
  await page.getByLabel('Поиск модели OpenRouter').fill('small:free')
  await expect(page.locator('#role-model option[value="vendor/eligible"]')).toHaveCount(0)
  await page.getByLabel('Модель', { exact: true }).selectOption('vendor/small:free')
  await page.getByRole('button', { name: 'Сохранить модель', exact: true }).click()
  await expect
    .poll(() => posted.find((p) => p.url === '/api/office/models/model')?.body)
    .toEqual({ role: 'manager', model: 'vendor/small:free', revision: 0 })
  await expect(instruction).toHaveValue('Не покупать BTC')
  expect(posted.filter((p) => p.url === '/api/office/trading-instructions')).toHaveLength(0)
  await page.reload()
  await expect(page.getByLabel('Модель', { exact: true })).toHaveValue('vendor/small:free')
  await expect(instruction).toHaveValue('')
  await expect(
    page.getByRole('heading', { name: 'Дополнительные торговые правила пока не применены' }),
  ).toBeVisible()
  expect(errors).toEqual([])
})

test('waiting idea exposes revision and a human decision', async ({ page }) => {
  const own = officeFixtures()
  own.ideas[0]!.status = 'new'
  own.ideas[0]!.critique.verdict = 'PASS'
  own.ideas[0]!.product = null
  const posted = await stubOffice(page, own)
  await page.goto(`/office/ideas/${own.ideas[0]!.id}`)
  await expect(page.getByRole('button', { name: 'Принять идею' })).toBeVisible()
  await page
    .getByLabel('Что исправить или уточнить')
    .fill('Проверить спрос у небольших мастерских, уточнить цену.')
  await page.getByRole('button', { name: 'Внести правки и проверить заново' }).click()
  await expect
    .poll(() => posted.find((p) => p.url.endsWith('/decision'))?.body)
    .toMatchObject({
      action: 'revise',
      brief: 'Проверить спрос у небольших мастерских, уточнить цену.',
    })
})

for (const width of [1440, 390])
  for (const theme of ['light', 'dark']) {
    test(`new workspace states and assistant ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const errors = watchConsole(page)
      const posted = await stubOffice(page, fx)
      await page.route('**/api/office/assistant', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            text: 'Спот · BYBIT: Live · торговля включена. Фандинг Bybit: Paper · симуляция. Реальных операций нет.',
            sections: ['earnings'],
            at: new Date().toISOString(),
            source: 'guide',
            reason: 'OPENAI_BUDGET_BLOCKED',
          }),
        }),
      )
      await page.goto('/office/earnings')
      await expect(page.getByText('Спот · BYBIT')).toBeVisible()
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      await expect(page.locator('[data-group="real"]')).not.toContainText('Фандинг')
      await page.locator('[data-group="test"] summary').click()
      await expect(page.locator('[data-direction="funding"]')).toContainText('Paper · симуляция')
      await expect(page.locator('[data-direction="funding"]')).not.toContainText('Активно')
      await noHorizontalScroll(page)
      await page.screenshot({
        path: join(shots, `new-directions-${theme}-${width}.png`),
        fullPage: true,
      })
      await page.goto('/office/trading-instructions')
      await expect(
        page.getByRole('heading', { name: 'Правила торговли', exact: true }),
      ).toBeVisible()
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      await page.getByLabel('Правила торговли, ограничения и подход').fill('Не покупать BTC')
      await page.getByRole('button', { name: 'Сохранить и применить' }).click()
      await expect(page.getByRole('heading', { name: 'Действует версия 1' })).toBeVisible()
      expect(posted.some((p) => p.url === '/api/office/trading-instructions')).toBe(true)
      await noHorizontalScroll(page)
      await page.screenshot({
        path: join(shots, `new-instructions-${theme}-${width}.png`),
        fullPage: true,
      })
      await page.getByRole('button', { name: 'Помощник', exact: true }).click()
      await page.getByLabel('Ваш вопрос', { exact: true }).fill('Что сейчас работает?')
      await page.getByRole('button', { name: 'Отправить вопрос' }).click()
      await expect(page.getByRole('log')).toContainText('Справка без ИИ')
      await expect(page.getByRole('log')).toContainText('ИИ-ответ недоступен')
      await noHorizontalScroll(page)
      await page.screenshot({
        path: join(shots, `new-assistant-${theme}-${width}.png`),
        fullPage: true,
      })
      await page.getByRole('navigation', { name: 'Разделы из ответа' }).getByRole('link').click()
      await expect(page).toHaveURL(/office\/earnings$/)
      await page.getByRole('button', { name: 'Помощник', exact: true }).click()
      await expect(page.getByRole('log')).toContainText('Что сейчас работает?')
      expect(errors).toEqual([])
    })
  }

for (const width of [1440, 390]) {
  test(`trading stop and restart stays visible and explains a wrong confirmation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 })
    await stubOffice(page, officeFixtures())
    const { tradingFixtures } = await import('./fixtures/trading')
    const { view, overview } = tradingFixtures()
    const controls: Record<string, string>[] = []
    await page.route('**/api/office/autonomy', (route) =>
      route.fulfill({ json: { autopilotEnabled: true } }),
    )
    await page.route('**/api/trading**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/trading/control') {
        const body = route.request().postDataJSON()
        controls.push(body)
        if (body.action === 'stop_all') {
          view.status = 'stopped'
          view.reason = 'OWNER_STOP'
          overview.connections.forEach((c) => {
            c.status = 'stopped'
            c.error = 'OWNER_STOP'
          })
        } else if (body.action === 'start') {
          expect(body).toMatchObject({
            exchange: 'bybit',
            mode: 'live',
            confirmation: view.liveConfirmation,
          })
          view.status = 'running'
          view.reason = ''
          Object.assign(overview.connections[1]!, { status: 'running', error: '' })
        }
        return route.fulfill({ json: { ok: true } })
      }
      return route.fulfill({ json: url.pathname.endsWith('/overview') ? overview : view })
    })
    const errors = watchConsole(page)
    await page.goto('/office/trading')
    await expect(page.getByRole('button', { name: 'Открыть Bybit', exact: true })).toBeVisible()
    await page.getByLabel('Режим торговли').selectOption('live')
    await expect(page.getByLabel('Режим торговли')).toHaveValue('live')
    await expect(page.getByText('Торговля включена: 1 из 4 бирж.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Остановить всё', exact: true }).click()
    await expect(
      page.getByText('Торговля в этом режиме не запущена.', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText('Баланс портфелей', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Продолжить Bybit', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('ТОРГОВАТЬ НА 20 USDT НА BYBIT')
    await expect(dialog.getByText(/Фраза не совпадает. Проверьте/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Подтвердить', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Фраза не совпадает')
    expect(controls.filter((c) => c.action === 'start')).toHaveLength(0)
    await dialog.getByRole('textbox').fill(view.liveConfirmation)
    await dialog.getByRole('button', { name: 'Подтвердить', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Приостановить покупки', exact: true }),
    ).toBeVisible()
    expect(controls.filter((c) => c.action === 'start')).toHaveLength(1)
    await page.getByRole('button', { name: 'Все биржи', exact: true }).click()
    await expect(page.getByText('Торговля включена: 1 из 4 бирж.', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: `${shots}/trading-restart-${width}.png`, fullPage: true })
    expect(errors).toEqual([])
  })
}

test('stop all cancels a restart while the exchange details are still loading', async ({
  page,
}) => {
  await stubOffice(page, officeFixtures())
  const { tradingFixtures } = await import('./fixtures/trading')
  const { view, overview } = tradingFixtures('paper')
  view.status = 'stopped'
  view.reason = 'OWNER_STOP'
  overview.connections[1]!.status = 'stopped'
  overview.connections[1]!.error = 'OWNER_STOP'
  const controls: string[] = []
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/office/autonomy', (route) =>
    route.fulfill({ json: { autopilotEnabled: true } }),
  )
  await page.route('**/api/trading**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/trading/control') {
      controls.push(route.request().postDataJSON().action)
      release()
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/overview')) return route.fulfill({ json: overview })
    await pending
    return route.fulfill({ json: view })
  })
  await page.goto('/office/trading')
  await page.getByRole('button', { name: 'Продолжить Bybit', exact: true }).click()
  await page.getByRole('button', { name: 'Остановить всё', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeEnabled()
  expect(controls).toEqual(['stop_all'])
})
