/** Server error codes in owner words: what happened and what to do next. */
const messages: Record<string, string> = {
  LOGIN_FAILED: 'Неверный пароль.',
  LOGIN_RATE_LIMIT: 'Слишком много попыток. Попробуйте через 10 минут.',
  ORIGIN_REJECTED: 'Адрес сайта не совпадает с APP_ORIGIN в настройках сервера.',
  RESEARCH_PAUSED: 'Ферма на паузе. Нажмите «Продолжить» и повторите.',
  RESEARCH_WINDOW_CLOSED: 'Сезон закончился. Начните новый в настройках.',
  SCHEDULE_DISABLED_ON_SERVER: 'Расписание выключено на сервере.',
  RESEARCH_DAILY_BUDGET_WAIT: 'Дневной лимит исчерпан. Продолжим завтра.',
  BUDGET_BLOCKED: 'Лимит расходов исчерпан. Продолжим, когда он обновится.',
  ORDER_MODEL_BUDGET_TOO_SMALL:
    'Резерв на заказ меньше оценки генерации и проверки выбранной моделью. Заказ не создан. Владелец должен пересмотреть резерв или выбрать другую модель.',
  OPENAI_BUDGET_BLOCKED: 'Лимит платной модели исчерпан.',
  NEW_ORDERS_PAUSED: 'Новые заказы на паузе. Нажмите «Продолжить».',
  OPEN_OBLIGATIONS: 'Сначала доделаем начатые заказы.',
  POLICY_CONTENT_BLOCKED: 'Такие темы ферма не берёт.',
  UNTRUSTED_INSTRUCTION_BLOCKED: 'В тексте есть команды для модели. Уберите их.',
  INPUT_LENGTH: 'Нужно от 30 до 4 000 символов.',
  INPUT_SOCIAL_LENGTH: 'Для постов нужен текст до 3 000 символов.',
  TRANSLATION_LANGUAGE_REQUIRED: 'В первой строке напишите язык: «Язык: английский».',
  LEASE_LOST: 'Задача прервалась. Посмотрите заказ, повтор не делаем, чтобы не списать дважды.',
  TX_ALREADY_USED: 'Этот перевод уже привязан к другому заказу.',
  DUPLICATE_PAYMENT_OR_REQUEST: 'Этот перевод или запрос уже использован.',
  INVOICE_EXPIRED: 'Счёт устарел. Создайте новый заказ.',
  ORDER_NOT_PAYABLE: 'Заказ уже оплачен или счёт устарел.',
  ORDER_NOT_RESOLVABLE: 'Закрыть можно только заказ, который ждёт проверки.',
  ORDER_ALREADY_RESOLVED: 'Заказ уже закрыт. Обновите страницу.',
  ORDER_NOT_FOUND: 'Такого заказа нет.',
  PRODUCT_NOT_FOUND: 'Такого продукта нет.',
  OPPORTUNITY_NOT_FOUND: 'Такого запроса нет.',
  EVOLUTION_NOT_READY: 'Для отбора пока мало идей.',
  IDEA_TAKE_FORBIDDEN: 'Взять в работу можно только идею, где нужен человек.',
  IDEA_ALREADY_TAKEN: 'У вас уже есть идея в работе. Отметьте её итог или верните в рейтинг.',
  IDEA_FINISH_REQUIRES_TAKEN: 'Отметить итог можно только у идеи, которая в работе у вас.',
  IDEA_OUTCOME_FINAL: 'Итог уже записан и больше не меняется.',
  IDEA_STATUS_CHANGE_FORBIDDEN: 'Так поменять статус идеи нельзя.',
  LEAD_DRAFT_LIMIT: 'Для этого запроса отклик уже готовили три раза.',
  LEAD_SEARCH_LIMIT: 'На сегодня поиски клиентов закончились. Лимит в настройках.',
  PRODUCT_NOT_PUBLIC: 'Сначала покажите продукт на сайте.',
  INVALID_INPUT: 'Проверьте введённые данные.',
  RATE_LIMITED: 'Слишком часто. Подождите минуту.',
  COMPUTER_USE_SCHEME_BLOCKED:
    'Такое задание не берём: обход проверок, мультиаккаунты или чужие данные.',
  COMPUTER_USE_GOAL_LENGTH: 'Опишите задание от 10 до 1000 символов без угловых скобок.',
  COMPUTER_USE_QUEUE_FULL: 'Очередь заданий заполнена. Дождитесь выполнения.',
  COMPUTER_USE_TASK_FINISHED: 'Задание уже завершено.',
  COMPUTER_TASK_NOT_FOUND: 'Такого задания нет.',
  COMPUTER_APPROVAL_NOT_FOUND: 'Этот запрос уже решён.',
  POLICY_IDEA_TOPIC_BLOCKED: 'Такие темы ферма не берёт.',
  COMPUTER_USE_PROFILE_INVALID: 'Профиль не сохранён: проверьте длину полей и суммы.',
  COMPUTER_USE_PROFILE_PROPOSALS_OVER_LIMIT: 'Откликов в сутки нельзя больше лимита сервера.',
  COMPUTER_USE_PROFILE_TOPIC_BLOCKED: 'В профиле тема, которую ферма не берёт. Уберите её.',
  COMPUTER_USE_PROFILE_CONTACT_DETAILS: 'Уберите из профиля контакты: телефон, почту, мессенджеры.',
  COMPUTER_USE_PROFILE_OFF_PLATFORM_PAYMENT: 'Уберите из профиля оплату мимо площадки.',
  COMPUTER_USE_PROFILE_AI_DENIAL: 'Уберите из профиля «пишу без ИИ» и похожие обещания.',
  COMPUTER_USE_PROFILE_EXTERNAL_LINK: 'Ссылки ставьте только в поле «Ссылка» у примера работы.',
  COMPUTER_USE_PROFILE_SAMPLE_URL: 'Ссылка на пример должна вести на обычный публичный сайт.',
  WALLET_DEPOSIT_NOT_FOUND: 'Такого поступления нет. Обновите страницу.',
  WALLET_DEPOSIT_NOT_FINAL: 'Отметить можно только зачисленное поступление.',
}

export type OfficeError = { status: number; code: string; text: string }

const reasonCodes: Record<string, string> = {
  POLICY_CONTENT_BLOCKED: 'Тема под запретом правил фермы.',
  UNTRUSTED_INSTRUCTION_BLOCKED: 'В материале были команды для модели.',
  OUTPUT_FORMAT_INVALID: 'Пример не совпал с форматом услуги.',
  OUTPUT_FORMAT_REQUIRED: 'В примере не хватило обязательных частей.',
  OUTPUT_REVIEW_REQUIRED: 'Проверка отклонила пример.',
  MODEL_SCHEMA_INVALID: 'Модель ответила не по формату.',
  MODEL_OUTPUT_INCOMPLETE: 'Модель не дописала ответ.',
  OPENROUTER_RESPONSE_ERROR: 'OpenRouter ответил ошибкой. Попробуйте позже.',
  BUDGET_BLOCKED: 'Не хватило дневного бюджета.',
  PRODUCT_NOT_PUBLIC: 'Продукт не на сайте, ссылку в отклик не поставить.',
  INPUT_PRODUCT_NOT_PUBLIC: 'Продукт не на сайте, ссылку в отклик не поставить.',
  PAID_AFTER_EXPIRY: 'Перевод пришёл после срока счёта, верните его вручную.',
  LEAD_CLOSED: 'Запрос уже закрыт.',
  LEAD_EXCLUDED: 'Такие задачи не берём.',
  LEAD_TOO_OLD: 'Запрос старше 60 дней.',
  POLICY_REPLY_TEXT: 'Отклик не прошёл проверку текста.',
  POLICY_REPLY_URL: 'В отклике была чужая ссылка.',
  POLICY_REPLY_CONTACT: 'В отклике были контакты, их не пишем.',
  POLICY_REPLY_PROMISE: 'Отклик обещал то, чего ферма не делает.',
  REPLY_DRAFT_FAILED: 'Модель не смогла написать отклик.',
  TEXT_QUALITY_FAILED: 'Текст модели не прошёл проверку.',
  REPORT_TEXT_REJECTED: 'Отчёт не прошёл проверку текста.',
  FREE_CALL_STILL_RUNNING: 'Модель ещё отвечает, повторим позже.',
  UNCERTAIN_CALL_REQUIRES_REVIEW: 'Исход вызова модели неясен, нужна проверка.',
}
/** «Запрос уже закрыт» -> «запрос уже закрыт» after a colon; acronyms stay. */
export const lowerFirst = (value: string) =>
  /^\p{Lu}\p{Ll}+(?!\p{L})/u.test(value) ? value[0]!.toLowerCase() + value.slice(1) : value

/** Lead codes that mean «no reply on purpose», not a failure. */
export const leadSkipCodes = new Set(['LEAD_CLOSED', 'LEAD_EXCLUDED', 'LEAD_TOO_OLD'])
/**
 * A reason from the server may be a bare code (POLICY_CONTENT_BLOCKED). People see words; the
 * code stays in the technical log.
 */
export function reasonText(text: string | null | undefined) {
  const value = String(text ?? '').trim()
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(value)) return value
  return (
    reasonCodes[value] ||
    messages[value] ||
    (/_HTTP_\d+$/.test(value)
      ? 'Модель была недоступна.'
      : 'Служебная причина, подробности в техжурнале.')
  )
}

export function describeError(error: unknown): OfficeError {
  const e = error as {
    status?: number
    statusCode?: number
    statusMessage?: string
    data?: { statusMessage?: string }
  }
  const status = Number(e?.statusCode || e?.status || 0)
  const code = e?.data?.statusMessage || e?.statusMessage || ''
  const known = /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? messages[code] : undefined
  const text =
    known ||
    (status === 0 || status >= 500
      ? 'Нет связи с сервером. Попробуем снова через несколько секунд.'
      : status === 404
        ? 'Не нашли. Возможно, это уже удалили или ссылка неверная.'
        : 'Не получилось. Попробуйте ещё раз.')
  return { status, code, text }
}

export const errorMessage = (error: unknown) => describeError(error).text
