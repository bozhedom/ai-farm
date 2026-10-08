import { runEvolutionRound, type EvolutionTrigger } from '../evolution'
import type { Job } from '../queue'

/** `evolve:<gen>:<day>:<n>` or an owner check: the round runs in one transaction. */
export async function evolve(job: Job) {
  const trigger: EvolutionTrigger = ['threshold', 'schedule', 'owner'].includes(
    job.payload.trigger!,
  )
    ? (job.payload.trigger as EvolutionTrigger)
    : 'schedule'
  const generation = Number(job.payload.generation)
  return runEvolutionRound({
    trigger,
    jobId: job.id,
    expectedGeneration: Number.isSafeInteger(generation) && generation > 0 ? generation : undefined,
  })
}
