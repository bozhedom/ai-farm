import { z } from 'zod'

export const assistantSections = [
  { id: 'overview', title: 'Обзор', path: '/office' },
  { id: 'launch', title: 'Запуск и ограничения', path: '/office/launch' },
  { id: 'trading', title: 'Мои биржи', path: '/office/trading' },
  {
    id: 'trading-instructions',
    title: 'Инструкции для торговли',
    path: '/office/trading-instructions',
  },
  { id: 'manager', title: 'Менеджер торговли', path: '/office/manager' },
  { id: 'earnings', title: 'Направления и выбор агентов', path: '/office/earnings' },
  { id: 'computer', title: 'Компьютер ИИ', path: '/office/computer' },
  { id: 'farm', title: 'Ферма идей', path: '/office/farm' },
  { id: 'ideas', title: 'Идеи', path: '/office/ideas' },
  { id: 'models', title: 'Модели и контекст', path: '/office/models' },
  { id: 'agents', title: 'Агенты', path: '/office/agents' },
  { id: 'products', title: 'Продукты', path: '/office/products' },
  { id: 'orders', title: 'Заказы', path: '/office/orders' },
  { id: 'leads', title: 'Клиенты', path: '/office/leads' },
  { id: 'money', title: 'Деньги', path: '/office/money' },
  { id: 'settings', title: 'Настройки', path: '/office/settings' },
] as const
export type AssistantSection = (typeof assistantSections)[number]['id']
export const assistantQuestionSchema = z
  .object({
    requestId: z.uuid(),
    question: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((v) => !v.includes('\0')),
    section: z.enum(assistantSections.map((s) => s.id)),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1500) }).strict())
      .max(6),
  })
  .strict()
export const assistantAnswerSchema = z
  .object({
    text: z.string().min(1).max(4000),
    sections: z.array(z.enum(assistantSections.map((s) => s.id))).max(4),
  })
  .strict()
export type AssistantReply = z.infer<typeof assistantAnswerSchema> & {
  at: string
  source: 'model' | 'demo' | 'guide'
  reason: string
}
