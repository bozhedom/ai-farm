import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpVmAgent } from '../../core/computer-use/client'
import { COMPUTER_USE_POLICY as P } from '../../core/computer-use/policy'
import { solidPng } from '../../core/computer-use/png'
import { NETWORK_IDLE_MS, SETTLE_MS, settle } from '../../vm-agent/src/browser'

const sessionId = '00000000-0000-4000-8000-000000000001'
const shot = () =>
  new Response(
    JSON.stringify({
      png: solidPng(8, 5, [1, 2, 3]).toString('base64'),
      url: 'https://example.com/',
      title: 'Пример',
      focused: null,
    }),
  )
const agent = () => new HttpVmAgent('http://10.0.0.9:8787/', 'x'.repeat(40))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('VM agent client: bounded timeouts and retries', () => {
  it('retries an idempotent read once after a link failure, then answers', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(shot())
    vi.stubGlobal('fetch', fetchMock)
    const result = await agent().screenshot(sessionId)
    expect(result.url).toBe('https://example.com/')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up on an unreachable VM after the bounded attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(agent().screenshot(sessionId)).rejects.toThrow('COMPUTER_USE_VM_UNAVAILABLE')
    expect(fetchMock).toHaveBeenCalledTimes(P.agentReadAttempts)
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(new Response('busy', { status: 503 }))
    await expect(agent().state(sessionId)).rejects.toThrow('COMPUTER_USE_VM_HTTP_503')
    expect(fetchMock).toHaveBeenCalledTimes(P.agentReadAttempts)
  })

  it('never repeats an action or a lost session', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(agent().act(sessionId, { name: 'back' })).rejects.toThrow(
      'COMPUTER_USE_VM_UNAVAILABLE',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }))
    await expect(agent().screenshot(sessionId)).rejects.toThrow('COMPUTER_USE_SESSION_LOST')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses a short read deadline and a longer one for actions', async () => {
    const timeouts: number[] = []
    const real = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      timeouts.push(ms)
      return real(ms)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        String(url).endsWith('/actions')
          ? new Response(JSON.stringify({ ok: true, url: 'https://example.com/', title: '' }))
          : shot(),
      ),
    )
    await agent().screenshot(sessionId)
    await agent().act(sessionId, { name: 'navigate', url: 'https://example.com/' })
    expect(timeouts).toEqual([P.agentReadTimeoutMs, P.agentActionTimeoutMs])
    // An unreachable VM costs at most two short reads and a pause per snapshot.
    expect(P.agentReadAttempts * P.agentReadTimeoutMs + P.agentRetryPauseMs).toBeLessThan(60_000)
    vi.restoreAllMocks()
  })
})

describe('VM agent: page settling after navigation actions', () => {
  it('waits for the document and a quiet network, both bounded, and swallows timeouts', async () => {
    const calls: [string, number][] = []
    const page = {
      waitForLoadState: vi.fn(async (state: string, options?: { timeout?: number }) => {
        calls.push([state, options?.timeout ?? 0])
        if (state === 'networkidle') throw new Error('Timeout 2500ms exceeded')
      }),
    }
    await expect(settle(page as never)).resolves.toBeUndefined()
    expect(calls).toEqual([
      ['domcontentloaded', SETTLE_MS],
      ['networkidle', NETWORK_IDLE_MS],
    ])
    // A navigate (20 s) plus settling still fits into the client's action deadline.
    expect(20_000 + SETTLE_MS + NETWORK_IDLE_MS).toBeLessThan(P.agentActionTimeoutMs)
  })
})
