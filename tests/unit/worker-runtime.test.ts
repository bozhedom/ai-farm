import { afterEach, expect, it, vi } from 'vitest'
import { WorkerDraining } from '../../core/activity'
import type { Job } from '../../core/queue'
import { claimWorkerJob, executeWorkerJob } from '../../core/worker-runtime'

const job: Job = {
  id: 'test-job',
  kind: 'research',
  payload: {},
  attempts: 1,
  max_attempts: 3,
  lease_token: 'own-lease',
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function dependencies() {
  return {
    claim: vi.fn(async () => job),
    finish: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('ignores a heartbeat that reports lease loss after the job has finished', async () => {
  vi.useFakeTimers()
  const run = deferred(),
    heartbeat = deferred()
  const runtime = dependencies()
  runtime.run.mockImplementation(() => run.promise)
  runtime.heartbeat.mockImplementation(() => heartbeat.promise)
  const lifecycle = { isStopping: () => false, onHeartbeatError: vi.fn() }
  const pending = executeWorkerJob(job, lifecycle, runtime)
  await vi.advanceTimersByTimeAsync(10000)
  expect(runtime.heartbeat).toHaveBeenCalledOnce()
  run.resolve()
  await pending
  expect(runtime.finish).toHaveBeenCalledWith(job, undefined)
  heartbeat.reject(new Error('LEASE_LOST'))
  await vi.advanceTimersByTimeAsync(10000)
  expect(lifecycle.onHeartbeatError).not.toHaveBeenCalled()
  expect(runtime.heartbeat).toHaveBeenCalledOnce()
})

it('reports a lease failure while execution is still active without overlapping renewals', async () => {
  vi.useFakeTimers()
  const run = deferred(),
    heartbeat = deferred()
  const runtime = dependencies()
  runtime.run.mockImplementation(() => run.promise)
  runtime.heartbeat.mockImplementation(() => heartbeat.promise)
  const lifecycle = { isStopping: () => false, onHeartbeatError: vi.fn() }
  const pending = executeWorkerJob(job, lifecycle, runtime)
  await vi.advanceTimersByTimeAsync(30000)
  expect(runtime.heartbeat).toHaveBeenCalledOnce()
  const error = new Error('LEASE_LOST')
  heartbeat.reject(error)
  await vi.advanceTimersByTimeAsync(0)
  expect(lifecycle.onHeartbeatError).toHaveBeenCalledWith(error)
  run.resolve()
  await pending
})

it('returns a raced claim under its original lease and starts no application work', async () => {
  const claim = deferred<Job>()
  const runtime = dependencies()
  runtime.claim.mockImplementation(() => claim.promise)
  let stopping = false
  const pending = claimWorkerJob(['research'], () => stopping, runtime)
  stopping = true
  claim.resolve(job)
  expect(await pending).toBeUndefined()
  expect(runtime.run).not.toHaveBeenCalled()
  expect(runtime.finish).toHaveBeenCalledWith(job, expect.any(WorkerDraining))
})

it('claims nothing after shutdown and returns a claim received just before execution', async () => {
  const runtime = dependencies()
  expect(await claimWorkerJob(['research'], () => true, runtime)).toBeUndefined()
  expect(runtime.claim).not.toHaveBeenCalled()
  await executeWorkerJob(job, { isStopping: () => true, onHeartbeatError: vi.fn() }, runtime)
  expect(runtime.run).not.toHaveBeenCalled()
  expect(runtime.finish).toHaveBeenCalledWith(job, expect.any(WorkerDraining))
})
