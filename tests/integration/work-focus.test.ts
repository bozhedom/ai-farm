import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import { applyMigrations, resetDatabase } from './helpers/db'
import { saveWorkFocus, workFocus, directionAllowed, WorkFocusPaused } from '../../core/work-focus'
import { cryptoDirections } from '../../core/contracts/work-focus'
import { claimJob, enqueue, finishJob } from '../../core/queue'
import { meteredCall, reserveBudget } from '../../core/budget'
import { controlManager } from '../../core/manager/runtime'
import { controlComputerUse, computerUseTick } from '../../core/computer-use/runtime'
import { FakeVmAgent } from '../../core/computer-use/client'
import { controlEarnings, earningsTick } from '../../core/earnings/monitor'
import { workFocusSchema } from '../../core/contracts/work-focus'

beforeAll(applyMigrations)
beforeEach(() => resetDatabase())
afterAll(() => pool.end())
const focus = (selected = cryptoDirections, revision = 0) =>
  saveWorkFocus({
    enabled: true,
    selected,
    duration: 'day',
    revision,
  })

it('holds queued farm work without losing attempts, preserves switches and expires on database time', async () => {
  const queued = await enqueue('scout', 'focus-scout')
  await query('UPDATE system_state SET schedule_enabled=true WHERE id=true')
  const before = await query('SELECT mode,schedule_enabled FROM system_state')
  const saved = await focus()
  expect(saved.active).toBe(true)
  expect(Date.parse(saved.until!) - Date.now()).toBeGreaterThan(86_300_000)
  expect(await claimJob(['scout'])).toBeUndefined()
  await expect(enqueue('research', 'blocked-manual')).rejects.toThrow('WORK_FOCUS_PAUSED')
  expect(await query('SELECT mode,schedule_enabled FROM system_state')).toEqual(before)
  expect(
    (await query('SELECT status,attempts FROM jobs WHERE id=$1', [queued.id]))[0],
  ).toMatchObject({ status: 'queued', attempts: 0 })
  await query("UPDATE work_focus SET until_at=now()-interval '1 second'")
  expect((await workFocus()).active).toBe(false)
  expect((await claimJob(['scout']))?.id).toBe(queued.id)
})

it('rejects stale focus changes and malformed selections without overwriting a newer choice', async () => {
  await focus()
  await expect(focus(['studio'])).rejects.toThrow('WORK_FOCUS_CHANGED')
  expect((await workFocus()).selected).toEqual(cryptoDirections)
  expect(
    workFocusSchema.safeParse({ enabled: true, selected: [], duration: 'day', revision: 1 })
      .success,
  ).toBe(false)
  expect(
    workFocusSchema.safeParse({ enabled: true, selected: ['shell'], duration: 'day', revision: 1 })
      .success,
  ).toBe(false)
  await saveWorkFocus({
    enabled: false,
    selected: cryptoDirections,
    duration: 'manual',
    revision: 1,
  })
  expect(await directionAllowed('studio')).toBe(true)
})

it('returns an interrupted farm step to the queue and still completes accepted orders', async () => {
  await enqueue('scout', 'interrupted-scout')
  const job = (await claimJob(['scout']))!
  const reservationId = await reserveBudget(`scout:${job.id}`, 'scout')
  const orderReservation = await reserveBudget('existing-order', 'order')
  await focus()
  const invoke = vi.fn(async () => ({ value: 'answer', cost: 0 }))
  const args = {
    key: 'blocked-call',
    reservationId,
    role: 'Разведчик',
    maximum: 0,
    demo: true,
    invoke,
  }
  await expect(meteredCall(args)).rejects.toBeInstanceOf(WorkFocusPaused)
  expect(invoke).not.toHaveBeenCalled()
  await finishJob(job, new WorkFocusPaused())
  expect(
    (await query('SELECT status,attempts,error_code FROM jobs WHERE id=$1', [job.id]))[0],
  ).toMatchObject({ status: 'queued', attempts: 0, error_code: 'WORK_FOCUS_PAUSED' })
  expect(
    await meteredCall({ ...args, key: 'accepted-order', reservationId: orderReservation }),
  ).toBe('answer')
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('prevents manual and automatic starts outside the selection', async () => {
  await focus(['trading'])
  await expect(controlManager('enable')).rejects.toThrow('WORK_FOCUS_PAUSED')
  await expect(controlComputerUse('enable')).rejects.toThrow('WORK_FOCUS_PAUSED')
  await expect(controlEarnings('refresh')).rejects.toThrow('WORK_FOCUS_PAUSED')
  const research = vi.fn(),
    arbitrage = vi.fn()
  expect(await earningsTick({ research, arbitrage })).toBe(false)
  expect(research).not.toHaveBeenCalled()
  expect(arbitrage).not.toHaveBeenCalled()
  expect(await computerUseTick({ agent: new FakeVmAgent() })).toBe(false)
})

it('stops a browser answer received after focus changed, preserving its task for resumption', async () => {
  await controlComputerUse('enable')
  const agent = new FakeVmAgent()
  await computerUseTick({
    agent,
    model: async () => {
      await focus()
      return { name: 'navigate', arguments: { url: 'https://example.com' }, note: 'test' }
    },
  })
  expect(agent.actions).toHaveLength(0)
  expect((await query('SELECT status,step_count FROM computer_use_tasks'))[0]).toMatchObject({
    status: 'running',
    step_count: 0,
  })
  expect((await query('SELECT last_error,lease_id FROM computer_use'))[0]).toMatchObject({
    last_error: 'WORK_FOCUS_PAUSED',
    lease_id: null,
  })
})
