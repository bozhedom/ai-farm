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

export const elementScript = `(target) => {
  const pick = (node) => {
    if (!node || node.nodeType !== 1) return null
    const el = node.closest('a,button,input,select,textarea,[role=button],[contenteditable]') || node
    // A password field's value is never read: it would reach the farm, the step log and the model.
    const secret = String(el.getAttribute('type') || '').toLowerCase() === 'password' ||
      /password/i.test(String(el.getAttribute('autocomplete') || ''))
    const text = (el.innerText || (secret ? '' : el.value) || el.getAttribute('aria-label') || el.alt || '')
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

/**
 * The owner's stored login is filled only on an https page of one of the platform's hosts (or
 * their subdomains). The farm checks this before sending; the agent checks it again here, right
 * before and after locating the fields, so a page that navigated away never receives the values.
 */
export function loginHostAllowed(url: string, hosts: readonly string[]) {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  return hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * Marks the visible login fields of the main frame: the first visible password field and the
 * text, email or phone field right before it (in the same form when there is one); without a
 * password field (two-step logins) a field that looks like a login. Nothing is read back.
 */
const markLoginScript = `() => {
  for (const el of document.querySelectorAll('[data-farm-login]')) el.removeAttribute('data-farm-login')
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly
  }
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible)
  const textLike = (el) => ['text', 'email', 'tel'].includes(el.type)
  const named = (el) => el.type === 'email' || el.type === 'tel' ||
    /user|login|mail|phone|логин|почт|телефон/i.test([el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label') || ''].join(' '))
  const password = inputs.find((el) => el.type === 'password') || null
  let user = null
  if (password) {
    const scope = password.form ? inputs.filter((el) => el.form === password.form) : inputs
    user = scope.filter((el) => textLike(el) && (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1) || null
  } else user = inputs.find((el) => textLike(el) && named(el)) || null
  if (password) password.setAttribute('data-farm-login', 'password')
  if (user) user.setAttribute('data-farm-login', 'user')
  return { user: !!user, password: !!password }
}`
const unmarkLoginScript = `() => { for (const el of document.querySelectorAll('[data-farm-login]')) el.removeAttribute('data-farm-login') }`

type FillLogin = Extract<Action, { name: 'fill_login' }>
/** Fills the login fields and presses Enter in the last one; returns an error code or ''. */
export async function fillLogin(page: Page, action: FillLogin) {
  if (!loginHostAllowed(page.url(), action.hosts)) return 'LOGIN_HOST_MISMATCH'
  const found = await run<{ user: boolean; password: boolean }>(page, markLoginScript)
  if (!found.user && !found.password) return 'LOGIN_FORM_NOT_FOUND'
  if (!loginHostAllowed(page.url(), action.hosts)) return 'LOGIN_HOST_MISMATCH'
  // The marks live in the checked document only: after a navigation the locators find nothing
  // and the fill times out instead of typing into another page.
  if (found.user)
    await page.locator('[data-farm-login=user]').fill(action.username, { timeout: 5000 })
  if (found.password)
    await page.locator('[data-farm-login=password]').fill(action.password, { timeout: 5000 })
  await page
    .locator(`[data-farm-login=${found.password ? 'password' : 'user'}]`)
    .press('Enter', { timeout: 5000 })
  await run(page, unmarkLoginScript).catch(() => undefined)
  return ''
}

/**
 * Runs a function given as source text with one JSON argument. A string passed to
 * `page.evaluate` is an expression: a function in it is returned, never called (the result was
 * always undefined). The scripts stay strings because tsx rewrites real functions with helpers
 * that do not exist in the page.
 */
export function run<T>(page: Pick<Page, 'evaluate'>, script: string, arg: unknown = null) {
  return page.evaluate(`(${script})(${JSON.stringify(arg)})`) as Promise<T>
}

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
    const focused = await run(page, elementScript).catch(() => null)
    return {
      url: page.url(),
      title: (await page.title().catch(() => '')).slice(0, 500),
      focused: (focused as Element | null) ?? null,
    }
  }

  async inspect(session: Session, x: number, y: number): Promise<Element | null> {
    const element = await run(session.page, elementScript, { x, y }).catch(() => null)
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
        case 'fill_login': {
          const error = await fillLogin(page, action)
          if (error) return { ok: false, error }
          await pause(300)
          await settle(page)
          break
        }
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
