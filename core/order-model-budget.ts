import { config } from './config'
import { prepareModelRequest } from './providers'
import { reviewSchema } from './policy'
import { textGenerationRequest, type GenerateArgs } from './jobs/generate-text'
import { reviewContext } from './jobs/text-context'

/**
 * Minimum envelope for both paid steps. The review's generated text is not known yet, so this
 * is an early incompatibility check, not a promise that every possible result will fit. The
 * transactional ledger still admits each actual request, including the complete review text.
 */
export function minimumOrderModelReserve(args: Omit<GenerateArgs, 'key' | 'reservationId'>) {
  if (!['openai', 'yandex'].includes(config().MODEL_PROVIDER)) return 0
  const key = '00000000-0000-4000-8000-000000000000'
  const generation = prepareModelRequest(
    textGenerationRequest({ ...args, key: `${key}:generate`, reservationId: '' }),
  )
  const review = prepareModelRequest({
    role: 'Проверяющий',
    key: `${key}:verify`,
    reservationId: '',
    context: reviewContext(args.product, args.input, ''),
    schema: reviewSchema,
    demoValue: { verdict: 'PASS', reason: 'Только расчёт бюджета, модель не вызывается.' },
  })
  return generation.maximum + review.maximum
}

export function assertOrderModelBudget(args: Omit<GenerateArgs, 'key' | 'reservationId'>) {
  if (minimumOrderModelReserve(args) > config().ORDER_RESERVE_KOPECKS)
    throw new Error('ORDER_MODEL_BUDGET_TOO_SMALL')
}
