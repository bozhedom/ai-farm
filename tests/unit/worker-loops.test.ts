import { describe, expect, it, vi } from 'vitest'
import { createLoopRunner, loopSpecs } from '../../core/worker-loops'

function runner() {
  let now = 1_000_000
  const finished = vi.fn(async (_name: string, _error?: unknown) => {})
  const started = vi.fn(async (_name: string) => {})
  const log = vi.fn()
  const loops = createLoopRunner({ started, finished, log, now: () => now })
  return { loops, finished, started, log, advance: (ms: number) => (now += ms) }
}

describe('worker loop runner', () => {
  it('keeps the other loops running when one throws', async () => {
    const { loops, finished, log } = runner()
    const healthy = vi.fn(async () => {})
    loops.background('earnings', async () => {
      throw new Error('EARNINGS_SOURCE_DOWN')
    })
    loops.background('payments', healthy)
    await Promise.all(loops.running)
    expect(healthy).toHaveBeenCalledOnce()
    expect(finished).toHaveBeenCalledWith('earnings', expect.any(Error))
    expect(finished).toHaveBeenCalledWith('payments')
    expect(log).toHaveBeenCalledWith('WORKER_LOOP_FAILED earnings EARNINGS_SOURCE_DOWN')
    // The failed loop runs again on the next tick.
    expect(loops.background('earnings', async () => {})).toBe(true)
    await Promise.all(loops.running)
  })

  it('lets a failing step return nothing and the tick continue', async () => {
    const { loops, log } = runner()
    expect(
      await loops.step('recovery', async () => {
        throw new Error('database said https://secret.example/?key=1')
      }),
    ).toBeUndefined()
    expect(log).toHaveBeenCalledWith('WORKER_LOOP_FAILED recovery LOOP_FAILED')
    expect(await loops.step('providers', async () => 42)).toBe(42)
  })

  it('runs one instance per loop and reports a stuck one', async () => {
    const { loops, advance } = runner()
    let release!: () => void
    const blocked = new Promise<void>((done) => (release = done))
    expect(loops.background('execution', () => blocked)).toBe(true)
    expect(loops.background('execution', async () => {})).toBe(false)
    expect(loops.stuck()).toEqual([])
    advance(loopSpecs.execution!.stuckMs + 1)
    expect(loops.stuck()).toEqual(['execution'])
    release()
    await Promise.all(loops.running)
    expect(loops.stuck()).toEqual([])
  })

  it('writes successes at most every 30 seconds but every failure', async () => {
    const { loops, finished, advance } = runner()
    await loops.step('tick', async () => {})
    await loops.step('tick', async () => {})
    expect(finished).toHaveBeenCalledTimes(1)
    await loops.step('tick', async () => {
      throw new Error('X_FAILED')
    })
    await loops.step('tick', async () => {
      throw new Error('X_FAILED')
    })
    expect(finished).toHaveBeenCalledTimes(3)
    await loops.step('tick', async () => {})
    expect(finished).toHaveBeenCalledTimes(4)
    advance(10_000)
    await loops.step('tick', async () => {})
    expect(finished).toHaveBeenCalledTimes(4)
  })

  it('survives a heartbeat write failure', async () => {
    const log = vi.fn()
    const loops = createLoopRunner({
      started: async () => {},
      finished: async () => {
        throw new Error('DB_DOWN')
      },
      log,
      now: Date.now,
    })
    expect(await loops.step('tick', async () => 'ok')).toBe('ok')
    expect(log).toHaveBeenCalledWith('WORKER_LOOP_HEARTBEAT_FAILED')
  })
})
