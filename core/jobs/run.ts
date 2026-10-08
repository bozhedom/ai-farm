import { activityContext } from '../activity'
import { evaluateWeek } from '../evolution'
import type { Job } from '../queue'
import { fulfill } from './fulfill'
import { research } from './research'

export async function runJob(job: Job, lifecycle: { isStopping?: () => boolean } = {}) {
  return activityContext.run({ jobId: job.id, ...lifecycle }, async () => {
    if (job.kind === 'research') await research(job)
    else if (job.kind === 'fulfill') await fulfill(job)
    else await evaluateWeek(`weekly:${job.id}`)
  })
}
