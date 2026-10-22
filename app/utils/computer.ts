import type {
  ComputerProposalView,
  ComputerStepDecision,
  ComputerTaskStatus,
} from '../../core/contracts/computer-use'
import type { Badge } from '~/composables/office/labels'

import { computerReason as serverReason } from '../../core/computer-use/words'

export { computerReasons } from '../../core/computer-use/words'

/** Reasons the owner cannot fix in the office: who does it, without server setting names. */
const ownerReasons: Record<string, string> = {
  COMPUTER_USE_DISABLED_ON_SERVER:
    'Выключено в настройках сервера. Включает администратор, когда машина готова.',
  COMPUTER_USE_PROVIDER_UNSUPPORTED:
    'Нужна платная модель через OpenRouter: ключ вносит администратор на сервере.',
  COMPUTER_USE_VM_NOT_CONFIGURED:
    'Виртуальная машина не подключена: её адрес и пароль вносит администратор на сервере.',
}
export const computerReason = (code: string | null | undefined) =>
  ownerReasons[String(code ?? '').trim()] ?? serverReason(code)

export const taskStatusBadge: Record<ComputerTaskStatus, Badge> = {
  queued: { label: 'В очереди', tone: 'plain' },
  running: { label: 'Выполняется', tone: 'ok' },
  waiting_approval: { label: 'Ждёт решения', tone: 'wait' },
  done: { label: 'Завершено', tone: 'ok' },
  failed: { label: 'Остановлено', tone: 'err' },
  cancelled: { label: 'Отменено', tone: 'off' },
}
export const stepBadge: Record<ComputerStepDecision, Badge> = {
  allowed: { label: 'Выполнено', tone: 'ok' },
  approval: { label: 'Запрос', tone: 'wait' },
  approved: { label: 'Разрешено', tone: 'ok' },
  rejected: { label: 'Отклонено', tone: 'off' },
  blocked: { label: 'Запрещено', tone: 'err' },
  invalid: { label: 'Не по формату', tone: 'err' },
  failed: { label: 'Не удалось', tone: 'err' },
}
export const decisionBadge: Record<string, Badge> = {
  take: { label: 'Берёт сама', tone: 'ok' },
  human: { label: 'Нужен человек', tone: 'human' },
  skip: { label: 'Пропущено', tone: 'off' },
}
export const proposalStatusBadge: Record<ComputerProposalView['status'], Badge> = {
  draft: { label: 'Черновик', tone: 'wait' },
  sent: { label: 'Отправлен', tone: 'ok' },
  failed: { label: 'Не отправлен', tone: 'err' },
  expired: { label: 'Истёк', tone: 'off' },
}
export const documentKindLabel: Record<string, string> = {
  article: 'Статья',
  product_description: 'Описание товара',
  translation: 'Перевод',
  summary: 'Краткое содержание',
  instruction: 'Инструкция',
  reply: 'Ответ заказчику',
  other: 'Текст',
}
/** Display only: integer minor units of a currency as «3 000,00 RUB». */
export function money(minor: number | null | undefined, currency: string | null | undefined) {
  if (minor === null || minor === undefined || !currency) return ''
  const value = Math.max(0, Math.round(Number(minor) || 0))
  const whole = Math.floor(value / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')
  const symbol =
    currency === 'RUB' ? '₽' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency
  return `${whole},${String(value % 100).padStart(2, '0')} ${symbol}`
}
export const opportunityKindLabel: Record<string, string> = {
  bounty: 'Баунти, конкурс',
  freelance: 'Фриланс-задание',
  grant: 'Грант, программа',
  airdrop: 'Награда, аирдроп',
  digital_product: 'Цифровой продукт',
  service_demand: 'Запрос на услугу',
  other: 'Другое',
}

/** One line about an action for the step log and approval cards. */
export function actionText(action: { name: string } & Record<string, unknown>): string {
  const a = action as Record<string, unknown>
  switch (action.name) {
    case 'navigate':
      return `Открыть ${String(a.url)}`
    case 'click':
      return `Клик в точке ${a.x}, ${a.y}`
    case 'type':
      return `Ввести текст: «${String(a.text).slice(0, 120)}»`
    case 'key':
      return `Нажать ${a.key}`
    case 'scroll':
      return `Прокрутить на ${a.deltaY} px`
    case 'back':
      return 'Вернуться назад'
    case 'wait':
      return `Подождать ${a.ms} мс`
    case 'finish':
      return 'Завершить задание и отдать отчёт'
    case 'request_approval': {
      const inner = a.action as ({ name: string } & Record<string, unknown>) | undefined
      return `Запрос разрешения: ${inner ? actionText(inner) : ''}`
    }
    case 'note_opportunity':
      return `Записать возможность: ${String(a.title)}${a.decision ? ` (${decisionBadge[String(a.decision)]?.label.toLowerCase() ?? a.decision}, ${a.fit}%)` : ''}`
    case 'draft_proposal':
      return `Подготовить отклик на ${String(a.platform_domain)}: «${String(a.text).slice(0, 100)}…»`
    case 'type_stored':
      return `Вставить сохранённый текст${a.chars ? ` (${a.chars} зн.)` : ''}`
    case 'write_document':
      return `Написать документ: ${String(a.title)}`
    case 'prepare_send':
      return `Разрешение на отправку (${a.purpose === 'delivery' ? 'сдача работы' : 'ответ заказчику'}) на ${String(a.domain)}`
    default:
      return `Неизвестное действие ${action.name}`
  }
}

/** Display only: integer microdollars as «$0,42». Accounting stays in integers on the server. */
export function usd(microusd: number | null | undefined) {
  const value = Math.max(0, Math.round(Number(microusd) || 0))
  const cents = Math.round(value / 10000)
  return `$${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`
}
