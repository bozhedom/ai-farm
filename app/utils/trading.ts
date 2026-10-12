export const tradingModes = [
  { id: 'paper', label: 'Бумага', detail: 'Рынок настоящий, капитал виртуальный' },
  { id: 'demo', label: 'Демо OKX', detail: 'Проверка ордеров на тестовом счёте' },
  { id: 'live', label: 'Реальные средства', detail: 'Торговля на вашем аккаунте OKX' },
] as const

const reasons: Record<string, string> = {
  TRADING_KEYS_REQUIRED: 'Добавьте ключ, секрет и парольную фразу выбранного счёта на сервере.',
  TRADING_LIVE_DISABLED:
    'Реальная торговля выключена на сервере. После проверок включите TRADING_LIVE_ENABLED.',
  TRADING_KEY_PERMISSIONS: 'Нужен ключ с чтением и торговлей, без права вывода средств.',
  TRADING_IP_REQUIRED: 'Привяжите реальный API-ключ к статическому IP сервера в кабинете OKX.',
  TRADING_ACCOUNT_MODE:
    'В OKX выберите режим Spot. Маржинальные режимы этого аккаунта не поддерживаются.',
  TRADING_DEBT_FORBIDDEN: 'На аккаунте есть заём. Нужен отдельный аккаунт без долгов.',
  TRADING_POSITIONS_EXIST:
    'На аккаунте есть позиции с деривативами. Используйте отдельный аккаунт для спота.',
  TRADING_INITIAL_ASSETS:
    'Перед первым запуском на торговом аккаунте должны быть только USDT, без BTC и ETH.',
  TRADING_INSUFFICIENT_FUNDS: 'На торговом аккаунте нужно минимум 100 свободных USDT.',
  TRADING_ACCOUNT_CHANGED:
    'Подключён другой аккаунт. Верните ключи исходного аккаунта, чтобы сохранить сверку.',
  TRADING_EXTERNAL_ORDERS:
    'На аккаунте есть открытые ордера. Проверьте их на бирже и остановите другие боты.',
  TRADING_BALANCE_DRIFT:
    'Баланс биржи отличается от журнала. Проверьте ручные сделки и переводы; новые ордера остановлены.',
  TRADING_ORDER_UNKNOWN:
    'Ответ на отправленный ордер неизвестен. Проверяем биржу по его ID, повторную заявку не отправляем.',
  TRADING_ORDER_REJECTED:
    'Биржа отклонила ордер. Проверьте баланс, доступность пары и ограничения аккаунта в OKX.',
  TRADING_ORDER_MISMATCH: 'Биржа вернула другой ордер. Торговля ждёт сверки.',
  TRADING_FILLS_INCOMPLETE:
    'История исполнения ордера пока неполная. Ждём подтверждения всех сделок.',
  TRADING_FILL_INVALID: 'Данные исполнения не прошли проверку. Нужна сверка с историей биржи.',
  TRADING_FILL_OUTSIDE_LIMIT: 'Цена исполнения не совпала с лимитом. Торговля ждёт сверки.',
  TRADING_FEE_TOO_HIGH: 'Комиссия выше допустимых 0,25%. Проверьте тариф аккаунта.',
  TRADING_FEE_UNKNOWN: 'Не удалось подтвердить торговую комиссию этого аккаунта.',
  TRADING_FEE_CURRENCY: 'Биржа списала комиссию в неподдерживаемой валюте. Нужна сверка.',
  TRADING_NETWORK_UNAVAILABLE: 'Нет ответа OKX. Новые ордера ждут восстановления связи.',
  TRADING_EXCHANGE_ERROR:
    'OKX отклонил запрос. Проверьте ключи, регион аккаунта и доступность API.',
  TRADING_RESPONSE_INVALID: 'Ответ биржи не прошёл проверку. Новые ордера ждут корректных данных.',
  TRADING_CLOCK_SKEW: 'Часы сервера расходятся с OKX. Включите синхронизацию времени на сервере.',
  TRADING_STALE_MARKET:
    'Котировки устарели. Ждём свежий стакан, чтобы не торговать по старой цене.',
  TRADING_STALE_CANDLES: 'Нет свежих закрытых свечей. Ждём обновления рынка.',
  TRADING_SPREAD_TOO_WIDE: 'Разница покупки и продажи выше лимита. Ждём подходящих цен.',
  TRADING_BUSY: 'Сейчас идёт проверка или сверка ордера. Повторите через несколько секунд.',
  TRADING_PAPER_REQUIRED:
    'Сначала нужен прибыльный бумажный агент: 7 дней, 20 закрытых позиций и просадка не выше 8%.',
  TRADING_DEMO_REQUIRED:
    'Сначала завершите проверочный цикл на Демо OKX и обновите проверку подключения.',
  TRADING_CONFIRMATION_REQUIRED: 'Введите подтверждение точно как показано в форме.',
  TRADING_CONTROL_CHANGED: 'Во время проверки был нажат стоп. Запуск отменён.',
  TRADING_DAILY_LOCKED:
    'Достигнут дневной предел убытка. Повторный запуск возможен после смены UTC-суток.',
  TRADING_DRAWDOWN_LOCKED:
    'Достигнута общая просадка 10%. Этот эксперимент остановлен, автоматического сброса нет.',
  TRADING_REVIEW_NOT_READY:
    'Подтвердить отсутствие можно через минуту после отправки, при остановленном портфеле.',
  TRADING_ORDER_EXISTS:
    'Ордер найден на бирже. Дождитесь автоматической сверки, не подтверждайте его отсутствие.',
  DAILY_LOSS_LIMIT: 'Дневной убыток достиг 2%. Новые входы остановлены, позиции закрываются.',
  DRAWDOWN_LIMIT: 'Просадка достигла 10%. Новые входы остановлены, позиции закрываются.',
  OWNER_PAUSE:
    'Новые входы приостановлены. Открытые позиции контролируются по стопу и фиксации прибыли.',
  OWNER_STOP:
    'Новые заявки остановлены. Активы остаются на бирже; начатые ордера продолжают сверяться.',
  OWNER_EXIT: 'Закрываем доступные позиции. Новые входы приостановлены.',
  DEMO_PROBE_COMPLETE:
    'Покупка, продажа и сверка демо-счёта завершены. Тестовая торговля на паузе.',
  COLLECTING_DATA: 'Накапливаем наблюдения для отбора.',
  POSITIONS_OPEN: 'Отбор ждёт закрытия текущих позиций.',
  NO_PROVEN_EDGE: 'У двух лидеров пока нет достаточного преимущества. Состав сохраняется.',
  LEADERS_CLONED: 'Поколение сохранено. Созданы четыре потомка двух лидеров.',
  LIVE_LEADER_PROMOTED:
    'Капитал передан более сильному бумажному агенту. История прежнего агента сохранена.',
  WAITING_MARKET: 'Ожидание котировок',
  WARMING_UP: 'Накапливает свечи',
  WAITING_SIGNAL: 'Ждёт сигнала стратегии',
  HOLDING_POSITION: 'Контролирует позицию',
  STRATEGY_ENTRY: 'Вход по стратегии',
  POSITION_STOP: 'Защитный выход',
  TAKE_PROFIT: 'Фиксация прибыли',
  RISK_EXIT: 'Закрытие позиции',
  ENTRIES_PAUSED: 'Входы на паузе',
  DEMO_PROBE: 'Проверочная демо-сделка',
  STARTED: 'Портфель запущен',
  LIVE_AUTHORIZED: 'Владелец подтвердил реальную торговлю',
  CONNECTION_OK: 'Подключение проверено',
  ORDER_FILLED: 'Исполнение учтено',
  ORDER_UNFILLED: 'Ордер не исполнился',
  NOT_SENT: 'Неотправленное намерение отменено после остановки',
  OWNER_VERIFIED_ABSENT: 'Владелец подтвердил отсутствие ордера на бирже',
}
export const tradingReason = (code: string) =>
  reasons[code] ||
  (code ? 'Проверка не пройдена. Подробности доступны в журнале и инструкции подключения.' : '')
export const strategyName = {
  reversion: 'Возврат к средней',
  trend: 'Следование тренду',
  breakout: 'Пробой диапазона',
}
export const orderStatus: Record<string, string> = {
  prepared: 'Подготовлен',
  submitted: 'Сверка исполнения',
  unknown: 'Нужна сверка',
  filled: 'Исполнен',
  canceled: 'Отменён / частично исполнен',
  rejected: 'Отклонён',
}

/** Rounded display only. Accounting never consumes these formatted or floating-point values. */
export function usdt(value: string, digits = 2) {
  return Number(value).toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}
export const pct = (bps: number) =>
  `${(bps / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`
export const shortTime = (value: string) =>
  new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
