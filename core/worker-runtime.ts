import { WorkerDraining } from './activity'
import { runJob } from './jobs/run'
import { claimJob, finishJob, heartbeatJob, type Job } from './queue'

type Lifecycle = {
  isStopping: () => boolean
  onHeartbeatError: (error: unknown) => void
}
type Runtime = {
  claim: typeof claimJob
  finish: typeof finishJob
  heartbeat: typeof heartbeatJob
  run: typeof runJob
}
const runtime: Runtime = {
  claim: claimJob,
  finish: finishJob,
  heartbeat: heartbeatJob,
  run: runJob,
}

/** Return a raced claim under its own lease, before running any application work. */
export async function claimWorkerJob(
  kinds: Job['kind'][],
  isStopping: () => boolean,
  dependencies: Runtime = runtime,
) {
  if (isStopping()) return
  const job = await dependencies.claim(kinds)
  if (job && isStopping()) {
    await dependencies.finish(job, new WorkerDraining())
    return
  }
  return job
}

export async function executeWorkerJob(
  job: Job,
  lifecycle: Lifecycle,
  dependencies: Runtime = runtime,
) {
  let executing = true
  let renewing = false
  const timer = setInterval(() => {
    if (!executing || renewing) return
    renewing = true
    void dependencies
      .heartbeat(job)
      .catch((error) => {
        // A heartbeat already sent before finishJob may observe its legitimate terminal state.
        if (executing) lifecycle.onHeartbeatError(error)
      })
      .finally(() => {
        renewing = false
      })
  }, 10000)
  let failure: unknown
  try {
    try {
      if (lifecycle.isStopping()) throw new WorkerDraining()
      await dependencies.run(job, { isStopping: lifecycle.isStopping })
    } catch (error) {
      failure = error
    }
    executing = false
    clearInterval(timer)
    await dependencies.finish(job, failure)
  } finally {
    executing = false
    clearInterval(timer)
  }
}
