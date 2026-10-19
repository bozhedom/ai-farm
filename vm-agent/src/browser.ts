import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { targetAllowed } from './guard'
import { startProxy, type Proxy } from './proxy'
import { VIEWPORT, type Action } from './actions'

/**
 * One headless Chromium per process, one context per session, one page per context. Pop-ups
 * are folded into the main page, dialogs are dismissed, downloads are cancelled and every
 * request passes the network guard twice: the route hook refuses by name, and the loopback
 * proxy connects only to the public address it resolved itself (no DNS rebinding, WebSockets
 * included). Nothing here knows about the farm or holds its secrets.
 */
export type Element = {
  tag: string
  type: string
  name: string
  text: string
  href: string
  autocomplete: string
}
export type PageState = { url: string; title: string; focused: Element | null }

export const SESSION_IDLE_MS = 30 * 60_000
export const MAX_SESSIONS = 2
const NAVIGATION_TIMEOUT_MS = 20_000

type Session = { id: string; context: BrowserContext; page: Page; lastUsedAt: number }

const elementScript = `(target) => {
  const pick = (node) => {
    if (!node || node.nodeType !== 1) return null
    const el = node.closest('a,button,input,select,textarea,[role=button],[contenteditable]') || node
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.alt || '')
    return {
      tag: String(el.tagName || '').toLowerCase().slice(0, 40),
      type: String(el.getAttribute('type') || el.getAttribute('role') || '').toLowerCase().slice(0, 40),
      name: String(el.getAttribute('name') || el.id || '').slice(0, 200),
      text: String(text).replace(/\\s+/g, ' ').trim().slice(0, 300),
      href: String(el.href || '').slice(0, 2000),
      autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase().slice(0, 100),
    }
  }
  if (target && typeof target.x === 'number') return pick(document.elementFromPoint(target.x, target.y))
  const active = document.activeElement
  return active && active !== document.body ? pick(active) : null
}`

/** Pages the model may stay on after an action; anything else goes back to a blank page. */
export const pageSchemeAllowed = (url: string) => /^https?:/.test(url) || url === 'about:blank'

export class Sessions {
  private browser: Browser | null = null
  private proxy: Proxy | null = null
  private readonly sessions = new Map<string, Session>()

  private async launch() {
    if (this.browser?.isConnected()) return this.browser
    this.proxy ??= await startProxy()
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--disable-background-networking'],
      // Everything, loopback included, goes through the guarding proxy.
      proxy: { server: `http://127.0.0.1:${this.proxy.port}`, bypass: '<-loopback>' },
    })
    return this.browser
  }

  async start(): Promise<string> {
    await this.expire()
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('SESSION_LIMIT')
    const browser = await this.launch()
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
      locale: 'ru-RU',
      ignoreHTTPSErrors: false,
    })
    await context.route('**/*', async (route, request) => {
      if (await targetAllowed(request.url())) await route.continue()
      else await route.abort('blockedbyclient')
    })
    const page = await context.newPage()
    const id = randomUUID()
    const session: Session = { id, context, page, lastUsedAt: Date.now() }
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => undefined))
    page.on('download', (download) => download.cancel().catch(() => undefined))
    context.on('page', async (popup) => {
      // A link that opens a new tab continues in the one page the model sees.
      const url = await Promise.race([
        popup.waitForLoadState('domcontentloaded', { timeout: 3000 }).then(() => popup.url()),
        pause(3000).then(() => popup.url()),
      ]).catch(() => popup.url())
      await popup.close().catch(() => undefined)
      if (url && url !== 'about:blank' && (await targetAllowed(url)))
        await page
          .goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
          .catch(() => undefined)
    })
    this.sessions.set(id, session)
    return id
  }

  get(id: string) {
    const session = this.sessions.get(id)
    if (!session) return null
    session.lastUsedAt = Date.now()
    return session
  }

  async end(id: string) {
    const session = this.sessions.get(id)
    if (!session) return false
    this.sessions.delete(id)
    await session.context.close().catch(() => undefined)
    return true
  }

  async expire(now = Date.now()) {
    for (const session of [...this.sessions.values()])
      if (now - session.lastUsedAt > SESSION_IDLE_MS) await this.end(session.id)
  }

  async close() {
    for (const id of [...this.sessions.keys()]) await this.end(id)
    await this.browser?.close().catch(() => undefined)
    this.browser = null
    await this.proxy?.close().catch(() => undefined)
    this.proxy = null
  }

  async state(session: Session): Promise<PageState> {
    const { page } = session
    const focused = await page.evaluate(elementScript, null).catch(() => null)
    return {
      url: page.url(),
      title: (await page.title().catch(() => '')).slice(0, 500),
      focused: (focused as Element | null) ?? null,
    }
  }

  async inspect(session: Session, x: number, y: number): Promise<Element | null> {
    const element = await session.page.evaluate(elementScript, { x, y }).catch(() => null)
    return (element as Element | null) ?? null
  }

  async screenshot(session: Session) {
    const png = await session.page.screenshot({ type: 'png', scale: 'css', animations: 'disabled' })
    return png.toString('base64')
  }

  /** Executes one validated action; failures come back as a short code, never as a throw. */
  async act(session: Session, action: Action): Promise<{ ok: boolean; error: string }> {
    const { page } = session
    try {
      switch (action.name) {
        case 'navigate':
          if (!(await targetAllowed(action.url))) return { ok: false, error: 'TARGET_BLOCKED' }
          await page.goto(action.url, {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT_MS,
          })
          break
        case 'click':
          await page.mouse.click(action.x, action.y)
          await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined)
          await pause(300)
          break
        case 'type':
          await page.keyboard.type(action.text, { delay: 10 })
          break
        case 'key':
          await page.keyboard.press(action.key === 'Space' ? ' ' : action.key)
          await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined)
          break
        case 'scroll':
          await page.mouse.move(action.x, action.y)
          await page.mouse.wheel(0, action.deltaY)
          await pause(200)
          break
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
          break
        case 'wait':
          await pause(action.ms)
          break
      }
      if (!pageSchemeAllowed(page.url())) {
        // A link into file:, data:, blob: or a browser page: leave it before the next snapshot.
        await page.goto('about:blank').catch(() => undefined)
        return { ok: false, error: 'TARGET_BLOCKED' }
      }
      return { ok: true, error: '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return {
        ok: false,
        error: /blockedbyclient|ERR_BLOCKED_BY_CLIENT/.test(message)
          ? 'TARGET_BLOCKED'
          : /Timeout/i.test(message)
            ? 'NAVIGATION_TIMEOUT'
            : 'ACTION_FAILED',
      }
    }
  }
}
