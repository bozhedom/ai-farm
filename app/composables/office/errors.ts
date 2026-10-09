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
  IDEA_ALREADY_TAKEN: 'У вас уже есть идея в работе. Сначала верните её в рейтинг.',
  IDEA_STATUS_CHANGE_FORBIDDEN: 'Так поменять статус идеи нельзя.',
  LEAD_SEARCH_LIMIT: 'На сегодня поиски клиентов закончились. Лимит в настройках.',
  PRODUCT_NOT_PUBLIC: 'Сначала покажите продукт на сайте.',
  INVALID_INPUT: 'Проверьте введённые данные.',
  RATE_LIMITED: 'Слишком часто. Подождите минуту.',
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
}
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
