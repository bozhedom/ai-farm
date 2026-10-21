import { z } from 'zod'
import { config } from '../config'
import { COMPUTER_USE_POLICY as P, type ElementInfo } from './policy'
import { VIEWPORT, type VmAction } from './schema'
import { pngSize, solidPng } from './png'

/** What the VM reports about the open page. The element fields are untrusted page data. */
export type PageState = { url: string; title: string; focused: ElementInfo | null }
export type ActionResult = { ok: boolean; error: string; url: string; title: string }

/** The worker's only way to the VM browser. Models never hold this client or its token. */
export interface VmAgentClient {
  readonly demo: boolean
  startSession(): Promise<string>
  state(sessionId: string): Promise<PageState>
  screenshot(sessionId: string): Promise<{ png: Buffer } & PageState & Partial<PageReading>>
  inspect(sessionId: string, x: number, y: number): Promise<ElementInfo | null>
  act(sessionId: string, action: VmAction): Promise<ActionResult>
  endSession(sessionId: string): Promise<void>
}

const elementSchema = z
  .object({
    tag: z.string().max(40).default(''),
    type: z.string().max(40).default(''),
    name: z.string().max(200).default(''),
    text: z.string().max(300).default(''),
    href: z.string().max(2000).default(''),
    autocomplete: z.string().max(100).default(''),
  })
  .nullable()
const stateSchema = z.object({
  url: z.string().max(4000).default(''),
  title: z.string().max(500).default(''),
  focused: elementSchema.default(null),
})
const actionSchema = stateSchema.extend({
  ok: z.boolean(),
  error: z.string().max(200).default(''),
})
const linkSchema = z.object({ text: z.string().max(200), href: z.string().max(2000) })
const screenshotSchema = stateSchema.extend({
  png: z.string().max(4_000_000),
  // Older agents send no reading; the model then works from the screenshot alone.
  text: z.string().max(8000).default(''),
  links: z.array(linkSchema).max(80).default([]),
})
export type PageReading = { text: string; links: z.infer<typeof linkSchema>[] }

/** Errors of the VM link itself; the task stops and the owner sees the reason. */
export class VmAgentUnavailable extends Error {
  constructor(code = 'COMPUTER_USE_VM_UNAVAILABLE') {
    super(code)
  }
}

export class HttpVmAgent implements VmAgentClient {
  readonly demo = false
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  /**
   * One HTTP request to the VM. Idempotent reads (`attempts` > 1) are retried once after a short
   * pause when the link fails or the agent answers 5xx; actions and session changes never are.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    options: { timeoutMs?: number; attempts?: number } = {},
  ): Promise<T> {
    const attempts = Math.max(1, options.attempts ?? 1)
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(
          method,
          path,
          schema,
          body,
          options.timeoutMs ?? P.agentReadTimeoutMs,
        )
      } catch (error) {
        const retryable =
          error instanceof VmAgentUnavailable &&
          (error.message === 'COMPUTER_USE_VM_UNAVAILABLE' ||
            /^COMPUTER_USE_VM_HTTP_5\d\d$/.test(error.message))
        if (!retryable || attempt >= attempts) throw error
        await new Promise((resolve) => setTimeout(resolve, P.agentRetryPauseMs))
      }
    }
  }

  private async once<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    let response: Response
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      response = await fetch(new URL(path, this.base), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal,
      })
    } catch {
      throw new VmAgentUnavailable()
    }
    if (response.status === 404) {
      await response.body?.cancel()
      throw new VmAgentUnavailable('COMPUTER_USE_SESSION_LOST')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new VmAgentUnavailable(`COMPUTER_USE_VM_HTTP_${response.status}`)
    }
    let raw: string
    try {
      // The same deadline covers the body: a VM that stalls mid-answer is unavailable too.
      raw = await response.text()
    } catch {
      throw new VmAgentUnavailable()
    }
    if (raw.length > 6_000_000) throw new VmAgentUnavailable('COMPUTER_USE_VM_RESPONSE_TOO_LARGE')
    try {
      return schema.parse(JSON.parse(raw))
    } catch {
      throw new VmAgentUnavailable('COMPUTER_USE_VM_RESPONSE_INVALID')
    }
  }
  async startSession() {
    const { sessionId } = await this.request(
      'POST',
      '/sessions',
      z.object({ sessionId: z.string().regex(/^[0-9a-f-]{36}$/) }),
      {},
      // The first session may start Chromium on the VM.
      { timeoutMs: P.agentActionTimeoutMs },
    )
    return sessionId
  }
  state(sessionId: string) {
    return this.request('GET', `/sessions/${sessionId}`, stateSchema, undefined, {
      attempts: P.agentReadAttempts,
    })
  }
  async screenshot(sessionId: string) {
    const data = await this.request(
      'GET',
      `/sessions/${sessionId}/screenshot`,
      screenshotSchema,
      undefined,
      { attempts: P.agentReadAttempts },
    )
    const png = Buffer.from(data.png, 'base64')
    const size = pngSize(png)
    if (!size || png.length > P.maxScreenshotBytes || size.width > VIEWPORT.width * 2)
      throw new VmAgentUnavailable('COMPUTER_USE_SCREENSHOT_INVALID')
    return {
      png,
      url: data.url,
      title: data.title,
      focused: data.focused,
      text: data.text,
      links: data.links,
    }
  }
  inspect(sessionId: string, x: number, y: number) {
    return this.request(
      'POST',
      `/sessions/${sessionId}/inspect`,
      z.object({ element: elementSchema }),
      { x, y },
      { attempts: P.agentReadAttempts },
    ).then((r) => r.element)
  }
  act(sessionId: string, action: VmAction) {
    return this.request('POST', `/sessions/${sessionId}/actions`, actionSchema, action, {
      timeoutMs: P.agentActionTimeoutMs,
    })
  }
  async endSession(sessionId: string) {
    await this.request('DELETE', `/sessions/${sessionId}`, z.object({ ok: z.boolean() })).catch(
      () => undefined,
    )
  }
}

/**
 * In-process stand-in for the VM: demo mode and tests. It keeps a URL per session, answers with
 * a grey PNG and performs no network access at all. Every answer is clearly synthetic.
 */
export class FakeVmAgent implements VmAgentClient {
  readonly demo = true
  readonly sessions = new Map<string, { url: string; history: string[] }>()
  readonly actions: { sessionId: string; action: VmAction }[] = []
  constructor(
    private readonly options: {
      focused?: ElementInfo | null
      target?: ElementInfo | null
      fail?: (action: VmAction) => string
    } = {},
  ) {}
  async startSession() {
    const id = crypto.randomUUID()
    this.sessions.set(id, { url: 'about:blank', history: [] })
    return id
  }
  private session(id: string) {
    const session = this.sessions.get(id)
    if (!session) throw new VmAgentUnavailable('COMPUTER_USE_SESSION_LOST')
    return session
  }
  async state(sessionId: string) {
    const session = this.session(sessionId)
    return {
      url: session.url,
      title: session.url === 'about:blank' ? 'Демонстрация' : `Демонстрация: ${session.url}`,
      focused: this.options.focused ?? null,
    }
  }
  async screenshot(sessionId: string) {
    return { png: solidPng(64, 40, [226, 222, 212]), ...(await this.state(sessionId)) }
  }
  async inspect(sessionId: string) {
    this.session(sessionId)
    return this.options.target ?? null
  }
  async act(sessionId: string, action: VmAction) {
    const session = this.session(sessionId)
    this.actions.push({ sessionId, action })
    const error = this.options.fail?.(action) || ''
    if (!error) {
      if (action.name === 'navigate') {
        session.history.push(session.url)
        session.url = action.url
      } else if (action.name === 'back') session.url = session.history.pop() || session.url
    }
    const state = await this.state(sessionId)
    return { ok: !error, error, url: state.url, title: state.title }
  }
  async endSession(sessionId: string) {
    this.sessions.delete(sessionId)
  }
}

/** The configured link to the VM, or the in-process stand-in in demo mode. */
export function vmAgentFromConfig(): VmAgentClient {
  const c = config()
  if (c.MODEL_PROVIDER === 'demo') return new FakeVmAgent()
  if (!c.VM_AGENT_URL || !c.VM_AGENT_TOKEN) throw new Error('COMPUTER_USE_VM_NOT_CONFIGURED')
  return new HttpVmAgent(c.VM_AGENT_URL, c.VM_AGENT_TOKEN)
}
