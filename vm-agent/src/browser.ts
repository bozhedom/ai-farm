import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { targetAllowed } from './guard'
import { startProxy, type Proxy } from './proxy'
import { VIEWPORT, type Action } from './actions'

/**
 * One persistent Chromium profile per machine (PROFILE_DIR, a Docker volume), so platform
 * logins the owner made survive tasks and restarts. Each session is one page of that profile.
 * Pop-ups are folded into the opener, dialogs are dismissed, downloads are cancelled and every
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
export const MAX_SESSIONS = 3
export const PROFILE_DIR = process.env.VM_AGENT_PROFILE_DIR || '/agent/profile'
const NAVIGATION_TIMEOUT_MS = 20_000
// After an action that may load a page, the snapshot waits for the document and a short quiet
// network, so the model rarely needs an explicit `wait`. Both waits are bounded: a page that
// never goes quiet (analytics, long polling) costs at most SETTLE_MS + NETWORK_IDLE_MS.
export const SETTLE_MS = 5000
export const NETWORK_IDLE_MS = 2500

type Loadable = Pick<Page, 'waitForLoadState'>
/** Waits for domcontentloaded, then a quiet network, never longer than the two bounds. */
export async function settle(page: Loadable, settleMs = SETTLE_MS, idleMs = NETWORK_IDLE_MS) {
  await page.waitForLoadState('domcontentloaded', { timeout: settleMs }).catch(() => undefined)
  await page.waitForLoadState('networkidle', { timeout: idleMs }).catch(() => undefined)
}

type Session = { id: string; page: Page; lastUsedAt: number }

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
  private context: BrowserContext | null = null
  private proxy: Proxy | null = null
  private readonly sessions = new Map<string, Session>()

  private async launch() {
    // A persistent context has no Browser object: a crashed Chromium shows up as a `close`
    // event, which drops the context so the next session launches a fresh one.
    if (this.context) return this.context
    this.proxy ??= await startProxy()
    mkdirSync(PROFILE_DIR, { recursive: true })
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: ['--disable-dev-shm-usage', '--disable-background-networking'],
      // Everything, loopback included, goes through the guarding proxy.
      proxy: { server: `http://127.0.0.1:${this.proxy.port}`, bypass: '<-loopback>' },
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
    context.on('page', (popup) => void this.foldPopup(popup))
    context.on('close', () => {
      if (this.context !== context) return
      this.context = null
      this.sessions.clear()
    })
    // The profile opens with one blank page of its own; sessions get pages of their own.
    for (const page of context.pages()) await page.close().catch(() => undefined)
    this.context = context
    return context
  }

  /** A page opened by a link continues in the opener's page; pages of sessions are left alone. */
  private async foldPopup(popup: Page) {
    const opener = await popup.opener().catch(() => null)
    if (!opener) return
    const session = [...this.sessions.values()].find((s) => s.page === opener)
    const url = await Promise.race([
      popup.waitForLoadState('domcontentloaded', { timeout: 3000 }).then(() => popup.url()),
      pause(3000).then(() => popup.url()),
    ]).catch(() => popup.url())
    await popup.close().catch(() => undefined)
    if (session && url && url !== 'about:blank' && (await targetAllowed(url)))
      await session.page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
        .catch(() => undefined)
  }

  async start(): Promise<string> {
    await this.expire()
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('SESSION_LIMIT')
    const context = await this.launch()
    const page = await context.newPage()
    const id = randomUUID()
    const session: Session = { id, page, lastUsedAt: Date.now() }
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => undefined))
    page.on('download', (download) => download.cancel().catch(() => undefined))
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
    await session.page.close().catch(() => undefined)
    return true
  }

  async expire(now = Date.now()) {
    for (const session of [...this.sessions.values()])
      if (now - session.lastUsedAt > SESSION_IDLE_MS) await this.end(session.id)
  }

  async close() {
    for (const id of [...this.sessions.keys()]) await this.end(id)
    // Closing the persistent context flushes cookies and storage to the profile directory.
    await this.context?.close().catch(() => undefined)
    this.context = null
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

  /** Visible text and links of the page, trimmed: the model reads instead of clicking around. */
  async reading(
    session: Session,
  ): Promise<{ text: string; links: { text: string; href: string }[] }> {
    const data = await session.page
      .evaluate(() => {
        const text = (document.body?.innerText || '')
          .replace(/\s+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => ({
            text: ((a as HTMLElement).innerText || a.getAttribute('aria-label') || '')
              .trim()
              .slice(0, 120),
            href: (a as HTMLAnchorElement).href,
          }))
          .filter((l) => l.text && /^https?:/.test(l.href))
        return { text: text.slice(0, 6000), links: links.slice(0, 60) }
      })
      .catch(() => ({ text: '', links: [] }))
    return data
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
          await settle(page)
          break
        case 'click':
          await page.mouse.click(action.x, action.y)
          // A link starts its navigation a moment after the click.
          await pause(300)
          await settle(page)
          break
        case 'type':
          await page.keyboard.type(action.text, { delay: 10 })
          break
        case 'insert_text':
          // insertText dispatches no key events: "\n" becomes a line break, never a submit.
          await page.keyboard.insertText(action.text)
          break
        case 'key':
          await page.keyboard.press(action.key === 'Space' ? ' ' : action.key)
          if (action.key === 'Enter') {
            await pause(300)
            await settle(page)
          } else
            await page
              .waitForLoadState('domcontentloaded', { timeout: 3000 })
              .catch(() => undefined)
          break
        case 'scroll':
          await page.mouse.move(action.x, action.y)
          await page.mouse.wheel(0, action.deltaY)
          await pause(200)
          break
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
          await settle(page)
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
