import type {
  AgentMutation,
  BudgetCategory,
  CritiqueVerdict,
  IdeaStatus,
  OfficeAgent,
  OfficeIdea,
  OfficeMode,
  ScoreComponent,
} from '../../../core/contracts/office'
import { categoryById } from '../../../core/taxonomy'
import { serviceNames } from '../../../core/service-names'

/** Badge tones from the design system: `.badge-<tone>`, `.dot.<tone>`, `.bar.is-<tone>`. */
export type Tone = 'ok' | 'wait' | 'err' | 'off' | 'copy' | 'test' | 'human' | 'sun' | 'plain'
export type Badge = { label: string; tone: Tone }

export const modeBadge: Record<OfficeMode, Badge> = {
  running: { label: 'Работает', tone: 'ok' },
  paused: { label: 'Пауза', tone: 'wait' },
  emergency_stop: { label: 'Остановлено', tone: 'err' },
}

export const ideaStatus: Record<IdeaStatus, Badge> = {
  new: { label: 'Новая', tone: 'plain' },
  accepted: { label: 'Принята', tone: 'wait' },
  productized: { label: 'В продаже', tone: 'ok' },
  needs_human: { label: 'Ждёт решения', tone: 'wait' },
  rejected: { label: 'Отклонил критик', tone: 'err' },
}
/** Filter names: what the owner looks for, not the badge text. */
export const ideaStatusFilter: Record<IdeaStatus, string> = {
  new: 'Новые',
  accepted: 'Принятые',
  productized: 'В продаже',
  needs_human: 'Нужен человек',
  rejected: 'Отклонённые',
}
export const ideaStatusOrder: IdeaStatus[] = [
  'new',
  'accepted',
  'productized',
  'needs_human',
  'rejected',
]

export const verdict: Record<CritiqueVerdict, Badge & { title: string }> = {
  PASS: { label: 'Принята', tone: 'ok', title: 'Критик принял' },
  REVISE: { label: 'На доработку', tone: 'wait', title: 'Критик просит доработать' },
  BLOCKED: { label: 'Отклонена', tone: 'err', title: 'Критик отклонил' },
}

export const launchBadge = (idea: Pick<OfficeIdea, 'farmExecutable'>): Badge =>
  idea.farmExecutable
    ? { label: 'Ферма сделает сама', tone: 'sun' }
    : { label: 'Нужен человек', tone: 'human' }

/** Service names, the same as on the site (core/service-names.ts). */
export const templateLabels: Record<string, string> = serviceNames
export const templateLabel = (template: string | null | undefined) =>
  (template && templateLabels[template]) || 'Другое'

export const revenueModels: Record<string, string> = {
  service_fee: 'Оплата за текст',
  one_time_sale: 'Разовая продажа',
  one_time: 'Разовая продажа',
  per_order: 'Оплата за заказ',
  subscription: 'Подписка',
  service: 'Услуга',
  commission: 'Комиссия',
  ads: 'Реклама',
  digital: 'Цифровой товар',
}
/** Known revenue models in words; an unknown model code is never shown to people. */
export const revenueModelLabel = (value: string) => revenueModels[value] || ''

export const takenBadge: Badge = { label: 'В работе у вас', tone: 'sun' }

export const orderStatus: Record<string, Badge> = {
  awaiting_payment: { label: 'Ждёт оплаты', tone: 'wait' },
  paid: { label: 'Оплачен', tone: 'wait' },
  running: { label: 'Пишем текст', tone: 'wait' },
  delivered: { label: 'Готов', tone: 'ok' },
  manual_review: { label: 'Нужна проверка', tone: 'err' },
  expired: { label: 'Счёт устарел', tone: 'off' },
  closed: { label: 'Закрыт без выдачи', tone: 'off' },
  cancelled: { label: 'Отменён', tone: 'off' },
}
export const orderBadge = (status: string): Badge =>
  orderStatus[status] || { label: status, tone: 'plain' }

export const leadStage: Record<string, Badge> = {
  new: { label: 'Новый', tone: 'ok' },
  saved: { label: 'Отложен', tone: 'plain' },
  contacted: { label: 'Отправлено', tone: 'test' },
  won: { label: 'Договорились', tone: 'ok' },
  dismissed: { label: 'Не подходит', tone: 'off' },
}
export const leadBadge = (stage: string): Badge =>
  leadStage[stage] || { label: stage, tone: 'plain' }

export const budgetCategories: Record<BudgetCategory, string> = {
  scout: 'Разведка идей',
  research: 'Сборка продуктов',
  order: 'Заказы',
  lead: 'Поиск клиентов',
  report: 'Отчёты руководителя',
}

export const scoreComponents: Record<ScoreComponent, { label: string; hint: string }> = {
  P: { label: 'Принято критиком', hint: 'доля идей, которые принял критик' },
  E: { label: 'Источники', hint: 'сколько разных сайтов подтверждают идею' },
  U: { label: 'Без повторов', hint: 'доля идей, которые не повторяют старые' },
  B: { label: 'Продукты', hint: 'сколько продуктов из идей прошли проверку' },
  C: { label: 'Цена идеи', hint: 'чем дешевле идея, тем выше' },
  D: { label: 'Заказы без правок', hint: 'доля заказов, выданных без проверки владельца' },
}

const paramLabels: Record<string, string> = {
  focusCategories: 'отрасли',
  evidenceMinimum: 'минимум источников',
  tone: 'тон',
  ideaScope: 'охват',
  riskAppetite: 'риск',
}
const valueLabels: Record<string, string> = {
  plain: 'простой',
  expert: 'экспертный',
  friendly: 'дружелюбный',
  narrow: 'узкий',
  broad: 'широкий',
  low: 'низкий',
  medium: 'средний',
}
const paramValue = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(paramValue).join(', ')
    : typeof value === 'string'
      ? valueLabels[value] || categoryById[value]?.label || value
      : String(value ?? '')

/** «тон: экспертный (раньше простой)». */
export function mutationText(mutation: AgentMutation | null | undefined) {
  if (!mutation) return ''
  const name = paramLabels[mutation.param] || mutation.param
  return `${name}: ${paramValue(mutation.to)} (раньше ${paramValue(mutation.from)})`
}

export const tonesForAgents = ['', 'is-clay', 'is-sky', 'is-sun'] as const

/** «Разведчик А2» -> «А2». Names come from the server and already follow the dictionary. */
export const agentShort = (name: string) => name.replace(/^Разведчик\s+/i, '').trim() || name

export function agentAvatar(agent: Pick<OfficeAgent, 'status' | 'parentId'>, index = 0) {
  if (agent.status === 'archived') return 'is-off'
  if (agent.parentId) return 'is-copy'
  return tonesForAgents[index % tonesForAgents.length]
}

export function agentBadge(agent: Pick<OfficeAgent, 'status' | 'parentId' | 'retired'>): Badge {
  if (agent.status === 'archived') return { label: 'Уволен', tone: 'off' }
  if (agent.parentId) return { label: 'Копия', tone: 'copy' }
  return { label: 'Работает', tone: 'ok' }
}

/** Agent score is stored 0..1000; people see 0..100. */
export const score100 = (value: number | null | undefined) =>
  value === null || value === undefined ? null : Math.round(value / 10)

export const scoreTone = (value: number) => (value >= 80 ? 'is-sun' : value < 50 ? 'is-err' : '')

/** Colour of a feed event. Kinds come from the server; unknown kinds stay neutral. */
export function feedTone(kind: string, text = ''): Tone {
  const k = `${kind} ${text}`.toLowerCase()
  // A critic verdict is coloured by the verdict, not by the word «review» in the kind.
  if (kind === 'late_payment_received') return 'err'
  if (kind === 'idea_reviewed')
    return /^критик принял/i.test(text) ? 'ok' : /отклонил/i.test(text) ? 'err' : 'wait'
  if (/error|fail|reject|blocked|limit|review|отклон|не прош|не ответ|исчерпан/.test(k))
    return 'err'
  if (/retire|archiv|уволен/.test(k)) return 'off'
  if (/clone|copy|mutation|копи/.test(k)) return 'copy'
  if (/payment|test|тестов/.test(k)) return 'test'
  if (/product|publish|продукт|на сайте/.test(k)) return 'sun'
  if (/human|pause|wait|hold|пауз|человек|пропущен/.test(k)) return 'wait'
  if (/idea|accept|lead|deliver|done|order|иде|принял|готов|клиент/.test(k)) return 'ok'
  return 'plain'
}
