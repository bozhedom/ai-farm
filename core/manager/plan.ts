import { z } from 'zod'
import { MANAGER_POLICY as P } from '../policy'
import { paramsSchema } from '../trading/strategy'
import {
  exchanges,
  type StrategyKind,
  type StrategyParams,
  type TradingExchange,
} from '../trading/types'

const prose = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[<>]/.test(v), 'HTML_FORBIDDEN')
export const proposalSchema = z
  .object({
    exchange: z.enum(exchanges),
    sourceAgentId: z.uuid(),
    kind: z.enum(['reversion', 'trend', 'breakout', 'grid', 'dca']),
    params: paramsSchema,
    hypothesis: prose(15, 600).describe(
      'Проверяемая гипотеза о стратегии с динамическим отбором монет, без обещаний прибыли.',
    ),
    rationale: prose(15, 600).describe(
      'Какие цифры снимка объясняют выбор и что может опровергнуть гипотезу.',
    ),
  })
  .strict()
export const managerPlanSchema = z
  .object({
    summary: prose(15, 1000).describe(
      'Короткий разбор на русском. Разделяй наблюдения и предположения. Не выдавай задачи за исполнения.',
    ),
    tasks: z
      .array(proposalSchema)
      .max(P.maxTasksPerRun)
      .describe(
        'Не больше одного эксперимента на биржу. Пустой список допустим при недостатке данных.',
      ),
  })
  .strict()
export type ManagerProposal = z.infer<typeof proposalSchema>
export type ManagerPlan = z.infer<typeof managerPlanSchema>
export interface ManagerAgentSnapshot {
  id: string
  kind: StrategyKind
  params: StrategyParams
  symbol: string
  selectorVersion: string
  assignedAt: string
  createdAt: string
  roundTrips: number
  cashUsdt: string
  baseQuantity: string
  pnlUsdt: string | null
  drawdownBps: number
  canExperiment: boolean
}
export interface ManagerSnapshot {
  at: string
  portfolios: {
    exchange: TradingExchange
    status: string
    reason: string
    revision: number
    activeTask: boolean
    scoutFresh: boolean
    candidates: { symbol: string; score: number }[]
    agents: ManagerAgentSnapshot[]
  }[]
  recentTasks: Record<string, unknown>[]
}
export function validatePlanAgainstSnapshot(plan: ManagerPlan, snapshot: ManagerSnapshot) {
  const seen = new Set<string>()
  for (const task of plan.tasks) {
    if (seen.has(task.exchange)) throw new Error('MANAGER_DUPLICATE_EXCHANGE')
    seen.add(task.exchange)
    const portfolio = snapshot.portfolios.find((p) => p.exchange === task.exchange)
    const source = portfolio?.agents.find((a) => a.id === task.sourceAgentId)
    if (!source || !source.canExperiment || portfolio!.activeTask)
      throw new Error('MANAGER_TARGET_INVALID')
    if (source.kind === task.kind && sameParams(source.params, task.params))
      throw new Error('MANAGER_UNCHANGED_PROPOSAL')
  }
  return plan
}
export const sameParams = (a: StrategyParams, b: StrategyParams) =>
  a.lookback === b.lookback && a.entryBps === b.entryBps && a.takeProfitBps === b.takeProfitBps

export function demoManagerPlan(snapshot: ManagerSnapshot): ManagerPlan {
  const tasks = snapshot.portfolios
    .filter((p) => !p.activeTask)
    .flatMap((p) => {
      const a = p.agents.find((a) => a.canExperiment)
      if (!a) return []
      return [
        {
          exchange: p.exchange,
          sourceAgentId: a.id,
          kind: a.kind,
          params: {
            ...a.params,
            entryBps: a.params.entryBps >= 280 ? a.params.entryBps - 20 : a.params.entryBps + 20,
          },
          hypothesis:
            'Демонстрация: более редкий вход изменит результат бумажной стратегии после комиссий.',
          rationale:
            'Это готовый пример для проверки очереди. Модель и внешнее исследование не запускались.',
        },
      ]
    })
  return {
    summary:
      'Демонстрационный разбор: проверяем постановку и выполнение бумажных экспериментов. Этот ответ не получен от LLM и не подтверждает доходность.',
    tasks,
  }
}
