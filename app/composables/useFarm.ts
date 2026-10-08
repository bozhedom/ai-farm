export function useFarm() {
  const request = useRequestFetch()
  const state = useState<any>('farm-dashboard', () => null)
  const failure = useState('farm-error', () => '')
  const refreshing = useState('farm-refreshing', () => false)
  async function refresh() {
    if (refreshing.value) return
    refreshing.value = true
    try {
      state.value = await request('/api/dashboard', { timeout: 10000 })
      failure.value = ''
    } catch (error: any) {
      if (error.statusCode === 401 || error.status === 401) await navigateTo('/login')
      else failure.value = 'Не удалось обновить данные. Проверьте соединение.'
    } finally {
      refreshing.value = false
    }
  }
  return { state, failure, refresh }
}
export const rub = (kopecks: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(kopecks / 100)
export const usd = (microusd: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(microusd / 1000000)
export const dateTime = (date: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date))
export const labels: Record<string, string> = {
  running: 'В работе',
  paused: 'Пауза',
  emergency_stop: 'Аварийный стоп',
  queued: 'В очереди',
  done: 'Готово',
  failed: 'Ошибка',
  research: 'Исследование',
  fulfill: 'Исполнение',
  evaluate: 'Оценка',
  accepted: 'Принята',
  rejected: 'Отклонена',
  backlog: 'В резерве',
  active: 'Активна',
  archived: 'Архив',
  awaiting_payment: 'Ждёт оплаты',
  paid: 'Оплата подтверждена',
  delivered: 'Выдан',
  manual_review: 'Нужна проверка',
  expired: 'Срок истёк',
  closed: 'Закрыт без выдачи',
  cancelled: 'Отменено',
  pending: 'Ожидает очереди',
  sandbox: 'Тестовый режим',
  sepolia: 'Sepolia',
  description: 'Описание товара',
  faq: 'Вопросы и ответы',
  social: 'Публикации',
  PASS: 'Допущено',
  REVISE: 'Доработать',
  BLOCKED: 'Остановлено',
  HOLD: 'Недостаточно данных',
  SIMULATION: 'Симуляция',
  CLOSED: 'Закрыт без победителя',
}
export function errorText(error: any) {
  const code = error?.data?.statusMessage || error?.statusMessage || ''
  const errors: Record<string, string> = {
    SCHEDULE_DISABLED_ON_SERVER:
      'Расписание отключено на сервере по решению владельца. Денежные лимиты сохраняются.',
    RESEARCH_PAUSED: 'Сначала возобновите работу системы.',
    RESEARCH_WINDOW_CLOSED: 'Окно исследований закрыто. Откройте новое окно наблюдения.',
    RESEARCH_CAMPAIGN_SCHEDULE_PAUSED:
      'Автоматический обход приостановлен вместе с расписанием. Включите расписание в настройках или отмените оставшиеся направления.',
    RESEARCH_DAILY_BUDGET_WAIT:
      'Исследование ждёт следующего дневного бюджета. История и попытки сохранены.',
    LOGIN_FAILED: 'Неверный пароль.',
    LOGIN_RATE_LIMIT: 'Слишком много попыток. Повторите через 10 минут.',
    ORIGIN_REJECTED: 'Адрес сайта не совпадает с APP_ORIGIN в настройках.',
    BUDGET_BLOCKED: 'Лимит расходов исчерпан. Задача остановлена.',
    OPENAI_BUDGET_BLOCKED:
      'Общий предел платной модели не позволяет следующий запрос. Расходы сохранены; автоматического пополнения нет.',
    NEW_ORDERS_PAUSED: 'Новые заказы приостановлены.',
    OPEN_OBLIGATIONS: 'Сначала завершите принятые заказы.',
    POLICY_CONTENT_BLOCKED: 'Материал выходит за разрешённые темы пилота.',
    UNTRUSTED_INSTRUCTION_BLOCKED: 'В материале обнаружены инструкции, нарушающие правила.',
    INPUT_LENGTH: 'Добавьте от 30 до 4 000 символов исходных данных.',
    INPUT_SOCIAL_LENGTH: 'Для трёх вариантов оформления используйте материал до 3 000 символов.',
    TRANSLATION_LANGUAGE_REQUIRED:
      'Укажите язык первой строкой, например «Язык перевода: английский», затем добавьте исходный текст с новой строки.',
    MODEL_SCHEMA_INVALID:
      'Модель ответила в неверном формате. Этап не принят. Проверьте подробности в журнале и настройки модели перед новым запуском.',
    OUTPUT_FORMAT_REQUIRED:
      'В тексте нет обязательных частей результата. Проверьте требования выбранной услуги и причину отказа; результат не выдан.',
    OPENROUTER_RESPONSE_ERROR:
      'OpenRouter сообщил об ошибке запроса. Проверьте доступность модели и журнал. Перед новым запуском проверьте исход предыдущего запроса.',
    MODEL_OUTPUT_INCOMPLETE:
      'Модель не завершила ответ. Неполный результат не принят. Проверьте журнал и состояние запроса у провайдера перед новым запуском.',
    UNCERTAIN_CALL_REQUIRES_REVIEW:
      'Исход запроса к модели неизвестен. Автоматический повтор заблокирован. Проверьте журнал и расходы у провайдера; для заказа завершите ручную проверку перед новым запуском.',
    LEASE_LOST:
      'Обработчик больше не может продолжать это задание. Обновите страницу и проверьте состояние служб и журнал. Перед новым запуском проверьте исход предыдущей попытки.',
    PRODUCT_RECIPE_REFRESH_REQUIRED:
      'Эту версию публикаций нужно обновить для локальной модели. Запустите новое исследование публикаций.',
    TX_ALREADY_USED: 'Этот хеш уже закреплён за другим заказом, в том числе в истории попыток.',
    DUPLICATE_PAYMENT_OR_REQUEST: 'Эта транзакция или запрос уже использованы.',
    INVOICE_EXPIRED: 'Срок счёта истёк. Создайте новый тестовый заказ.',
    ORDER_NOT_PAYABLE: 'Этот заказ уже оплачен или срок его оплаты истёк.',
    ORDER_NOT_RESOLVABLE:
      'Закрыть можно только тестовый заказ, требующий ручной проверки. Обновите страницу.',
    ORDER_ALREADY_RESOLVED:
      'Заказ уже закрыт с другой причиной. Обновите страницу, чтобы увидеть сохранённое решение.',
    SEARCH_INSUFFICIENT_SOURCES:
      'Недостаточно независимых источников. Повторите исследование позже.',
    INVALID_INPUT: 'Проверьте формат и длину введённых данных.',
  }
  return errors[code] || `Действие не выполнено${code ? ': ' + code : '. Проверьте соединение.'}`
}
