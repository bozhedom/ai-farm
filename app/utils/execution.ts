const messages: Record<string, string> = {
  EXECUTION_CONFIGURED: 'Настройки сохранены',
  EXECUTION_SETTINGS_UPDATED: 'Условия работы обновлены',
  EXECUTION_STARTED: 'Работа началась',
  EXECUTION_PAUSED: 'Новые сделки приостановлены',
  EXECUTION_CLOSE_REQUESTED: 'Запрошено закрытие позиции',
  EXECUTION_POSITION_OPENING: 'Начат новый цикл',
  EXECUTION_POSITION_CLOSED: 'Цикл завершён',
  EXECUTION_WAITING_OPPORTUNITY: 'Подходящих условий пока нет. Продолжаем наблюдать.',
  EXECUTION_BUSY: 'Сейчас проверяется операция. Повторите через несколько секунд.',
  EXECUTION_CREDENTIALS_REQUIRED: 'Подключение к счёту не настроено.',
  EXECUTION_WALLET_REQUIRED: 'Кошелёк не подключён.',
  EXECUTION_LIVE_DISABLED: 'Реальные операции выключены в настройках подключения.',
  EXECUTION_DEMO_ACCEPTANCE_REQUIRED:
    'Раньше для Live нужны были Demo-циклы; с 28.10.2026 это не требуется.',
  EXECUTION_ALLOCATION_REQUIRED: 'Укажите сумму для этого направления.',
  EXECUTION_ALLOCATION_IMMUTABLE: 'После первого запуска сумма закреплена за счётом.',
  EXECUTION_CONNECTIONS_IMMUTABLE: 'После первого запуска подключённые счета менять нельзя.',
  EXECUTION_SETTINGS_REQUIRE_PAUSE: 'Перед изменением условий поставьте счёт на паузу.',
  EXECUTION_SETTINGS_POSITION_OPEN: 'Перед изменением условий завершите открытый цикл.',
  EXECUTION_ASSET_REGISTRY_REQUIRED: 'Монеты для межбиржевых сделок ещё не подтверждены.',
  EXECUTION_NO_ELIGIBLE_ASSETS: 'Нет доступных монет, подходящих условиям.',
  EXECUTION_INVENTORY_REQUIRED:
    'Для арбитража нужны монеты на счёте продажи и USDT на счёте покупки.',
  EXECUTION_ALLOCATION_INVENTORY_MISMATCH: 'Распределение USDT и монет не соответствует бюджету.',
  EXECUTION_BALANCE_REQUIRED: 'Недостаточно средств на подключённом счёте.',
  EXECUTION_BUDGET_EXCEEDED: 'Операция превышает выделенную сумму.',
  EXECUTION_ORDER_UNKNOWN:
    'Проверяем результат отправленной операции. Повторная заявка не отправляется.',
  EXECUTION_RECONCILIATION_REQUIRED: 'Сначала нужно сверить незавершённую операцию.',
  EXECUTION_RESIDUAL_DUST: 'Остаток меньше минимального размера сделки. Он сохранён на счёте.',
  EXECUTION_RESIDUAL_POSITION: 'Позиция закрыта не полностью. Нужна сверка.',
  EXECUTION_DRAWDOWN_STOP: 'Достигнут предел просадки. Новые операции остановлены.',
  EXECUTION_DAILY_LOSS_STOP: 'Достигнут дневной предел убытка.',
  EXECUTION_INVENTORY_LOSS_STOP:
    'Стоимость монет достигла предела убытка. Новые сделки остановлены.',
  EXECUTION_RISK_STOP: 'Счёт остановлен по пределу риска.',
  EXECUTION_ACCOUNT_DRIFT: 'Баланс счёта изменился вне системы. Нужна сверка.',
  EXECUTION_ACCOUNT_CHANGED: 'Подключён другой счёт. Работа приостановлена.',
  EXECUTION_ACCOUNT_ALREADY_USED: 'Этот счёт уже используется в другом направлении.',
  EXECUTION_YIELD_UNAVAILABLE: 'Ставка Aave временно недоступна.',
  EXECUTION_STALE_QUOTE: 'Ждём свежую цену.',
  EXECUTION_CONNECTION_FAILED: 'Нет ответа от подключения. Повторим проверку.',
  EXECUTION_DIFFERENT_EXCHANGES_REQUIRED: 'Выберите две разные биржи.',
  INVALID_INPUT: 'Проверьте сумму и настройки.',
}
export function executionMessage(code: string) {
  if (messages[code]) return messages[code]
  if (/CREDENTIAL|KEYS_REQUIRED|DEDICATED_ACCOUNT/.test(code))
    return 'Подключение к отдельному счёту не настроено.'
  if (/BALANCE|CAPITAL|MARGIN/.test(code)) return 'Недостаточно доступных средств для операции.'
  if (/REGION|ELIGIBILITY|LOCATION/.test(code))
    return 'Подключение недоступно для этого аккаунта или региона.'
  if (/PREDICTION.*TICKER|MARKET_REQUIRED/.test(code)) return 'Укажите код рынка.'
  if (/STALE|UNAVAILABLE|NETWORK/.test(code))
    return 'Данные временно недоступны. Повторим проверку.'
  return code ? 'Операция требует проверки. Код: ' + code : ''
}
export const executionStatuses: Record<string, string> = {
  idle: 'Не запущено',
  running: 'Работает',
  paused: 'На паузе',
  stopped: 'Остановлено',
  attention: 'Нужна проверка',
  opening: 'Открытие',
  open: 'Открыта',
  closing: 'Закрытие',
  closed: 'Завершено',
  prepared: 'Готовится',
  submitted: 'Отправлено',
  unknown: 'Сверка',
  terminal: 'Обработано',
}
export const executionActions: Record<string, string> = {
  buy: 'Покупка',
  sell: 'Продажа',
  short: 'Открытие хеджа',
  cover: 'Закрытие хеджа',
  approve: 'Разрешение суммы',
  revoke: 'Отмена разрешения',
  supply: 'Внесение',
  withdraw: 'Возврат',
}
