import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { elementScript, fillLogin, run } from '../../vm-agent/src/browser'

/**
 * The stored-login fill on a real Chromium: pages are served by request interception, so the
 * https platform address is checked without any network. Skipped where Chromium is missing.
 */
let browser: Browser | null = null
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null)
})
afterAll(async () => {
  await browser?.close()
})

const loginPage = `<!doctype html><html><body>
<form id="search"><input name="q" type="text" placeholder="Поиск"></form>
<form id="login" onsubmit="event.preventDefault(); document.body.dataset.sent = new FormData(this).get('email') + '|' + new FormData(this).get('pass')">
  <input name="email" type="email" placeholder="Почта">
  <input name="hidden" type="text" style="display:none">
  <input name="pass" type="password" autocomplete="current-password">
  <button>Войти</button>
</form></body></html>`
const twoStep = `<!doctype html><html><body>
<form onsubmit="event.preventDefault(); document.body.dataset.sent = this.login.value">
  <input name="q" type="search"><input name="login" type="text" autocomplete="username">
  <button>Далее</button>
</form></body></html>`

async function open(url: string, html: string): Promise<Page> {
  const page = await browser!.newPage()
  await page.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
  )
  await page.goto(url)
  return page
}
const fill = { name: 'fill_login' as const, username: 'me@mail.ru', password: 'Pa55-secret' }

describe.runIf(process.env.CI !== 'true')('VM stored-login fill on Chromium', () => {
  it('fills the login form of the platform, not the search box, and submits it', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await open('https://www.fl.ru/login/', loginPage)
    expect(await fillLogin(page, { ...fill, hosts: ['fl.ru'] })).toBe('')
    expect(await page.evaluate(() => document.body.dataset.sent)).toBe('me@mail.ru|Pa55-secret')
    expect(await page.inputValue('[name=q]')).toBe('')
    expect(await page.locator('[data-farm-login]').count()).toBe(0)
    // The focused password field is described without its value.
    await page.focus('[name=pass]')
    const focused = await run<{ text: string; type: string }>(page, elementScript)
    expect(focused.type).toBe('password')
    expect(JSON.stringify(focused)).not.toContain('Pa55')
    // The element under a point is described too (the click policy depends on it).
    const box = (await page.locator('button').boundingBox())!
    const target = await run<{ tag: string; text: string }>(page, elementScript, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    })
    expect(target).toMatchObject({ tag: 'button', text: 'Войти' })
    await page.focus('[name=email]')
    expect(await run(page, elementScript)).toMatchObject({ type: 'email', text: 'me@mail.ru' })
    await page.close()
  })

  it('refuses another host and plain http without touching the fields', async (ctx) => {
    if (!browser) return ctx.skip()
    for (const url of ['https://fl.ru.evil.example/login', 'http://www.fl.ru/login/']) {
      const page = await open(url, loginPage)
      expect(await fillLogin(page, { ...fill, hosts: ['fl.ru'] })).toBe('LOGIN_HOST_MISMATCH')
      expect(await page.inputValue('[name=pass]')).toBe('')
      expect(await page.inputValue('[name=email]')).toBe('')
      await page.close()
    }
  })

  it('fills the login step of a two-step form and reports a page without a form', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await open('https://kwork.ru/login', twoStep)
    expect(await fillLogin(page, { ...fill, hosts: ['kwork.ru'] })).toBe('')
    expect(await page.evaluate(() => document.body.dataset.sent)).toBe('me@mail.ru')
    await page.close()
    const empty = await open('https://kwork.ru/', '<!doctype html><p>Нет формы</p>')
    expect(await fillLogin(empty, { ...fill, hosts: ['kwork.ru'] })).toBe('LOGIN_FORM_NOT_FOUND')
    await empty.close()
  })
})
