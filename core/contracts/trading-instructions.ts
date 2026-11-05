import { z } from 'zod'

const symbols = z.array(z.string().regex(/^[A-Z0-9]{2,20}-USDT$/)).max(30)
export const tradingRulesSchema = z
  .object({
    pauseEntries: z.boolean(),
    allowedSymbols: symbols.min(1).nullable(),
    blockedSymbols: symbols,
    allowedKinds: z
      .array(z.enum(['reversion', 'trend', 'breakout', 'grid', 'dca']))
      .min(1)
      .max(5)
      .nullable(),
    maxOrderUsdt: z
      .string()
      .regex(/^\d{1,6}(?:\.\d{1,8})?$/)
      .nullable(),
    maxExposureBps: z.number().int().min(0).max(5000).nullable(),
    maxOrdersPerDay: z.number().int().min(1).max(40).nullable(),
    entryIntervalMinutes: z.number().int().min(5).max(10080).nullable(),
    positionStopBps: z.number().int().min(1).max(300).nullable(),
    takeProfitBps: z.number().int().min(50).max(600).nullable(),
    maxHoldingMinutes: z.number().int().min(1).max(1440).nullable(),
  })
  .strict()
export type TradingRules = z.infer<typeof tradingRulesSchema>
export const defaultTradingRules = (): TradingRules => ({
  pauseEntries: false,
  allowedSymbols: null,
  blockedSymbols: [],
  allowedKinds: null,
  maxOrderUsdt: null,
  maxExposureBps: null,
  maxOrdersPerDay: null,
  entryIntervalMinutes: null,
  positionStopBps: null,
  takeProfitBps: null,
  maxHoldingMinutes: null,
})
export const instructionInterpretationSchema = z
  .object({
    rules: tradingRulesSchema,
    managerNotes: z.array(z.string().min(1).max(400)).max(8),
    issues: z.array(z.string().min(1).max(400)).max(8),
  })
  .strict()
export type InstructionInterpretation = z.infer<typeof instructionInterpretationSchema>
export type TradingInstructionsView = {
  revision: number
  profileRevision: number
  rules: TradingRules
  managerNotes: string[]
  appliedAt: string | null
  source: 'parser' | 'model' | null
  synchronized: boolean
}
export type ApplyInstructionsResult = {
  applied: boolean
  issues: string[]
  current: TradingInstructionsView
}

export function describeTradingRules(r: TradingRules): string[] {
  const result: string[] = []
  if (r.pauseEntries) result.push('Новые покупки приостановлены.')
  if (r.allowedSymbols) result.push(`Покупки только: ${r.allowedSymbols.join(', ')}.`)
  if (r.blockedSymbols.length) result.push(`Запрещены покупки: ${r.blockedSymbols.join(', ')}.`)
  const kinds = {
    reversion: 'возврат к среднему',
    trend: 'тренд',
    breakout: 'пробой',
    grid: 'сетка',
    dca: 'DCA',
  }
  if (r.allowedKinds)
    result.push(
      `Новые входы только для стратегий: ${r.allowedKinds.map((k) => kinds[k]).join(', ')}.`,
    )
  if (r.maxOrderUsdt !== null)
    result.push(`До ${r.maxOrderUsdt} USDT на новую покупку с резервом комиссии.`)
  if (r.maxExposureBps !== null)
    result.push(
      `Новые входы допускаются при общей позиции не выше ${r.maxExposureBps / 100}% капитала биржи.`,
    )
  if (r.maxOrdersPerDay !== null)
    result.push(
      `До ${r.maxOrdersPerDay} заявок за UTC-сутки на биржу и режим; продажи для выхода разрешены сверх этого предела.`,
    )
  if (r.entryIntervalMinutes !== null)
    result.push(`Не менее ${r.entryIntervalMinutes} минут между покупками на бирже в одном режиме.`)
  if (r.positionStopBps !== null)
    result.push(
      `Выход при снижении стоимости позиции на ${r.positionStopBps / 100}% от её себестоимости.`,
    )
  if (r.takeProfitBps !== null)
    result.push(`Фиксация прибыли от ${r.takeProfitBps / 100}% после расчётной комиссии.`)
  if (r.maxHoldingMinutes !== null)
    result.push(
      `Закрывать позицию не позднее ${r.maxHoldingMinutes} минут с её открытия, когда исполнение доступно.`,
    )
  return result
}
