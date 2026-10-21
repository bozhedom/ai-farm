import type {
  ComputerProposalView,
  ComputerStepDecision,
  ComputerTaskStatus,
} from '../../core/contracts/computer-use'
import type { Badge } from '~/composables/office/labels'

/** Owner words for the computer-use codes; the codes themselves stay in the technical log. */
const reasons: Record<string, string> = {
  COMPUTER_USE_DISABLED_ON_SERVER: 'На сервере выключено: COMPUTER_USE_ENABLED=false в .env.',
  COMPUTER_USE_PROVIDER_UNSUPPORTED:
    'Нужна платная модель через OpenRouter: MODEL_PROVIDER=openai и OPENAI_TRANSPORT=openrouter.',
  COMPUTER_USE_VM_NOT_CONFIGURED: 'Не настроена виртуальная машина: VM_AGENT_URL и VM_AGENT_TOKEN.',
  COMPUTER_USE_SYSTEM_PAUSED: 'Ферма на паузе или остановлена. Снять можно в настройках.',
  COMPUTER_USE_WORKER_UNAVAILABLE:
    'Связь с worker потеряна. Работа продолжится после восстановления.',
  COMPUTER_USE_FAILURES:
    'Три задания подряд не завершились. Проверьте машину и модель, затем включите заново.',
  COMPUTER_USE_DAILY_LIMIT:
    'Дневной лимит расходов на браузер исчерпан. Продолжим после полуночи UTC.',
  COMPUTER_USE_TASK_CAP:
    'Достигнут лимит расходов на одно задание: работа завершается с отчётом сервера.',
  COMPUTER_USE_STEP_LIMIT: 'Достигнут лимит шагов задания: работа завершается с отчётом сервера.',
  COMPUTER_USE_MODEL_INVALID: 'Модель трижды ответила не по формату. Задание остановлено.',
  COMPUTER_USE_VM_UNAVAILABLE: 'Виртуальная машина не отвечает.',
  COMPUTER_USE_SESSION_LOST: 'Сессия браузера на машине потеряна.',
  COMPUTER_USE_SCREENSHOT_INVALID: 'Машина вернула неверный снимок экрана.',
  COMPUTER_USE_VM_RESPONSE_INVALID: 'Машина ответила в неверном формате.',
  COMPUTER_USE_PAUSED: 'Работа выключена владельцем.',
  COMPUTER_USE_CANCELLED: 'Отменено владельцем.',
  COMPUTER_USE_STEP_FAILED: 'Шаг не удался по неизвестной причине.',
  COMPUTER_USE_TOOL_CALL_INVALID: 'Ответ модели не прошёл проверку формата.',
  COMPUTER_USE_PRIVATE_NETWORK: 'Внутренние адреса сети закрыты.',
  COMPUTER_USE_HOST_BLOCKED: 'Сайт из запретного списка: обход проверок не делаем.',
  COMPUTER_USE_SCHEME_BLOCKED:
    'Запрещённая схема: обход проверок, мультиаккаунты или чужие данные.',
  COMPUTER_USE_URL_SCHEME: 'Допустимы только адреса http и https.',
  COMPUTER_USE_PAYMENT_SITE: 'Платёжный сервис или биржа: только с вашего разрешения.',
  COMPUTER_USE_CREDENTIALS: 'Ввод пароля: только с вашего разрешения.',
  COMPUTER_USE_SENSITIVE_FIELD: 'Поле с картой, кодом или документом: только с вашего разрешения.',
  COMPUTER_USE_PAYMENT_DATA: 'Похоже на номер карты или кошелька: только с вашего разрешения.',
  COMPUTER_USE_OUTWARD_ACTION: 'Публикация, регистрация, отправка или оплата: нужно ваше решение.',
  COMPUTER_USE_OUTWARD_PAGE: 'Страница оформления или входа: нужно ваше решение.',
  COMPUTER_USE_MODEL_REQUESTED: 'Модель сама попросила подтверждение.',
  COMPUTER_USE_OWNER_APPROVED: 'Выполнено с вашего разрешения.',
  COMPUTER_USE_OWNER_REJECTED: 'Вы отклонили это действие.',
  COMPUTER_USE_APPROVAL_EXPIRED: 'Запрос ждал сутки без ответа и закрыт.',
  COMPUTER_USE_SCREENSHOT_REQUIRED:
    'Клик без снимка экрана отклонён: снимок пришёл на следующем шаге.',
  COMPUTER_USE_LOOP_URL: 'Этот адрес уже открывали дважды в задании: третий переход отклонён.',
  COMPUTER_USE_OPPORTUNITY_LIMIT: 'В этом задании уже записано достаточно возможностей.',
  COMPUTER_USE_QUEUE_FULL: 'Очередь заданий заполнена. Дождитесь выполнения.',
  COMPUTER_USE_GOAL_LENGTH: 'Опишите задание от 10 до 1000 символов без угловых скобок.',
  COMPUTER_USE_TASK_FINISHED: 'Задание уже завершено.',
  COMPUTER_TASK_NOT_FOUND: 'Такого задания нет.',
  COMPUTER_APPROVAL_NOT_FOUND: 'Этот запрос уже решён.',
  POLICY_IDEA_TOPIC_BLOCKED: 'Такие темы ферма не берёт.',
  PROVIDER_CHANGED_DURING_JOB: 'Сменился провайдер модели: начатое задание закрыто.',
  BUDGET_BLOCKED: 'Не хватает дневного или месячного бюджета для резерва задания.',
  OPENAI_BUDGET_BLOCKED: 'Общий лимит платной модели исчерпан.',
  UNCERTAIN_CALL_REQUIRES_REVIEW: 'Исход вызова модели неясен: расход сохранён, повтор запрещён.',
  TARGET_BLOCKED: 'Машина отказала в переходе: закрытый адрес.',
  NAVIGATION_TIMEOUT: 'Страница не загрузилась вовремя.',
  ACTION_FAILED: 'Браузер не смог выполнить действие.',
  COMPUTER_USE_MANUAL_CONTROL: 'Вы управляете браузером: шаги модели приостановлены.',
  COMPUTER_USE_MANUAL_NOT_ACTIVE: 'Управление вручную не включено или истекло.',
  COMPUTER_USE_AI_FORBIDDEN: 'В задании запрещён ИИ: такие задания пропускаем.',
  COMPUTER_USE_AI_DENIAL: 'Текст отрицает использование ИИ: так писать нельзя.',
  COMPUTER_USE_OFF_PLATFORM_PAYMENT: 'Оплата мимо площадки запрещена: за это банят аккаунт.',
  COMPUTER_USE_CONTACT_DETAILS: 'Контакты вне площадки в тексте запрещены.',
  COMPUTER_USE_EXTERNAL_LINK: 'Внешние ссылки в отклике запрещены.',
  COMPUTER_USE_UNVERIFIED_CLAIM: 'Дипломы, отзывы, портфолио и годы опыта выдумывать нельзя.',
  COMPUTER_USE_PLATFORM_UNKNOWN: 'Это не фриланс-площадка из списка.',
  COMPUTER_USE_PLATFORM_MISMATCH: 'Адрес задания не относится к указанной площадке.',
  COMPUTER_USE_PLATFORM_NOT_LOGGED_IN: 'На этой площадке не отмечен вход под вашим аккаунтом.',
  COMPUTER_USE_AUTO_PROPOSALS_OFF:
    'Автоотклики выключены: включите переключатель и COMPUTER_USE_AUTO_PROPOSALS.',
  COMPUTER_USE_OPPORTUNITY_REQUIRED:
    'Сначала задание нужно записать и оценить через note_opportunity.',
  COMPUTER_USE_DECISION_NOT_TAKE: 'Модель сама решила не брать это задание.',
  COMPUTER_USE_PROPOSAL_LIMIT: 'Дневной лимит откликов на этой площадке исчерпан.',
  COMPUTER_USE_SEND_LIMIT: 'Дневной лимит отправок на этой площадке исчерпан.',
  COMPUTER_USE_PERMIT_GRANTED: 'Выдано разрешение на одну отправку (15 минут).',
  COMPUTER_USE_SEND_PERMIT: 'Отправлено по разрешению на одну отправку.',
  COMPUTER_USE_STORED_NOT_FOUND: 'Такого текста в этом задании нет.',
  COMPUTER_USE_PRICE_BELOW_MINIMUM: 'Цена ниже вашей минимальной из профиля исполнителя.',
  COMPUTER_USE_PRICE_CURRENCY_REQUIRED: 'У цены в отклике не указана валюта.',
  COMPUTER_USE_NO_DIRECTIONS:
    'Нет ни одного включённого направления поиска и ни одной площадки с входом: ротации нечего делать.',
  COMPUTER_USE_DIRECTION_NOT_FOUND: 'Такого направления нет.',
  COMPUTER_USE_DIRECTION_BUILT_IN: 'Встроенное направление можно выключить, но не удалить.',
  COMPUTER_USE_DIRECTIONS_LIMIT: 'Направлений уже достаточно: удалите или выключите лишние.',
  COMPUTER_USE_DIRECTION_TITLE: 'Название направления: от 3 до 80 символов без угловых скобок.',
  COMPUTER_USE_DIRECTION_WEIGHT: 'Приоритет направления: целое число от 1 до 5.',
  COMPUTER_USE_DOCUMENT_LIMIT: 'В этом задании уже подготовлено достаточно документов.',
}
export function computerReason(code: string | null | undefined) {
  const value = String(code ?? '').trim()
  if (!value) return ''
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(value)) return value
  if (reasons[value]) return reasons[value]!
  if (/_HTTP_\d+$/.test(value)) return 'Служба ответила ошибкой. Подробности в техжурнале.'
  return 'Служебная причина, подробности в техжурнале.'
}

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
