import { tradingStatus, tradingStatusText } from '../../core/income/trading-status'

export const tradingModes = [
  {
    id: 'paper',
    label: 'Тренировка',
    detail: 'Бот пробует стратегии по настоящим ценам. Деньги виртуальные, аккаунт биржи не нужен.',
  },
  {
    id: 'demo',
    label: 'Тест биржи',
    detail:
      'Проверяем покупки и продажи на тестовом счёте биржи. Настоящие деньги не используются.',
  },
  {
    id: 'live',
    label: 'Реальная торговля',
    detail: 'Бот торгует деньгами на ваших биржевых счетах. Каждую биржу вы запускаете отдельно.',
  },
] as const

const reasons: Record<string, string> = {
  MANAGER_EXPERIMENT_STARTED: 'Менеджер запустил отдельный тренировочный эксперимент',
  MANAGER_EVALUATED: 'Менеджер подвёл итог тренировочного эксперимента',
  CLASSIC_PAPER_ONLY: 'Эта стратегия пока проверяется только на виртуальных деньгах.',
  CLASSIC_CAPITAL_TOO_SMALL: 'Для следующей ступени не хватает средств в пределах лимитов.',
  DCA_SCHEDULED_ENTRY: 'Плановая покупка очередной части позиции',
  GRID_FIRST_LEVEL: 'Первая покупка сетки',
  GRID_NEXT_LEVEL: 'Покупка следующей ступени сетки',
  GRID_TAKE_PROFIT: 'Продажа ступени после отскока',
  GRID_LOT_BELOW_MINIMUM: 'Ступень меньше минимальной сделки. Ждём выхода всей позицией.',
  STRATEGY_PRESET_CHANGED: 'Свободный агент перешёл на выбранный набор',
  STRATEGY_PRESET_SELECTED: 'Выбран набор тренировочных стратегий',
  TRADING_STRATEGY_STATE_INVALID: 'Состояние стратегии требует проверки. Новые сделки запрещены.',
  TRADING_STRATEGY_PRESET_INVALID: 'Выберите существующий набор стратегий.',
  TRADING_CLASSIC_PAPER_ONLY: 'Сетка и DCA пока доступны только в тренировке.',
  SCOUT_READY: 'Прошла проверку',
  SCOUT_ON_RADAR: 'В резерве для проверки стакана',
  SCOUT_INACTIVE: 'Торговля парой недоступна',
  SCOUT_UNSUITABLE_ASSET: 'Не подходит для этих стратегий',
  SCOUT_NO_DATA: 'Нет свежих полных данных',
  SCOUT_NEW_LISTING: 'После листинга прошло меньше суток',
  SCOUT_LOW_VOLUME: 'Недостаточный оборот',
  SCOUT_EXTREME_MOVE: 'Слишком резкое движение',
  SCOUT_QUIET: 'Мало движения цены',
  SCOUT_SHORT_HISTORY: 'Недостаточно истории свечей',
  SCOUT_THIN_BOOK: 'Мало заявок в стакане',
  SCOUT_ORDER_TOO_SMALL: 'Для этой пары нужен больший ордер',
  SCOUT_WAITING: 'Ждёт подходящую монету или обновление отбора',
  SCOUT_DUST_POSITION: 'Остаток меньше минимальной продажи. Сохраняется в учёте.',
  SCOUT_TIME_EXIT: 'Закрытие по времени удержания',
  SCOUT_STAGNANT_EXIT: 'Закрытие позиции, потерявшей условия для торговли',
  SCOUT_ASSIGNED: 'Разведчик назначил монету',
  SCOUT_ADOPTED: 'Начата проверка стратегии с автоматическим подбором монет',
  SCOUT_IDLE_ROTATION: 'После ожидания без сделок выбрана другая монета',
  SCOUT_REPLACED: 'Прежняя монета перестала проходить отбор',
  TRADING_CATALOG_INVALID: 'Не удалось получить полный каталог пар биржи.',
  TRADING_NO_CANDIDATES: 'Пока нет монет, прошедших проверку. Дождитесь следующего отбора.',
  TRADING_POSITION_UNPRICED: 'Для открытой позиции нет свежей цены. Новые покупки приостановлены.',
  TRADING_CREDENTIALS_REQUIRED: 'Счёт не подключён. Откройте раздел «Подключение».',
  TRADING_REGION_UNAVAILABLE:
    'Доступ к API ограничен. Проверьте доступность биржи для аккаунта и адреса сервера.',
  TRADING_RATE_LIMIT: 'Биржа ограничила частоту запросов. Повторим проверку в следующем цикле.',
  TRADING_FEE_TOKEN_ENABLED: 'Отключите оплату торговых комиссий в BNB / BGB в кабинете биржи.',
  TRADING_ALLOCATION_REQUIRED: 'Сначала выделите этой бирже от 20 USDT в настройках бюджета.',
  TRADING_ALLOCATION_INVALID: 'Укажите для каждой биржи 0 или целую сумму от 20 USDT.',
  TRADING_ALLOCATION_LOCKED:
    'После первого реального запуска бюджет этого портфеля изменять нельзя.',
  ALLOCATION_UPDATED: 'Обновлено распределение реального бюджета',

  TRADING_KEYS_REQUIRED: 'Счёт не подключён. Откройте раздел «Подключение».',
  TRADING_LIVE_DISABLED: 'Реальная торговля выключена. Для включения обратитесь к администратору.',
  TRADING_KEY_PERMISSIONS: 'Нужен ключ с чтением и торговлей, без права вывода средств.',
  TRADING_IP_REQUIRED: 'Привяжите реальный API-ключ к статическому IP сервера в кабинете биржи.',
  TRADING_ACCOUNT_MODE: 'Проверьте требуемый режим счёта в инструкции выбранной биржи.',
  TRADING_DEBT_FORBIDDEN: 'На аккаунте есть заём. Нужен отдельный аккаунт без долгов.',
  TRADING_POSITIONS_EXIST:
    'На аккаунте есть позиции с деривативами. Используйте отдельный аккаунт для спота.',
  TRADING_INITIAL_ASSETS:
    'Перед первым запуском на отдельном торговом аккаунте должны быть только USDT.',
  TRADING_INSUFFICIENT_FUNDS:
    'На торговом аккаунте недостаточно свободных USDT для выделенного бюджета.',
  TRADING_ACCOUNT_CHANGED:
    'Подключён другой аккаунт. Верните ключи исходного аккаунта, чтобы сохранить сверку.',
  TRADING_EXTERNAL_ORDERS:
    'На аккаунте есть открытые ордера. Проверьте их на бирже и остановите другие боты.',
  TRADING_BALANCE_DRIFT:
    'Баланс биржи отличается от журнала. Проверьте ручные сделки и переводы; новые ордера остановлены.',
  TRADING_ORDER_UNKNOWN:
    'Ответ на отправленный ордер неизвестен. Проверяем биржу по его ID, повторную заявку не отправляем.',
  TRADING_ORDER_REJECTED:
    'Биржа отклонила ордер. Проверьте баланс, доступность пары и ограничения аккаунта на бирже.',
  TRADING_ORDER_MISMATCH: 'Биржа вернула другой ордер. Торговля ждёт сверки.',
  TRADING_FILLS_INCOMPLETE:
    'История исполнения ордера пока неполная. Ждём подтверждения всех сделок.',
  TRADING_FILL_INVALID: 'Данные исполнения не прошли проверку. Нужна сверка с историей биржи.',
  TRADING_FILL_OUTSIDE_LIMIT: 'Цена исполнения не совпала с лимитом. Торговля ждёт сверки.',
  TRADING_FEE_TOO_HIGH: 'Комиссия выше допустимых 0,25%. Проверьте тариф аккаунта.',
  TRADING_FEE_UNKNOWN: 'Не удалось подтвердить торговую комиссию этого аккаунта.',
  TRADING_FEE_CURRENCY: 'Биржа списала комиссию в неподдерживаемой валюте. Нужна сверка.',
  TRADING_NETWORK_UNAVAILABLE: 'Нет ответа биржи. Новые ордера ждут восстановления связи.',
  TRADING_EXCHANGE_ERROR:
    'Биржа отклонила запрос. Проверьте ключи, регион аккаунта и доступность API.',
  TRADING_RESPONSE_INVALID: 'Ответ биржи не прошёл проверку. Новые ордера ждут корректных данных.',
  TRADING_CLOCK_SKEW:
    'Часы сервера расходятся с биржей. Включите синхронизацию времени на сервере.',
  TRADING_STALE_MARKET:
    'Котировки устарели. Ждём свежий стакан, чтобы не торговать по старой цене.',
  TRADING_STALE_CANDLES: 'Нет свежих закрытых свечей. Ждём обновления рынка.',
  TRADING_SPREAD_TOO_WIDE: 'Разница покупки и продажи выше лимита. Ждём подходящих цен.',
  TRADING_BUSY: 'Сейчас идёт проверка или сверка ордера. Повторите через несколько секунд.',
  TRADING_PAPER_REQUIRED:
    'Раньше для Live нужен был прибыльный Paper; с 28.10.2026 это не требуется.',
  TRADING_DEMO_REQUIRED: 'Раньше для Live нужен был Demo-цикл; с 28.10.2026 это не требуется.',
  TRADING_CONFIRMATION_REQUIRED: 'Введите подтверждение точно как показано в форме.',
  TRADING_CONTROL_CHANGED: 'Во время проверки изменилось управление или бюджет. Запуск отменён.',
  TRADING_DAILY_LOCKED:
    'Достигнут дневной предел убытка. Повторный запуск возможен после смены UTC-суток.',
  TRADING_DRAWDOWN_LOCKED:
    'Достигнута общая просадка 10%. Этот эксперимент остановлен, автоматического сброса нет.',
  TRADING_REVIEW_NOT_READY:
    'Подтвердить отсутствие можно через минуту после отправки, при остановленном портфеле.',
  TRADING_ORDER_EXISTS:
    'Ордер найден на бирже. Дождитесь автоматической сверки, не подтверждайте его отсутствие.',
  DAILY_LOSS_LIMIT:
    'Дневной убыток достиг 2%. Новые входы остановлены, позиции закрываются. Тренировка и демо продолжатся сами в следующие UTC-сутки; реальную торговлю возобновляете вы.',
  DAILY_LOSS_RESET: 'Новые UTC-сутки: тренировка продолжена после дневного лимита убытка',
  DAILY_LOSS_RESET_PAUSE_KEPT:
    'Новые UTC-сутки: дневной лимит снят, прежняя пауза сохранена до решения владельца',
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
  NO_PROVEN_EDGE: 'У лидеров пока нет достаточного преимущества. Состав сохраняется.',
  LEADERS_CLONED: 'Поколение сохранено. На основе лидеров созданы новые варианты.',
  LIVE_LEADER_PROMOTED:
    'Капитал передан более сильному бумажному агенту. История прежнего агента сохранена.',
  WAITING_MARKET: 'Ожидание котировок',
  WARMING_UP: 'Собирает историю цен',
  WAITING_SIGNAL: 'Ждёт подходящую цену',
  HOLDING_POSITION: 'Следит за купленной монетой',
  STRATEGY_ENTRY: 'Покупка по условиям стратегии',
  POSITION_STOP: 'Защитный выход',
  TAKE_PROFIT: 'Фиксация прибыли',
  RISK_EXIT: 'Закрытие позиции',
  ENTRIES_PAUSED: 'Новые покупки на паузе',
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
  grid: 'Ограниченная сетка',
  dca: 'Покупка частями',
  reversion: 'Возврат к средней',
  trend: 'Следование тренду',
  breakout: 'Пробой диапазона',
}
export const strategyDescription = {
  grid: 'Покупает небольшими ступенями при снижении, продаёт отдельные части после отскока. До трёх одновременно открытых ступеней.',
  dca: 'Делит вход на равные части по расписанию. Не больше трёх покупок за цикл, со стопом и лимитом времени.',
  reversion: 'Покупает после снижения цены и ждёт её возврата к средней.',
  trend: 'Покупает, когда цена растёт устойчиво, и следит за разворотом.',
  breakout: 'Покупает, когда цена выходит выше недавнего диапазона.',
}

/** One status per exchange, the same words as on the overview. */
export function connectionState(
  c: { status: string; keys: boolean; error: string; workerAlive: boolean; fresh: boolean },
  mode: 'paper' | 'demo' | 'live',
  autoResume?: boolean,
) {
  const s = tradingStatus({ ...c, mode, reason: c.error, autoResume })
  return { label: s.label, next: s.next, tone: s.tone, text: tradingStatusText(s) }
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
