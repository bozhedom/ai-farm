/**
 * One owner-facing status per exchange portfolio, shared by the overview, the income sources
 * and the trading page. Pure: no database, safe to import from the browser bundle.
 * Server reason codes never reach the text; unknown codes become a neutral phrase.
 */

export type TradingStatusInput = {
  mode: 'paper' | 'demo' | 'live'
  status: 'idle' | 'running' | 'paused' | 'stopped' | string
  /** Portfolio check error or stop reason, as stored. */
  reason: string
  keys?: boolean
  workerAlive?: boolean
  fresh?: boolean
  /** The server autopilot is on: it restarts training after the daily loss pause. */
  autoResume?: boolean
}

export type TradingStatusTone = 'good' | 'muted' | 'warning'

export type TradingStatus = {
  /** Short status, e.g. «На паузе: дневной лимит убытка». */
  label: string
  /** What happens next, e.g. «продолжит после 00:00 UTC»; may be empty. */
  next: string
  tone: TradingStatusTone
  /** True when trading waits for a limit or a problem, not for the owner's own choice. */
  problem: boolean
}

const checkWords: Record<string, string> = {
  TRADING_CREDENTIALS_REQUIRED: 'счёт не подключён',
  TRADING_KEYS_REQUIRED: 'счёт не подключён',
  TRADING_NETWORK_UNAVAILABLE: 'нет ответа биржи',
  TRADING_RATE_LIMIT: 'биржа ограничила частоту запросов',
  TRADING_STALE_MARKET: 'ждём свежие цены',
  TRADING_STALE_CANDLES: 'ждём свежие цены',
  TRADING_POSITION_UNPRICED: 'нет свежей цены купленной монеты',
  TRADING_BALANCE_DRIFT: 'баланс биржи не сходится с журналом',
  TRADING_ORDER_UNKNOWN: 'нужна сверка заявки',
  TRADING_EXTERNAL_ORDERS: 'на счёте есть чужие заявки',
  TRADING_KEY_PERMISSIONS: 'у ключа не те права',
  TRADING_EXCHANGE_ERROR: 'биржа отклонила запрос',
  TRADING_REGION_UNAVAILABLE: 'биржа недоступна из региона сервера',
  TRADING_INSUFFICIENT_FUNDS: 'не хватает USDT на счёте',
  TRADING_CLOCK_SKEW: 'часы сервера расходятся с биржей',
}

/** A trading reason code in a few plain words, without the code itself. */
export function tradingReasonWords(code: string) {
  if (!code) return ''
  if (code === 'DAILY_LOSS_LIMIT' || code === 'TRADING_DAILY_LOCKED') return 'дневной лимит убытка'
  if (code === 'DRAWDOWN_LIMIT' || code === 'TRADING_DRAWDOWN_LOCKED') return 'лимит просадки'
  if (code === 'OWNER_PAUSE') return 'вы приостановили покупки'
  if (code === 'OWNER_STOP') return 'остановлено вами'
  if (code === 'OWNER_EXIT') return 'вы попросили продать монеты'
  if (code === 'DEMO_PROBE_COMPLETE') return 'проверка тестового счёта завершена'
  return checkWords[code] ?? 'нужна проверка'
}

export function tradingStatus(input: TradingStatusInput): TradingStatus {
  const { mode, status, reason } = input
  const auto = mode === 'paper' && !!input.autoResume
  if (reason.startsWith('TRADING_') && !/_LOCKED$/.test(reason) && status !== 'idle')
    return {
      label: `Нужна проверка: ${tradingReasonWords(reason)}`,
      next: '',
      tone: 'warning',
      problem: true,
    }
  if (input.keys === false && mode !== 'paper')
    return { label: 'Не подключена', next: '', tone: 'muted', problem: false }
  if (status === 'idle') return { label: 'Не запущена', next: '', tone: 'muted', problem: false }
  if (status === 'paused' || status === 'stopped') {
    if (reason === 'DAILY_LOSS_LIMIT' || reason === 'TRADING_DAILY_LOCKED')
      return {
        label: 'На паузе: дневной лимит убытка',
        next: auto ? 'продолжит после 00:00 UTC' : 'запустить снова можно после 00:00 UTC',
        tone: 'warning',
        problem: true,
      }
    if (reason === 'DRAWDOWN_LIMIT' || reason === 'TRADING_DRAWDOWN_LOCKED')
      return {
        label: 'Остановлена: лимит просадки',
        next: 'сама не продолжит, решаете вы',
        tone: 'warning',
        problem: true,
      }
    if (reason === 'OWNER_PAUSE')
      return {
        label: 'На паузе: вы приостановили покупки',
        next: 'продолжит, когда нажмёте «Продолжить»',
        tone: 'muted',
        problem: false,
      }
    if (reason === 'OWNER_EXIT')
      return {
        label: 'Продаёт монеты по вашей команде',
        next: 'новых покупок нет',
        tone: 'muted',
        problem: false,
      }
    if (reason === 'DEMO_PROBE_COMPLETE')
      return {
        label: 'Проверка пройдена, торговля на паузе',
        next: '',
        tone: 'good',
        problem: false,
      }
    if (status === 'stopped')
      return {
        label: 'Остановлено вами',
        next: 'снова запускаете вы',
        tone: 'muted',
        problem: false,
      }
    return { label: 'На паузе', next: '', tone: 'muted', problem: false }
  }
  if (input.workerAlive === false)
    return { label: 'Бот не на связи', next: '', tone: 'warning', problem: true }
  if (input.fresh === false)
    return { label: 'Работает, ждёт свежие цены', next: '', tone: 'warning', problem: false }
  return { label: 'Работает', next: '', tone: 'good', problem: false }
}

/** «На паузе: дневной лимит убытка, продолжит после 00:00 UTC». */
export const tradingStatusText = (s: TradingStatus) => (s.next ? `${s.label}, ${s.next}` : s.label)
