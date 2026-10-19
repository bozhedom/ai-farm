import { setTimeout as pause } from 'node:timers/promises'
import { config } from './config'
import { audit, query, transaction } from './db'
import { setSchedule } from './autonomy'
import { budgetSummary } from './budget'
import { pacingNumbers } from './queue'
import { pacingDecision } from './pacing'
import { controlManager, managerBudget, managerModelBlocker } from './manager/runtime'
import { startTrading, safeTradingError, type VenueFactory } from './trading/engine'
import { ensurePortfolios, scope } from './trading/store'
import { hasKeys } from './trading/wire'
import { exchanges, type TradingExchange } from './trading/types'
import { configureExecution, controlExecution, type ExecutionFactory } from './execution/engine'
import { executionReady } from './execution/config'
import {
  defaultExecutionSettings,
  ensureExecution,
  executionRiskStopped,
  safeExecutionError,
} from './execution/store'
import { executionTracks, type ExecutionTrack } from './execution/types'
import { EXECUTION_POLICY } from './policy'
import { units } from './trading/decimal'
import { workerLoops } from './worker-loops'
import type { AutopilotDecision, AutonomyView } from './contracts/autonomy'

/**
 * Server autopilot. It turns on the autonomous loops through the same server functions as the
 * office buttons. Hard rules, enforced here and by those functions:
 * - it acts only while the farm is running: a pause or emergency stop is the owner's;
 * - it only starts what was never started: a paused or stopped portfolio stays as it is;
 * - it never turns anything off, never touches Live, money limits or owner-defined capital;
 * - a schedule or manager the owner turned off stays off.
 */
export type TradingItem = {
  exchange: TradingExchange
  mode: 'paper' | 'demo' | 'live'
  status: string
  reason: string
  hasKeys: boolean
}
export type ExecutionItem = {
  track: ExecutionTrack
  mode: 'paper' | 'demo' | 'live'
  status: string
  reason: string
  started: boolean
  capitalOk: boolean
  /** Empty when credentials and configuration allow a start. */
  ready: string
}
export type AutopilotInput = {
  systemMode: string
  autonomyEnabled: boolean
  workspaceMode: 'trading' | 'studio'
  scheduleEnabled: boolean
  scheduleOwnerOff: boolean
  manager: { enabled: boolean; ownerOff: boolean; blocker: string }
  trading: TradingItem[]
  execution: ExecutionItem[]
  /** Virtual USDT for a never-configured Paper execution book; 0 leaves it to the owner. */
  paperExecutionUsdt: number
  options: { demo: boolean; execution: boolean }
}
export type PlannedDecision = AutopilotDecision & {
  /** Subject of a failure line. */
  name?: string
  exchange?: TradingExchange
  track?: ExecutionTrack
  mode?: 'paper' | 'demo'
}

const modeName = { paper: 'Тренировка', demo: 'Demo', live: 'Live' } as const
const trackName: Record<ExecutionTrack, string> = {
  arbitrage: 'Арбитраж',
  funding: 'Фандинг',
  defi: 'DeFi',
  prediction: 'Прогнозы',
}
const exchangeName: Record<TradingExchange, string> = {
  okx: 'OKX',
  bybit: 'Bybit',
  binance: 'Binance',
  bitget: 'Bitget',
}
const stopTexts: Record<string, string> = {
  OWNER_PAUSE: 'вы поставили на паузу',
  OWNER_STOP: 'вы остановили',
  OWNER_EXIT: 'вы закрыли позиции',
  DAILY_LOSS_LIMIT: 'сработал дневной лимит убытка',
  DRAWDOWN_LIMIT: 'сработал лимит просадки',
  DEMO_PROBE_COMPLETE: 'пробная сделка завершена',
  TRADING_ORDER_UNKNOWN: 'неясный ордер, нужна проверка на бирже',
  TRADING_ORDER_REJECTED: 'биржа отклонила ордер, нужна проверка',
  EXECUTION_PAUSED: 'вы поставили на паузу',
  EXECUTION_DRAWDOWN_STOP: 'сработал лимит просадки',
  EXECUTION_DAILY_LOSS_STOP: 'сработал дневной лимит убытка',
  EXECUTION_INVENTORY_LOSS_STOP: 'сработал лимит убытка по запасу',
  EXECUTION_FILL_BUDGET_EXCEEDED: 'исполнение вышло за бюджет, нужна проверка',
}
const blockerTexts: Record<string, string> = {
  EXECUTION_CREDENTIALS_REQUIRED: 'нет отдельных ключей Demo для этого направления',
  EXECUTION_WALLET_REQUIRED: 'нет настроек тестового кошелька Aave',
  EXECUTION_ASSET_REGISTRY_REQUIRED: 'не заполнен реестр проверенных монет арбитража',
  EXECUTION_LIVE_DISABLED: 'Live выключен',
  MANAGER_MODEL_TOO_EXPENSIVE: 'запрос модели не помещается в резерв менеджера',
  MANAGER_COST_REVIEW: 'нужна проверка неясного платного вызова',
  EXECUTION_CONFIG_INVALID: 'настройки направления на сервере заполнены неверно',
  EXECUTION_WALLET_CONFIG_INVALID: 'настройки тестового кошелька заполнены неверно',
  EXECUTION_ACCOUNT_INVALID: 'площадка не подтвердила счёт',
  EXECUTION_ACCOUNT_ALREADY_USED: 'этот счёт уже привязан к другому направлению',
  EXECUTION_CONNECTION_FAILED: 'площадка не ответила',
  EXECUTION_BUSY: 'направления заняты другой операцией',
  TRADING_CREDENTIALS_REQUIRED: 'нет ключей',
  TRADING_STALE_MARKET: 'биржа не отдала свежие цены',
  TRADING_CATALOG_INVALID: 'не удалось получить список монет',
  TRADING_NO_CANDIDATES: 'нет подходящих монет',
  TRADING_BUSY: 'биржа занята другой операцией',
  TRADING_RESPONSE_INVALID: 'биржа ответила непонятно',
  TRADING_DAILY_LOCKED: 'сегодня уже сработал дневной лимит убытка',
  TRADING_DRAWDOWN_LOCKED: 'сработал лимит просадки',
  SCHEDULE_DISABLED_ON_SERVER: 'расписание запрещено на сервере',
}
const stopText = (status: string, reason: string) =>
  stopTexts[reason] ??
  (status === 'attention'
    ? 'нужна сверка операций'
    : reason
      ? 'остановлено, причина в кабинете'
      : status === 'paused'
        ? 'на паузе'
        : 'остановлено')

/** Pure: state in, decisions out. Live items only ever produce a "not touched" line. */
export function autopilotPlan(input: AutopilotInput): PlannedDecision[] {
  const out: PlannedDecision[] = []
  const none = (key: string, status: AutopilotDecision['status'], text: string, code?: string) =>
    out.push({ key, action: 'none', status, text, ...(code ? { code } : {}) })
  if (input.systemMode !== 'running') {
    none(
      'farm',
      'blocked',
      input.systemMode === 'paused'
        ? 'Ферма на паузе. Автопилот ничего не включает, пока вы не нажмёте «Продолжить».'
        : 'Аварийный стоп. Автопилот ничего не включает; снять стоп можете только вы.',
    )
    return out
  }
  none('farm', 'running', 'Ферма работает.')

  if (!input.autonomyEnabled)
    none(
      'schedule',
      'blocked',
      'Расписание запрещено в настройках сервера.',
      'AUTONOMY_ENABLED_FALSE',
    )
  else if (input.scheduleEnabled)
    none('schedule', 'running', 'Расписание разведки, отчётов и отбора включено.')
  else if (input.scheduleOwnerOff)
    none('schedule', 'blocked', 'Расписание выключили вы. Автопилот его не включает.')
  else
    out.push({
      key: 'schedule',
      action: 'enable_schedule',
      status: 'started',
      text: 'Автопилот включил расписание разведки, отчётов и отбора.',
      name: 'Расписание',
    })
  if (input.workspaceMode !== 'studio')
    none(
      'studio',
      'blocked',
      'Разведка идей не идёт: в настройках сервера включена только торговля.',
      'WORKSPACE_MODE_TRADING',
    )

  const blocker = input.manager.blocker
    ? ` Разборы ждут: ${blockerTexts[input.manager.blocker] ?? 'нужна проверка в кабинете менеджера'}.`
    : ''
  if (input.manager.enabled)
    none('manager', 'running', `Торговый менеджер включён.${blocker}`, input.manager.blocker)
  else if (input.manager.ownerOff)
    none('manager', 'blocked', 'Торгового менеджера выключили вы. Автопилот его не включает.')
  else
    out.push({
      key: 'manager',
      action: 'enable_manager',
      status: 'started',
      text: `Автопилот включил торгового менеджера.${blocker}`,
      name: 'Торговый менеджер',
    })

  for (const t of input.trading) {
    const key = `trading:${t.exchange}:${t.mode}`
    const name = `${modeName[t.mode]} ${exchangeName[t.exchange]}`
    if (t.mode === 'live') continue
    if (t.mode === 'demo' && !input.options.demo) continue
    if (t.status === 'running') none(key, 'running', `${name}: работает.`)
    else if (t.status !== 'idle')
      none(
        key,
        'blocked',
        `${name}: ${stopText(t.status, t.reason)}. Автопилот это не снимает.`,
        t.reason,
      )
    else if (!t.hasKeys)
      none(
        key,
        'blocked',
        `${name}: нет ключей Demo в настройках сервера.`,
        'TRADING_CREDENTIALS_REQUIRED',
      )
    else
      out.push({
        key,
        action: 'start_trading',
        status: 'started',
        text: `${name}: запущена автопилотом.`,
        name,
        exchange: t.exchange,
        mode: t.mode,
      })
  }

  if (input.options.execution)
    for (const e of input.execution) {
      if (e.mode === 'live') continue
      const key = `execution:${e.track}:${e.mode}`
      const name = `${trackName[e.track]}, ${modeName[e.mode].toLowerCase()}`
      const item = { name, track: e.track, mode: e.mode }
      if (e.status === 'running') none(key, 'running', `${name}: работает.`)
      else if (e.status !== 'idle' || e.started)
        none(
          key,
          'blocked',
          `${name}: ${stopText(e.status, e.reason)}. Автопилот это не снимает.`,
          e.reason,
        )
      else if (e.ready)
        none(
          key,
          'blocked',
          `${name}: ${blockerTexts[e.ready] ?? 'нужна настройка на сервере'}.`,
          e.ready,
        )
      else if (e.capitalOk)
        out.push({
          key,
          action: 'start_execution',
          status: 'started',
          text: `${name}: запущено автопилотом.`,
          ...item,
        })
      else if (e.mode === 'paper' && e.track !== 'prediction' && input.paperExecutionUsdt > 0)
        out.push({
          key,
          action: 'configure_execution',
          status: 'started',
          text: `${name}: автопилот выделил ${input.paperExecutionUsdt} виртуальных USDT и запустил.`,
          ...item,
        })
      else
        none(
          key,
          'blocked',
          e.track === 'prediction'
            ? `${name}: нужны код события Kalshi, ваша оценка вероятности и сумма.`
            : `${name}: сумму задаёте вы в кабинете «Направления».`,
        )
    }

  none('live', 'blocked', 'Live автопилот не включает: это делаете только вы после приёмки Demo.')
  return out
}

async function latestAudit(kind: string) {
  const [row] = await query(
    'SELECT data FROM audit_events WHERE kind=$1 ORDER BY id DESC LIMIT 1',
    [kind],
  )
  return (row?.data ?? null) as Record<string, unknown> | null
}

export async function autopilotInput(
  options = { demo: true, execution: true },
): Promise<AutopilotInput> {
  const c = config()
  await ensurePortfolios()
  await ensureExecution()
  await query('INSERT INTO trading_manager(id) VALUES(true) ON CONFLICT DO NOTHING')
  const [system] = await query('SELECT mode,schedule_enabled FROM system_state WHERE id=true')
  const [manager] = await query('SELECT enabled FROM trading_manager WHERE id=true')
  const schedule = await latestAudit('schedule_changed')
  const managerControl = await latestAudit('trading_manager_control')
  const budget = await managerBudget()
  const trading = await query<Omit<TradingItem, 'hasKeys'>>(
    'SELECT exchange,mode,status,reason FROM trading_portfolios ORDER BY exchange,mode',
  )
  const execution = await query(
    'SELECT track,mode,status,reason,capital,started_at FROM execution_portfolios ORDER BY track,mode',
  )
  return {
    systemMode: system?.mode ?? 'emergency_stop',
    autonomyEnabled: c.AUTONOMY_ENABLED,
    workspaceMode: c.WORKSPACE_MODE,
    scheduleEnabled: !!system?.schedule_enabled,
    scheduleOwnerOff: schedule?.enabled === false,
    manager: {
      enabled: !!manager?.enabled,
      ownerOff: managerControl?.action === 'pause',
      blocker: budget.uncertain ? 'MANAGER_COST_REVIEW' : managerModelBlocker(),
    },
    trading: trading
      .filter((t) => (exchanges as readonly string[]).includes(t.exchange))
      .map((t) => ({
        exchange: t.exchange,
        mode: t.mode,
        status: t.status,
        reason: t.reason,
        hasKeys: t.mode === 'live' ? false : hasKeys(scope(t.exchange, t.mode)),
      })),
    execution: execution
      .filter((e) => (executionTracks as readonly string[]).includes(e.track))
      .map((e) => ({
        track: e.track,
        mode: e.mode,
        status: e.status,
        reason: e.reason,
        started: !!e.started_at,
        capitalOk: units(String(e.capital)) >= units(EXECUTION_POLICY.minCapital),
        ready: e.mode === 'live' ? 'EXECUTION_LIVE_DISABLED' : executionReady(e.track, e.mode),
      })),
    paperExecutionUsdt: c.AUTOPILOT_EXECUTION_PAPER_USDT,
    options,
  }
}

/** Runs one decision through the office function. Failures become a blocked line, not a throw. */
/** The worker's own tick may hold the lane for a moment: retry briefly instead of failing. */
async function whenFree<T>(busy: string, fn: () => Promise<T>) {
  for (let attempt = 1; ; attempt++)
    try {
      return await fn()
    } catch (error) {
      if (!(error instanceof Error && error.message === busy) || attempt >= 5) throw error
      await pause(3000)
    }
}

/** A pause or stop pressed while the pass runs wins over the plan made a moment earlier. */
async function farmRunning() {
  const [system] = await query('SELECT mode FROM system_state WHERE id=true')
  return system?.mode === 'running'
}

async function apply(d: PlannedDecision, deps: AutopilotDeps): Promise<AutopilotDecision> {
  const decision = strip(d)
  if (!(await farmRunning()))
    return {
      ...decision,
      status: 'blocked',
      code: 'AUTOPILOT_FARM_NOT_RUNNING',
      text: `${d.name ?? d.key}: не запущено, ферма на паузе или остановлена.`,
    }
  try {
    if (d.action === 'enable_schedule') await setSchedule(true, 'autopilot')
    else if (d.action === 'enable_manager') await controlManager('enable', 'autopilot')
    else if (d.action === 'start_trading') {
      if (d.mode !== 'paper' && d.mode !== 'demo') throw new Error('AUTOPILOT_MODE_FORBIDDEN')
      const s = scope(d.exchange!, d.mode)
      await whenFree('TRADING_BUSY', () => startTrading(s, '', false, deps.trading))
    } else if (d.action === 'configure_execution' || d.action === 'start_execution') {
      if (d.mode !== 'paper' && d.mode !== 'demo') throw new Error('AUTOPILOT_MODE_FORBIDDEN')
      if (d.action === 'configure_execution') {
        if (d.mode !== 'paper') throw new Error('AUTOPILOT_MODE_FORBIDDEN')
        const allocation = {
          track: d.track,
          mode: 'paper',
          capital: String(config().AUTOPILOT_EXECUTION_PAPER_USDT),
          settings: defaultExecutionSettings,
        }
        await whenFree('EXECUTION_BUSY', () => configureExecution(allocation))
      }
      const mode = d.mode
      await whenFree('EXECUTION_BUSY', () =>
        controlExecution(d.track!, mode, 'start', deps.execution),
      )
    }
    return decision
  } catch (error) {
    const code =
      d.action === 'start_trading'
        ? safeTradingError(error)
        : d.action.endsWith('_execution')
          ? safeExecutionError(error)
          : error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
            ? error.message
            : 'AUTOPILOT_ACTION_FAILED'
    return {
      ...decision,
      status: 'failed',
      code,
      text: `${d.name ?? d.key}: не запустилось (${blockerTexts[code] ?? 'техническая ошибка'}). Повторю при следующей проверке.`,
    }
  }
}

/**
 * One autopilot pass: read the state, decide, act and record. Only decisions that changed since
 * the previous pass go to the activity feed, so a repeating blocker does not flood it.
 */
export type AutopilotDeps = { trading?: VenueFactory; execution?: ExecutionFactory }
export async function runAutopilot(
  options = { demo: true, execution: true },
  deps: AutopilotDeps = {},
) {
  const plan = autopilotPlan(await autopilotInput(options))
  const decisions: AutopilotDecision[] = []
  for (const d of plan) decisions.push(d.action === 'none' ? strip(d) : await apply(d, deps))
  await transaction(async (db) => {
    const [previous] = await query(
      'SELECT decisions FROM autopilot_state WHERE id=true FOR UPDATE',
      [],
      db,
    )
    const before = new Map(
      ((previous?.decisions ?? []) as AutopilotDecision[]).map((d) => [d.key, d.text]),
    )
    for (const d of decisions)
      // Lines that only confirm a running loop stay out of the feed.
      if (d.status !== 'running' && before.get(d.key) !== d.text)
        await audit(
          'autopilot_decision',
          d.text,
          { key: d.key, status: d.status, code: d.code },
          db,
        )
    await query(
      `INSERT INTO autopilot_state(id,checked_at,decisions) VALUES(true,now(),$1)
       ON CONFLICT(id) DO UPDATE SET checked_at=now(),decisions=$1`,
      [JSON.stringify(decisions)],
      db,
    )
  })
  return decisions
}
const strip = (d: PlannedDecision): AutopilotDecision => ({
  key: d.key,
  action: d.action,
  status: d.status,
  text: d.text,
  ...(d.code ? { code: d.code } : {}),
})

/** Office and check-script view: the last pass, loop heartbeats and budget pacing. */
export async function autonomyView(now = new Date()): Promise<AutonomyView> {
  const c = config()
  const [state] = await query('SELECT checked_at,decisions FROM autopilot_state WHERE id=true')
  const [budget, numbers, loops] = await Promise.all([
    budgetSummary(),
    pacingNumbers(),
    workerLoops(now),
  ])
  const pace = pacingDecision({
    ...numbers,
    category: 'scout',
    limit: 0,
    dailyKopecks: c.DAILY_BUDGET_KOPECKS,
    now,
  })
  return {
    autopilotEnabled: c.AUTOPILOT_ON_BOOT,
    intervalMinutes: Math.round(c.AUTOPILOT_INTERVAL_MS / 60_000),
    checkedAt: state?.checked_at ? new Date(state.checked_at).toISOString() : null,
    decisions: (state?.decisions ?? []) as AutopilotDecision[],
    loops,
    pacing: {
      enabled: c.PACING_ENABLED,
      dailyKopecks: c.DAILY_BUDGET_KOPECKS,
      daySpentKopecks: budget.daySpent,
      outstandingKopecks: budget.outstanding,
      hourlyAllowanceKopecks: pace.allowanceKopecks,
      usedThisHourKopecks: numbers.usedThisHour,
      managerFloorKopecks: numbers.managerFloor,
    },
  }
}
