import { z } from 'zod'

export const workDirections = [
  { id: 'trading', name: 'Спотовые трейдеры', detail: 'Биржевые стратегии, сетка и DCA' },
  {
    id: 'manager',
    name: 'ИИ-менеджер торговли',
    detail: 'Разбор и предложения Paper-экспериментов',
  },
  { id: 'arbitrage', name: 'Арбитраж', detail: 'Исполнение межбиржевых операций' },
  { id: 'funding', name: 'Фандинг', detail: 'Хедж спот / perpetual' },
  { id: 'defi', name: 'DeFi', detail: 'Aave USDC' },
  { id: 'prediction', name: 'Рынки прогнозов', detail: 'Контракты Kalshi' },
  { id: 'monitor', name: 'Монитор рынков', detail: 'Публичные цены и данные, без сделок' },
  {
    id: 'studio',
    name: 'Агенты фермы идей',
    detail: 'Разведка, исследование, критика, сборка и поиск клиентов',
  },
  {
    id: 'computer',
    name: 'Браузерные агенты',
    detail: 'Поиск заданий, отклики и работа на площадках',
  },
  { id: 'services', name: 'Исполнители заказов', detail: 'Приём новых заказов сайта и API' },
] as const
export type WorkDirection = (typeof workDirections)[number]['id']
export const cryptoDirections: WorkDirection[] = [
  'trading',
  'manager',
  'arbitrage',
  'funding',
  'defi',
  'monitor',
]
export const workFocusSchema = z
  .object({
    enabled: z.boolean(),
    selected: z
      .array(z.enum(workDirections.map((d) => d.id)))
      .min(1)
      .max(workDirections.length)
      .refine((v) => new Set(v).size === v.length),
    duration: z.enum(['manual', 'day']),
    revision: z.number().int().nonnegative(),
  })
  .strict()
export type WorkFocusView = {
  enabled: boolean
  active: boolean
  selected: WorkDirection[]
  until: string | null
  revision: number
}
