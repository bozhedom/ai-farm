import { computerUseReady, config } from '../config'
import { query } from '../db'
import { officeOverview, publicUrl } from '../office'
import { serviceName } from '../service-names'
import { priceList } from '../storefront'
import { tradingOverview } from '../trading/overview'
import { exchangeCatalog } from '../trading/catalog'
import { decimal, units } from '../trading/decimal'
import { hasKeys } from '../trading/wire'
import { exchanges, type TradingExchange } from '../trading/types'
import { executionReady } from '../execution/config'
import { executionTracks, type ExecutionTrack } from '../execution/types'
import { managerView } from '../manager/view'
import { walletView } from '../wallet/view'
import type {
  IncomeCurrency,
  IncomeExchange,
  IncomeMode,
  IncomeNeed,
  IncomeSource,
  IncomeTradingRow,
  OfficeIncome,
} from '../contracts/overview'
import type { OfficeOverview } from '../contracts/office'
import {
  addExecution,
  dayKey,
  dayKeys,
  directionStatus,
  emptyBucket,
  headlineMode,
  periodTotals,
  replayTrades,
  totals,
  winStats,
  type DayBucket,
  type Fill,
} from './math'

/**
 * Owner income overview (`GET /api/office/income`): one read of existing tables, no external
 * calls. Real money (live results, paid non-test orders) and test results stay separate.
 */
const modes: IncomeMode[] = ['paper', 'demo', 'live']
const modeWord: Record<IncomeMode, string> = {
  paper: 'Тренировка',
  demo: 'Тест биржи',
  live: 'Реальные деньги',
}
const trackTitle: Record<ExecutionTrack, string> = {
  arbitrage: 'Арбитраж между биржами',
  funding: 'Фандинг: спот + фьючерс Bybit',
  defi: 'DeFi: USDC в Aave',
  prediction: 'Рынки прогнозов Kalshi',
}
const trackCurrency: Record<ExecutionTrack, IncomeCurrency> = {
  arbitrage: 'USDT',
  funding: 'USDT',
  defi: 'USDC',
  prediction: 'USD',
}
const managerWords: Record<string, string> = {
  MANAGER_WORKER_UNAVAILABLE: 'фоновый процесс не на связи',
  MANAGER_NO_PAPER: 'нет работающей тренировки на биржах',
  MANAGER_SYSTEM_PAUSED: 'ферма на паузе или остановлена',
  MANAGER_MODEL_UNAVAILABLE: 'модель недоступна',
  MANAGER_MODEL_TOO_EXPENSIVE: 'настроенная модель дороже лимита разбора',
  MANAGER_COST_REVIEW: 'есть вызов модели с неясной стоимостью',
  MANAGER_DAILY_LIMIT: 'разборы на сегодня исчерпаны',
  MANAGER_BUDGET_LIMIT: 'дневной бюджет менеджера исчерпан',
}
/** Blocks that only the owner can lift; daily limits pass by themselves. */
const managerHumanBlocks = new Set([
  'MANAGER_WORKER_UNAVAILABLE',
  'MANAGER_NO_PAPER',
  'MANAGER_SYSTEM_PAUSED',
  'MANAGER_MODEL_UNAVAILABLE',
  'MANAGER_MODEL_TOO_EXPENSIVE',
  'MANAGER_COST_REVIEW',
])

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null)
const latest = (...values: (string | null | undefined)[]) =>
  values
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null
const big = (value: unknown) => {
  try {
    return units(String(value ?? '0'))
  } catch {
    return 0n
  }
}
/** «12,40» from an exact decimal string, truncated to cents for a feed line. */
function money2(value: string) {
  const [whole, fraction = ''] = value.replace('-', '').split('.')
  const cents = fraction.padEnd(2, '0').slice(0, 2)
  return `${value.startsWith('-') ? '−' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${cents}`
}
const exchangeName = (e: string) => exchangeCatalog[e as TradingExchange]?.name ?? e.toUpperCase()

export async function officeIncome(now = new Date()): Promise<OfficeIncome> {
  const days = dayKeys(now)
  const since = `${days[0]}T00:00:00Z`
  const c = config()
  const [
    office,
    paperView,
    demoView,
    liveView,
    manager,
    portfolios,
    lifetime,
    fillRows,
    equityRows,
    orderDays,
    spendDays,
    spendCategories,
    [allTime],
    execution,
    executionDays,
    strategies,
    best,
    worst,
    [funnel],
    products,
    [scouts],
    monitor,
    computer,
    trades,
    managerRuns,
    executionOps,
    wallet,
  ] = await Promise.all([
    officeOverview(now),
    tradingOverview('paper'),
    tradingOverview('demo'),
    tradingOverview('live'),
    managerView(),
    query(
      'SELECT exchange,mode,status,reason,check_error,started_at,last_tick FROM trading_portfolios',
    ),
    query(
      `SELECT exchange,mode,coalesce(sum(realized),0)::text AS realized,
        coalesce(sum(round_trips),0)::int AS trips,max(last_order_at) AS last_order
       FROM trading_agents GROUP BY exchange,mode`,
    ),
    // Full fill history of agents that closed a trade in the window, so the replay starts flat.
    query(
      `SELECT o.agent_id,o.exchange,o.mode,o.side,o.filled_qty::text,o.quote::text,o.base_fee::text,
        o.quote_fee::text,coalesce(o.settled_at,o.created_at) AS at
       FROM trading_orders o
       WHERE o.filled_qty>0 AND o.status IN ('filled','canceled') AND o.agent_id IN (
         SELECT agent_id FROM trading_orders
         WHERE side='sell' AND filled_qty>0 AND coalesce(settled_at,created_at) >= $1)
       ORDER BY o.agent_id,o.created_at,o.id LIMIT 50000`,
      [since],
    ),
    // Last mark of every UTC day: one index lookup per portfolio and day.
    query(
      `SELECT p.exchange,p.mode,to_char(d.day,'YYYY-MM-DD') AS day,e.equity::text AS equity
       FROM trading_portfolios p
       CROSS JOIN generate_series($1::date,$2::date,interval '1 day') AS d(day)
       CROSS JOIN LATERAL (
         SELECT equity FROM trading_equity t
         WHERE t.exchange=p.exchange AND t.mode=p.mode
           AND t.at >= (d.day AT TIME ZONE 'UTC') AND t.at < ((d.day + interval '1 day') AT TIME ZONE 'UTC')
         ORDER BY t.at DESC LIMIT 1) e
       ORDER BY p.exchange,p.mode,d.day`,
      [days[0], days.at(-1)],
    ),
    query(
      `SELECT to_char(o.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
        coalesce(sum(o.revenue_kopecks),0)::int AS real,
        coalesce(sum(CASE WHEN o.is_test_payment THEN coalesce(nullif(o.price_kopecks,0),p.price_kopecks) ELSE 0 END),0)::int AS test
       FROM orders o JOIN products p ON p.id=o.product_id
       WHERE o.paid_at >= $1 GROUP BY 1`,
      [since],
    ),
    query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
        coalesce(sum(charged_kopecks),0)::int AS spent
       FROM tool_calls WHERE created_at >= $1 GROUP BY 1`,
      [since],
    ),
    query(
      `SELECT r.category,coalesce(sum(t.charged_kopecks),0)::int AS spent
       FROM tool_calls t JOIN budget_reservations r ON r.id=t.reservation_id
       WHERE t.created_at >= $1 GROUP BY 1 ORDER BY 2 DESC`,
      [since],
    ),
    query(
      `SELECT
        (SELECT coalesce(sum(revenue_kopecks),0)::int FROM orders) AS real,
        (SELECT coalesce(sum(coalesce(nullif(o.price_kopecks,0),p.price_kopecks)),0)::int
           FROM orders o JOIN products p ON p.id=o.product_id
           WHERE o.paid_at IS NOT NULL AND o.is_test_payment) AS test,
        (SELECT coalesce(sum(charged_kopecks),0)::int FROM tool_calls) AS spent`,
    ),
    query(
      `SELECT track,mode,status,capital::text,equity::text,realized::text,reason,heartbeat,
        last_scan,started_at FROM execution_portfolios`,
    ),
    query(
      `SELECT track,mode,to_char(closed_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,sum(pnl)::text AS pnl,
        count(*)::int AS n
       FROM execution_operations WHERE closed_at >= $1 GROUP BY 1,2,3`,
      [since],
    ),
    query(
      `SELECT exchange,mode,kind,count(*)::int AS n FROM trading_agents WHERE status='active'
       GROUP BY 1,2,3 ORDER BY 1,2,3`,
    ),
    query(
      `SELECT id,name,exchange,mode,kind,symbol,realized::text,round_trips,status FROM trading_agents
       WHERE round_trips>0 AND realized>0 ORDER BY realized DESC,id LIMIT 5`,
    ),
    query(
      `SELECT id,name,exchange,mode,kind,symbol,realized::text,round_trips,status FROM trading_agents
       WHERE round_trips>0 AND realized<0 ORDER BY realized ASC,id LIMIT 5`,
    ),
    query(
      `SELECT
        (SELECT count(*)::int FROM ideas) AS ideas,
        (SELECT count(*)::int FROM ideas WHERE status IN ('accepted','productized')) AS accepted,
        (SELECT count(*)::int FROM ideas WHERE status='productized') AS productized,
        (SELECT count(*)::int FROM orders) AS orders,
        (SELECT count(*)::int FROM orders WHERE status='delivered') AS delivered,
        (SELECT count(*)::int FROM orders WHERE paid_at IS NOT NULL AND NOT is_test_payment) AS paid_real`,
    ),
    query(
      `SELECT p.id,p.slug,p.template,p.spec->>'name' AS name,p.price_kopecks,
        (SELECT count(*)::int FROM orders o WHERE o.product_id=p.id) AS orders,
        (SELECT count(*)::int FROM orders o WHERE o.product_id=p.id AND o.status='delivered') AS delivered
       FROM products p
       WHERE p.status='sandbox' AND p.visibility='public' AND (NOT p.is_demo OR $1)
       ORDER BY p.price_kopecks,p.published_at DESC NULLS LAST,p.id LIMIT 40`,
      [c.MODEL_PROVIDER === 'demo'],
    ),
    query(
      `SELECT s.research_enabled,s.schedule_enabled,
        (SELECT count(*)::int FROM strategies WHERE status='active') AS agents,
        (SELECT count(*)::int FROM ideas WHERE created_at >= now()-interval '7 days') AS ideas_week,
        (SELECT count(*)::int FROM ideas WHERE created_at >= now()-interval '7 days'
           AND status IN ('accepted','productized')) AS accepted_week,
        (SELECT max(created_at) FROM ideas) AS last_idea,
        (SELECT max(first_seen_at) FROM opportunities) AS last_lead,
        (SELECT count(*)::int FROM service_requests) AS api_requests
       FROM system_state s WHERE s.id=true`,
    ),
    query('SELECT enabled,finished_at,error FROM earnings_monitor WHERE id=true'),
    query(
      `SELECT c.enabled,c.last_error,
        (SELECT count(*)::int FROM computer_use_tasks WHERE status='done') AS done,
        (SELECT count(*)::int FROM computer_use_approvals WHERE status='pending') AS approvals,
        (SELECT count(*)::int FROM computer_use_opportunities) AS found,
        (SELECT max(created_at) FROM computer_use_steps) AS last_step
       FROM computer_use c WHERE c.id=true`,
    ),
    query(
      `SELECT o.exchange,o.mode,o.side,o.symbol,o.filled_qty::text,o.quote::text,
        coalesce(o.settled_at,o.created_at) AS at
       FROM trading_orders o WHERE o.filled_qty>0 ORDER BY o.created_at DESC,o.id DESC LIMIT 15`,
    ),
    query(
      `SELECT status,plan->>'summary' AS summary,is_demo,created_at,finished_at,
        (SELECT count(*)::int FROM trading_manager_tasks t WHERE t.run_id=r.id) AS tasks
       FROM trading_manager_runs r ORDER BY created_at DESC LIMIT 5`,
    ),
    query(
      `SELECT track,mode,status,plan->>'symbol' AS symbol,pnl::text,created_at,closed_at
       FROM execution_operations ORDER BY coalesce(closed_at,created_at) DESC LIMIT 10`,
    ),
    walletView(now),
  ])

  // ---- money by UTC day ------------------------------------------------------------------
  const byDay = new Map<string, DayBucket>(days.map((d) => [d, emptyBucket()]))
  const bucket = (day: string) => byDay.get(day)
  for (const r of orderDays) {
    const b = bucket(r.day)
    if (b) {
      b.realKopecks += r.real
      b.testKopecks += r.test
    }
  }
  for (const r of spendDays) {
    const b = bucket(r.day)
    if (b) b.spendKopecks += r.spent
  }
  const fills: Fill[] = fillRows.map((r) => ({
    agentId: r.agent_id,
    exchange: r.exchange,
    mode: r.mode,
    side: r.side,
    filledQty: BigInt(r.filled_qty),
    quote: BigInt(r.quote),
    baseFee: BigInt(r.base_fee),
    quoteFee: BigInt(r.quote_fee),
    at: new Date(r.at),
  }))
  const closed = replayTrades(fills).filter((t) => t.at.getTime() >= Date.parse(since))
  for (const t of closed) {
    const b = bucket(dayKey(t.at))
    if (b && t.realized !== null) b.trading[t.mode] += t.realized
  }
  for (const r of executionDays) {
    const b = bucket(r.day)
    if (b) addExecution(b, r.mode, trackCurrency[r.track as ExecutionTrack], big(r.pnl))
  }

  // ---- all time ----------------------------------------------------------------------------
  const lifetimeBucket = emptyBucket()
  lifetimeBucket.realKopecks = allTime!.real
  lifetimeBucket.testKopecks = allTime!.test
  lifetimeBucket.spendKopecks = allTime!.spent
  for (const r of lifetime) lifetimeBucket.trading[r.mode as IncomeMode] += BigInt(r.realized)
  for (const r of execution)
    addExecution(lifetimeBucket, r.mode, trackCurrency[r.track as ExecutionTrack], big(r.realized))

  // ---- trading rows -----------------------------------------------------------------------
  const views = { paper: paperView, demo: demoView, live: liveView }
  const tradingRows: IncomeTradingRow[] = []
  for (const exchange of exchanges)
    for (const mode of modes) {
      const conn = views[mode].connections.find((x) => x.exchange === exchange)!
      const life = lifetime.find((r) => r.exchange === exchange && r.mode === mode)
      const own = closed.filter((t) => t.exchange === exchange && t.mode === mode)
      const stats = winStats(own)
      const portfolio = portfolios.find((p) => p.exchange === exchange && p.mode === mode)
      tradingRows.push({
        exchange,
        mode,
        status: conn.status as IncomeTradingRow['status'],
        keys: conn.keys,
        workerAlive: conn.workerAlive,
        capital: conn.capital,
        equity: conn.equity,
        pnl: conn.pnl,
        realized: decimal(BigInt(life?.realized ?? '0')),
        activeAgents: conn.activeAgents,
        trades30d: stats.trades,
        wins30d: stats.wins,
        lastAt: latest(iso(life?.last_order), iso(portfolio?.last_tick)),
      })
    }

  // ---- sources ----------------------------------------------------------------------------
  const sources: IncomeSource[] = []
  for (const exchange of exchanges) {
    const rows = tradingRows.filter((r) => r.exchange === exchange)
    const mode = headlineMode(
      rows.map((r) => ({
        mode: r.mode,
        status: r.status,
        started: !!portfolios.find((p) => p.exchange === exchange && p.mode === r.mode)?.started_at,
      })),
    )
    const row = rows.find((r) => r.mode === mode)!
    const p = portfolios.find((x) => x.exchange === exchange && x.mode === mode)
    const error = String(p?.check_error || p?.reason || '')
    const problem =
      row.status !== 'idle' && /LIMIT|STOP|LOSS|DRAWDOWN|UNKNOWN|CREDENTIAL|REVIEW/.test(error)
    const status = directionStatus({ status: row.status, workerAlive: row.workerAlive, problem })
    sources.push({
      id: `trading:${exchange}`,
      group: 'trading',
      title: `Спот ${exchangeName(exchange)}`,
      status,
      mode,
      result: {
        unit: 'USDT',
        value: row.pnl,
        label: mode === 'live' ? 'результат счёта' : 'результат, не выручка',
        test: mode !== 'live',
      },
      detail:
        status === 'disabled'
          ? `${modeWord[mode]}: не запущено.`
          : `${modeWord[mode]}: агентов ${row.activeAgents}, сделок за 30 дней ${row.trades30d}` +
            (row.trades30d ? `, в плюс ${row.wins30d}.` : '.') +
            (problem ? ` Остановлено: ${error}.` : ''),
      lastAt: row.lastAt,
      link: '/office/trading',
    })
  }
  const bots = strategies.filter((s) => s.kind === 'grid' || s.kind === 'dca')
  const botCount = bots.reduce((n, s) => n + s.n, 0)
  sources.push({
    id: 'bots',
    group: 'bots',
    title: 'Сетка и DCA',
    status: botCount ? 'paper_only' : 'disabled',
    mode: 'paper',
    result: { unit: 'count', value: String(botCount), label: 'агентов', test: true },
    detail: botCount
      ? `Только тренировка по правилам: ${bots.map((s) => `${exchangeName(s.exchange)} ${s.kind}`).join(', ')}.`
      : 'Не выбраны. Включаются набором «classic» в торговле.',
    lastAt: null,
    link: '/office/trading',
  })
  const m = manager.state
  const lastRun = manager.runs[0]
  const humanBlocks = m.blocked.filter((b) => managerHumanBlocks.has(b))
  sources.push({
    id: 'manager',
    group: 'manager',
    title: 'ИИ-менеджер торговли',
    status: !m.enabled ? 'disabled' : humanBlocks.length ? 'needs_human' : 'paper_only',
    mode: 'paper',
    result: {
      unit: 'count',
      value: String(manager.tasks.filter((t) => t.status === 'observing').length),
      label: 'экспериментов идёт',
      test: true,
    },
    detail: !m.enabled
      ? 'Выключен. Включите в разделе «Менеджер».'
      : m.blocked.length
        ? `Ждёт: ${m.blocked.map((b) => managerWords[b] ?? b).join(', ')}.`
        : m.thinking
          ? 'Сейчас разбирает результаты агентов.'
          : `Разбор раз в ${m.intervalHours} ч, сегодня ${m.runsToday} из ${m.maxDailyRuns}.`,
    lastAt: lastRun ? lastRun.finishedAt || lastRun.createdAt : null,
    link: '/office/manager',
  })
  for (const track of executionTracks) {
    const rows = execution.filter((r) => r.track === track)
    const mode = headlineMode(
      rows.map((r) => ({ mode: r.mode, status: r.status, started: !!r.started_at })),
    )
    const row = rows.find((r) => r.mode === mode)
    const alive = !!row?.heartbeat && now.getTime() - new Date(row.heartbeat).getTime() < 90_000
    const readiness = executionReady(track, mode)
    const problem =
      !!row && row.status !== 'idle' && (!!readiness || /STOP|LIMIT|ATTENTION/.test(row.reason))
    const status = row
      ? directionStatus({ status: row.status, workerAlive: alive, problem })
      : 'disabled'
    const ops = executionDays
      .filter((r) => r.track === track && r.mode === mode)
      .reduce((n, r) => n + r.n, 0)
    sources.push({
      id: `execution:${track}`,
      group: 'execution',
      title: trackTitle[track],
      status,
      mode,
      result: row
        ? {
            unit: trackCurrency[track],
            value: decimal(big(row.realized)),
            label: mode === 'live' ? 'зафиксировано' : 'зафиксировано, не выручка',
            test: mode !== 'live',
          }
        : null,
      detail:
        status === 'disabled'
          ? `${modeWord[mode]}: не запущено. Запуск в разделе «Направления».`
          : `${modeWord[mode]}: операций за 30 дней ${ops}.` +
            (problem ? ` Нужна проверка: ${readiness || row?.reason}.` : ''),
      lastAt: latest(iso(row?.last_scan), iso(row?.heartbeat)),
      link: '/office/earnings',
    })
  }
  const publicProducts = products.length
  const sellingMode = c.PAYMENT_MODE === 'sandbox' || c.PAYMENT_MODE === 'sepolia' ? 'test' : null
  sources.push({
    id: 'services',
    group: 'services',
    title: 'Текстовые услуги на сайте',
    status: office.mode !== 'running' ? 'needs_human' : publicProducts ? 'autonomous' : 'disabled',
    mode: sellingMode,
    result: {
      unit: 'RUB',
      value: String(allTime!.real),
      label: allTime!.real ? 'настоящих оплат' : 'настоящих оплат пока нет',
      test: false,
    },
    detail:
      `В продаже ${publicProducts}, заказов ${funnel!.orders}, выдано ${funnel!.delivered}. ` +
      `Оплата тестовая (${c.PAYMENT_MODE}); заказов через API ${scouts!.api_requests}.`,
    lastAt: office.feed.find((f) => /order|заказ|payment/i.test(f.kind))?.at ?? null,
    link: '/office/products',
  })
  sources.push({
    id: 'scouts',
    group: 'scouts',
    title: 'Разведчики идей и клиентов',
    status:
      office.mode !== 'running' || !office.worker.alive
        ? 'needs_human'
        : scouts!.research_enabled
          ? 'autonomous'
          : 'disabled',
    mode: null,
    result: {
      unit: 'count',
      value: String(scouts!.accepted_week),
      label: `принято идей за 7 дней из ${scouts!.ideas_week}`,
      test: false,
    },
    detail: `${scouts!.agents} разведчиков. ${office.worker.reason}`,
    lastAt: latest(iso(scouts!.last_idea), iso(scouts!.last_lead)),
    link: '/office/farm',
  })
  const mon = monitor[0]
  sources.push({
    id: 'markets',
    group: 'markets',
    title: 'Обзор рынков: фандинг, DeFi, прогнозы',
    status: !mon?.enabled ? 'disabled' : mon.error ? 'needs_human' : 'autonomous',
    mode: null,
    result: null,
    detail: !mon?.enabled
      ? 'Наблюдение выключено. Только чтение публичных данных, без сделок.'
      : mon.error
        ? `Последний обзор не получен: ${mon.error}.`
        : 'Собирает публичные ставки и цены. Права на сделки нет.',
    lastAt: iso(mon?.finished_at),
    link: '/office/earnings',
  })
  const cu = computer[0]
  const cuBlocker = computerUseReady(config())
  sources.push({
    id: 'computer',
    group: 'computer',
    title: 'Компьютер ИИ',
    status: cuBlocker
      ? 'disabled'
      : !cu?.enabled
        ? 'needs_human'
        : cu.approvals
          ? 'needs_human'
          : 'autonomous',
    mode: null,
    result: null,
    detail: cuBlocker
      ? 'Не подключён. Виртуальная машина для работы агента ещё не настроена.'
      : !cu?.enabled
        ? 'Готов, но выключен. Включите на странице раздела.'
        : `Заданий выполнено: ${cu.done}, найдено возможностей: ${cu.found}${cu.approvals ? `, ждут вашего решения: ${cu.approvals}` : ''}.`,
    lastAt: iso(cu?.last_step),
    link: '/office/computer',
  })

  const walletUsdt = wallet.periods.month.income.find((a) => a.coin === 'USDT')?.amount ?? '0'
  const walletWords: Record<string, string> = {
    not_configured: 'Не подключён: нет ключа Bybit только для чтения.',
    unchecked: 'Ключ задан, проверка при следующем цикле.',
    rejected: 'Ключ отклонён: у него есть права не только на чтение.',
    error: `Ключ не проверен: ${wallet.keyError || 'ошибка'}.`,
  }
  sources.push({
    id: 'wallet',
    group: 'wallet',
    title: 'Оплата криптой (Bybit)',
    status: ['not_configured', 'rejected', 'error'].includes(wallet.keyStatus)
      ? 'needs_human'
      : 'autonomous',
    mode: 'live',
    result: { unit: 'USDT', value: walletUsdt, label: 'доход за 30 дней', test: false },
    detail:
      walletWords[wallet.keyStatus] ??
      (wallet.syncError
        ? `Последняя сверка не удалась: ${wallet.syncError}.`
        : `Видит поступления сам. ${
            wallet.unclassifiedCount
              ? `Не разобрано: ${wallet.unclassifiedCount}.`
              : 'Неразобранных нет.'
          } Только для зарубежных клиентов.`),
    lastAt: wallet.lastSyncAt,
    link: '/office/money',
  })

  // ---- needs a person ----------------------------------------------------------------------
  const needs: IncomeNeed[] = []
  const add = (need: IncomeNeed) => needs.push(need)
  if (office.mode === 'emergency_stop')
    add({
      id: 'emergency-stop',
      title: 'Ферма остановлена',
      detail: 'Модельные задачи не идут. Нажмите «Продолжить» вверху, когда будете готовы.',
      link: '/office/settings',
      severity: 'block',
    })
  if (!office.worker.alive)
    add({
      id: 'worker',
      title: 'Фоновый процесс не отвечает',
      detail: 'Агенты не работают без воркера. Перезапустите сервис worker на сервере.',
      link: '/office/settings',
      severity: 'block',
    })
  const liveKeysMissing = exchanges.filter((e) => !hasKeys({ exchange: e, mode: 'live' }))
  const demoKeysMissing = exchanges.filter((e) => !hasKeys({ exchange: e, mode: 'demo' }))
  // Bybit is connected first; it gets its own explicit line.
  if (liveKeysMissing.includes('bybit'))
    add({
      id: 'keys:bybit',
      title: 'Bybit: нет ключей',
      detail:
        'Создайте API-ключ без вывода средств, только спот. Впишите BYBIT_LIVE_API_KEY и BYBIT_LIVE_SECRET ' +
        '(и BYBIT_DEMO_* для теста) в .env на сервере и перезапустите.',
      link: '/office/trading',
      severity: 'block',
    })
  const otherLive = liveKeysMissing.filter((e) => e !== 'bybit')
  if (otherLive.length)
    add({
      id: 'keys:live',
      title: `Нет ключей реальной торговли: ${otherLive.map(exchangeName).join(', ')}`,
      detail: 'Ключи вносятся только в .env на сервере. Без них работает тренировка.',
      link: '/office/trading',
      severity: 'warn',
    })
  if (demoKeysMissing.length === exchanges.length)
    add({
      id: 'keys:demo',
      title: 'Нет ни одного тестового счёта биржи',
      detail: 'Перед реальной торговлей нужна проверка на Demo. Добавьте *_DEMO_* ключи.',
      link: '/office/trading',
      severity: 'warn',
    })
  if (!c.TRADING_LIVE_ENABLED)
    add({
      id: 'live-disabled',
      title: 'Реальная торговля выключена',
      detail:
        'Включается владельцем: TRADING_LIVE_ENABLED=true в .env, затем бюджет и проверки в разделе биржи.',
      link: '/office/trading',
      severity: 'warn',
    })
  // Free OpenRouter models, or paid Astra over OpenRouter or the direct OpenAI key.
  const modelReady =
    c.MODEL_PROVIDER === 'openrouter'
      ? !!c.OPENROUTER_API_KEY
      : c.MODEL_PROVIDER === 'openai'
        ? c.OPENAI_TRANSPORT === 'openrouter'
          ? !!c.OPENROUTER_API_KEY
          : !!c.OPENAI_API_KEY
        : c.MODEL_PROVIDER !== 'demo'
  if (!modelReady)
    add({
      id: 'openrouter',
      title:
        c.MODEL_PROVIDER === 'demo'
          ? 'Модель не подключена: работает демо'
          : 'Ключ OpenRouter не задан',
      detail:
        'Для постоянной работы агентов задайте MODEL_PROVIDER=openai, OPENAI_TRANSPORT=openrouter и OPENROUTER_API_KEY в .env. ' +
        `Сейчас: ${c.MODEL_PROVIDER}.`,
      link: '/office/settings',
      severity: c.MODEL_PROVIDER === 'demo' ? 'block' : 'warn',
    })
  if (humanBlocks.length && m.enabled)
    add({
      id: 'manager',
      title: 'ИИ-менеджер ждёт вас',
      detail: humanBlocks.map((b) => managerWords[b] ?? b).join(', ') + '.',
      link: '/office/manager',
      severity: 'warn',
    })
  if (cuBlocker)
    add({
      id: 'computer',
      title: 'Компьютер ИИ не настроен',
      detail: 'Нужна отдельная виртуальная машина для агента. Без неё направление не работает.',
      link: '/office/computer',
      severity: 'warn',
    })
  else if (!cu?.enabled)
    add({
      id: 'computer',
      title: 'Компьютер ИИ выключен',
      detail: 'Машина подключена. Включите раздел, чтобы агент начал искать заработок в браузере.',
      link: '/office/computer',
      severity: 'warn',
    })
  else if (cu.approvals)
    add({
      id: 'computer',
      title: `Компьютер ИИ ждёт решения: ${cu.approvals}`,
      detail:
        'Оплата, вход, регистрация или публикация выполняются только после вашего разрешения.',
      link: '/office/computer',
      severity: 'warn',
    })
  if (wallet.keyStatus === 'not_configured')
    add({
      id: 'wallet-key',
      title: 'Bybit: нет ключа для чтения поступлений',
      detail:
        'Создайте ключ Bybit только для чтения (Read-Only, IP сервера) и впишите ' +
        'BYBIT_WALLET_READ_API_KEY и BYBIT_WALLET_READ_SECRET в .env на сервере.',
      link: '/office/money',
      severity: 'warn',
    })
  else if (wallet.keyStatus === 'rejected')
    add({
      id: 'wallet-key',
      title: 'Ключ кошелька Bybit отклонён',
      detail:
        'У ключа есть права на изменение. Удалите его на Bybit и создайте новый с правом Read-Only.',
      link: '/office/money',
      severity: 'block',
    })
  else if (wallet.keyStatus === 'error')
    add({
      id: 'wallet-key',
      title: 'Ключ кошелька Bybit не проверен',
      detail: `Bybit ответил: ${wallet.keyError || 'ошибка'}. Проверьте ключ, IP сервера и права чтения.`,
      link: '/office/money',
      severity: 'warn',
    })
  if (!wallet.address)
    add({
      id: 'wallet-address',
      title: 'Не задан адрес для оплаты USDT',
      detail:
        'Впишите PAYMENT_USDT_ADDRESS и PAYMENT_USDT_NETWORK (адрес депозита Bybit) в .env на сервере.',
      link: '/office/money',
      severity: 'warn',
    })
  if (wallet.unclassifiedCount)
    add({
      id: 'wallet-classify',
      title: `Поступления без отметки: ${wallet.unclassifiedCount}`,
      detail: 'Отметьте каждое: «доход» от клиента или «не доход» (перевод себе).',
      link: '/office/money',
      severity: 'warn',
    })
  // The worker line is already above with an instruction.
  for (const item of office.needsOwner.filter((n) => n.kind !== 'worker'))
    add({
      id: `office:${item.kind}`,
      title: item.text,
      detail:
        item.kind === 'ideas'
          ? 'Эти идеи ферма не исполнит сама: нужны договорённости или доступы человека.'
          : 'Откройте раздел и примите решение.',
      link: item.link,
      severity: item.kind === 'worker' ? 'block' : 'warn',
    })

  // ---- feed --------------------------------------------------------------------------------
  const feed: OfficeOverview['feed'] = [
    ...office.feed,
    ...trades.map((t) => ({
      at: new Date(t.at).toISOString(),
      kind: t.mode === 'live' ? 'trade' : 'trade_test',
      text: `${exchangeName(t.exchange)} · ${modeWord[t.mode as IncomeMode]}: ${t.side === 'buy' ? 'купил' : 'продал'} ${t.symbol.replace('-USDT', '')} на ${money2(decimal(BigInt(t.quote)))} USDT.`,
      link: '/office/trading',
    })),
    ...managerRuns.map((r) => ({
      at: new Date(r.finished_at || r.created_at).toISOString(),
      kind: r.status === 'failed' ? 'manager_failed' : 'manager',
      text:
        r.status === 'running'
          ? 'ИИ-менеджер разбирает результаты агентов.'
          : r.status === 'failed'
            ? 'ИИ-менеджер: разбор не удался.'
            : `ИИ-менеджер: ${r.summary || 'разбор завершён'}${r.tasks ? `. Экспериментов: ${r.tasks}.` : ''}`,
      link: '/office/manager',
    })),
    ...executionOps.map((o) => ({
      at: new Date(o.closed_at || o.created_at).toISOString(),
      kind: o.mode === 'live' ? 'execution' : 'execution_test',
      text: `${trackTitle[o.track as ExecutionTrack]} · ${modeWord[o.mode as IncomeMode]}: ${
        o.closed_at
          ? `закрыта операция ${o.symbol ?? ''}, итог ${money2(decimal(big(o.pnl)))} ${trackCurrency[o.track as ExecutionTrack]}.`
          : `открыта операция ${o.symbol ?? ''}.`
      }`,
      link: '/office/earnings',
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 40)

  // ---- analytics ---------------------------------------------------------------------------
  const series = new Map<string, OfficeIncome['equity'][number]>()
  for (const r of equityRows) {
    const key = `${r.exchange}:${r.mode}`
    if (!series.has(key)) series.set(key, { exchange: r.exchange, mode: r.mode, points: [] })
    series.get(key)!.points.push({ day: r.day, equity: decimal(BigInt(r.equity)) })
  }
  const rank = (r: Record<string, any>) => ({
    id: r.id,
    name: r.name,
    exchange: r.exchange as IncomeExchange,
    mode: r.mode as IncomeMode,
    kind: r.kind,
    symbol: r.symbol,
    realized: decimal(BigInt(r.realized)),
    roundTrips: r.round_trips,
    status: r.status,
  })

  return {
    generatedAt: now.toISOString(),
    mode: office.mode,
    workerAlive: office.worker.alive,
    periods: {
      today: periodTotals(byDay, now, 'today'),
      week: periodTotals(byDay, now, 'week'),
      month: periodTotals(byDay, now, 'month'),
    },
    allTime: totals([lifetimeBucket]),
    sources,
    trading: tradingRows,
    equity: [...series.values()],
    daily: days.map((day) => {
      const b = byDay.get(day)!
      return {
        day,
        realKopecks: b.realKopecks,
        testKopecks: b.testKopecks,
        spendKopecks: b.spendKopecks,
      }
    }),
    spendByCategory: spendCategories.map((r) => ({ category: r.category, kopecks: r.spent })),
    agents: { best: best.map(rank), worst: worst.map(rank) },
    funnel: {
      ideas: funnel!.ideas,
      accepted: funnel!.accepted,
      productized: funnel!.productized,
      publicProducts,
      orders: funnel!.orders,
      delivered: funnel!.delivered,
      paidReal: funnel!.paid_real,
    },
    products: products.map((p) => ({
      id: p.id,
      name: serviceName(p.template, p.name ?? p.template),
      priceKopecks: p.price_kopecks,
      orders: p.orders,
      delivered: p.delivered,
      publicUrl: publicUrl(p.slug),
    })),
    priceList: [...priceList],
    strategies: strategies.map((s) => ({
      exchange: s.exchange,
      mode: s.mode,
      kind: s.kind,
      count: s.n,
    })),
    feed,
    needsHuman: needs,
    wallet,
  }
}
