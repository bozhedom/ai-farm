import { activityContext } from '../activity'
import { evaluateWeek } from '../evolution'
import type { Job } from '../queue'
import { evolve } from './evolve'
import { fulfill } from './fulfill'
import { lead } from './lead'
import { report } from './report'
import { research } from './research'
import { scout } from './scout'

export async function runJob(job: Job, lifecycle: { isStopping?: () => boolean } = {}) {
  return activityContext.run({ jobId: job.id, ...lifecycle }, async () => {
    if (job.kind === 'research') await research(job)
    else if (job.kind === 'fulfill') await fulfill(job)
    else if (job.kind === 'scout') await scout(job)
    else if (job.kind === 'report') await report(job)
    else if (job.kind === 'lead') await lead(job)
    else if (job.kind === 'evolve') await evolve(job)
    else await evaluateWeek(`weekly:${job.id}`)
  })
}
