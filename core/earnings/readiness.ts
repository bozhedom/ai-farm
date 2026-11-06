import { workFocus, workAllowed } from '../work-focus'
import type { WorkDirection } from '../contracts/work-focus'
import { config } from '../config'
import { budgetSummary } from '../budget'
import { EARNINGS_POLICY } from '../policy'
import { COMPUTER_USE_POLICY } from '../computer-use/policy'
import { query } from '../db'
import { exchanges } from '../trading/types'
import { hasKeys } from '../trading/wire'
import { executionTracks } from '../execution/types'
import { executionReady } from '../execution/config'

export type DirectionStatus =
  | 'работает'
  | 'подключено'
  | 'на паузе'
  | 'тестовый режим'
  | 'требует подключения'
  | 'не используется'
export type DirectionReadiness = {
  id: string
  title: string
  status: DirectionStatus
  active: boolean
  group: 'real' | 'test' | 'other'
  activity: string
  detail: string
  link: string
}
export async function directionReadiness(): Promise<DirectionReadiness[]> {
  const c = config()
  const [[state], portfolios, execution, [computer], [manager], classic, [monitor], budget] =
    await Promise.all([
      query(
        'SELECT mode,worker_heartbeat,schedule_enabled,research_enabled FROM system_state WHERE id=true',
      ),
      query('SELECT exchange,mode,status,checked_at,check_error,reason FROM trading_portfolios'),
      query('SELECT track,mode,status FROM execution_portfolios'),
      query('SELECT enabled,failures,last_error FROM computer_use WHERE id=true'),
      query('SELECT enabled,last_error FROM trading_manager WHERE id=true'),
      query(
        "SELECT DISTINCT exchange FROM trading_agents WHERE mode='paper' AND status='active' AND kind IN ('grid','dca')",
      ),
      query('SELECT enabled,finished_at,error FROM earnings_monitor WHERE id=true'),
      budgetSummary(),
    ])
  const alive =
    !!state?.worker_heartbeat && Date.now() - new Date(state.worker_heartbeat).getTime() < 90000
  const farm = alive && state?.mode === 'running'
  const moneyBlocked =
    budget.daySpent + budget.outstanding >= budget.dailyLimit ||
    budget.monthSpent + budget.outstanding >= budget.monthlyLimit ||
    (c.MODEL_PROVIDER === 'openai' && budget.openaiSpentMicrousd >= c.OPENAI_TOTAL_BUDGET_MICROUSD)
  const blocker = (code: string) => {
    if (/BUDGET|DAILY_LIMIT/.test(code)) return 'Ожидает бюджета или обновления лимита'
    if (/SKIP|NO_PAPER/.test(code)) return 'Нет подходящего Paper-эксперимента'
    if (code) return 'Остановлено: требуется проверка'
    return ''
  }
  const computerBlock =
    blocker(computer?.last_error || '') || (moneyBlocked ? 'Ожидает бюджета' : '')
  const managerBlock = blocker(manager?.last_error || '') || (moneyBlocked ? 'Ожидает бюджета' : '')
  const monitorFresh =
    !!monitor?.finished_at &&
    Date.now() - new Date(monitor.finished_at).getTime() <
      EARNINGS_POLICY.intervalMs * 2 + EARNINGS_POLICY.leaseMs
  const result: DirectionReadiness[] = exchanges.map((exchange) => {
    const live = portfolios.find((p) => p.exchange === exchange && p.mode === 'live')
    const paper = portfolios.find((p) => p.exchange === exchange && p.mode === 'paper')
    const keys = hasKeys({ exchange, mode: 'live' })
    const checked = keys && !!live?.checked_at && !live.check_error
    const active = alive && checked && c.TRADING_LIVE_ENABLED && live?.status === 'running'
    return {
      id: `spot-${exchange}`,
      title: `Спот · ${exchange.toUpperCase()}`,
      status: active
        ? 'работает'
        : checked
          ? 'подключено'
          : keys
            ? 'не используется'
            : 'требует подключения',
      active,
      group: checked ? 'real' : 'other',
      activity: active
        ? 'Live · торговля включена'
        : checked
          ? 'Live · новые покупки не запущены'
          : 'Live не подключён',
      detail: `${checked ? 'Торговое подключение проверено.' : keys ? 'Ключ внесён, успешная проверка ещё нужна.' : 'Приватный торговый API не подключён.'} ${active ? 'Live запущен.' : 'Реальные сделки не выполняются.'} Paper: ${paper?.status === 'running' && alive ? 'активен' : 'не активен'}.`,
      link: '/office/trading',
    }
  })
  result.push({
    id: 'bots',
    title: 'Сетка и DCA',
    group: 'test',
    activity: 'Только Paper · виртуальные средства',
    status: 'тестовый режим',
    active:
      alive &&
      portfolios.some(
        (p) =>
          p.mode === 'paper' &&
          p.status === 'running' &&
          classic.some((a) => a.exchange === p.exchange),
      ),
    detail: 'Реализованы только на виртуальных средствах. Live для этих стратегий недоступен.',
    link: '/office/trading',
  })
  const titles = {
    arbitrage: 'Арбитраж',
    funding: 'Фандинг Bybit',
    defi: 'DeFi · Aave',
    prediction: 'Прогнозы · Kalshi',
  }
  for (const track of executionTracks) {
    const live = execution.find((p) => p.track === track && p.mode === 'live')
    const paper = execution.find((p) => p.track === track && p.mode === 'paper')
    const demo = execution.find((p) => p.track === track && p.mode === 'demo')
    const liveOn = alive && live?.status === 'running' && !executionReady(track, 'live')
    const testOn =
      alive &&
      (paper?.status === 'running' ||
        (demo?.status === 'running' && !executionReady(track, 'demo')))
    result.push({
      id: track,
      title: titles[track],
      status: liveOn ? 'работает' : testOn ? 'тестовый режим' : 'требует подключения',
      active: liveOn || testOn,
      group: liveOn ? 'real' : paper || demo ? 'test' : 'other',
      activity: liveOn
        ? 'Live · операции включены'
        : testOn
          ? paper?.status === 'running'
            ? 'Paper · симуляция'
            : 'Demo · тестовый счёт'
          : 'Реальные операции не подключены',
      detail: liveOn
        ? 'Live включён владельцем. Результаты смотрите в журнале операций.'
        : `${testOn ? 'Активна тренировка на виртуальных средствах.' : 'Операции не запущены.'} Реальные операции требуют отдельных счетов, средств, проверки и разрешения владельца.`,
      link: `/office/earnings?track=${track === 'funding' || track === 'defi' ? 'yield' : track}`,
    })
  }
  result.push(
    {
      group: 'real',
      activity:
        alive && monitor?.enabled && monitorFresh && !monitor?.error
          ? 'Публичные данные · без сделок'
          : 'Обновление не подтверждено',
      id: 'monitor',
      title: 'Публичный мониторинг',
      status:
        alive && monitor?.enabled && monitorFresh && !monitor?.error ? 'работает' : 'на паузе',
      active: alive && !!monitor?.enabled && monitorFresh && !monitor?.error,
      detail:
        'Чтение публичных цен, фандинга и данных рынков. Монитор не отправляет заявки и не управляет средствами.',
      link: '/office/earnings?track=arbitrage',
    },
    {
      group: 'other',
      activity: 'Торговля не реализована',
      id: 'polymarket',
      title: 'Polymarket',
      status: 'не используется',
      active: false,
      detail: 'Есть только публичные данные рынка. Адаптера покупки контрактов нет.',
      link: '/office/earnings?track=prediction',
    },
    {
      group: 'other',
      activity: moneyBlocked ? 'Ожидает бюджета' : 'По расписанию · модельные исследования',
      id: 'ideas',
      title: 'Идеи и продукты',
      status: c.MODEL_PROVIDER === 'demo' ? 'тестовый режим' : 'подключено',
      active:
        farm &&
        !moneyBlocked &&
        c.AUTONOMY_ENABLED &&
        !!state?.schedule_enabled &&
        !!state?.research_enabled,
      detail:
        'Исследование, критика и сборка текстовых услуг. Оценка идеи не означает продажу. Расписание и бюджет — в настройках.',
      link: '/office/farm',
    },
    {
      group: 'other',
      activity: computerBlock || 'Браузерные задания · по расписанию',
      id: 'computer',
      title: 'Фриланс через браузер',
      status: c.COMPUTER_USE_ENABLED && c.VM_AGENT_URL ? 'подключено' : 'требует подключения',
      active:
        farm &&
        !computerBlock &&
        c.COMPUTER_USE_ENABLED &&
        !!c.VM_AGENT_URL &&
        !!computer?.enabled &&
        computer.failures < COMPUTER_USE_POLICY.maxFailuresInRow &&
        ![
          'BUDGET_BLOCKED',
          'OPENAI_BUDGET_BLOCKED',
          'COMPUTER_USE_DAILY_LIMIT',
          'COMPUTER_USE_VM_UNAVAILABLE',
        ].includes(computer.last_error),
      detail:
        'Поиск и отклики доступны на подключённых аккаунтах. Наличие отклика не означает выигранный заказ и оплату.' +
        (computer?.last_error
          ? ' Есть текущее ограничение: подробности в «Компьютере ИИ» и «Запуске».'
          : ''),
      link: '/office/computer',
    },
    {
      group: 'test',
      activity: managerBlock || 'Paper · разбор по расписанию',
      id: 'manager',
      title: 'Торговый менеджер',
      status: 'тестовый режим',
      active: farm && !!manager?.enabled && !managerBlock,
      detail: 'Предлагает только Paper-эксперименты. Контекст и модель настраиваются отдельно.',
      link: '/office/manager',
    },
    {
      group: 'test',
      activity: moneyBlocked ? 'Ожидает бюджета' : 'Sandbox / Sepolia · тестовые заказы',
      id: 'services',
      title: 'Заказы на сайте и API',
      status: 'тестовый режим',
      active: farm && !moneyBlocked,
      detail:
        'Генерация и проверка текста реализованы. Оплата sandbox / Sepolia; реальный платёжный провайдер не подключён.',
      link: '/office/products',
    },
  )
  const focus = await workFocus()
  return result.map((item) => {
    const direction: WorkDirection =
      item.id.startsWith('spot-') || item.id === 'bots'
        ? 'trading'
        : item.id === 'ideas'
          ? 'studio'
          : item.id === 'polymarket'
            ? 'monitor'
            : (item.id as WorkDirection)
    if (!alive) {
      item.active = false
      item.activity = 'Нет свежего сигнала обработчика'
      if (item.status === 'работает') item.status = 'на паузе'
    } else if (!item.active && item.activity.includes('по расписанию')) {
      item.activity = state?.mode !== 'running' ? 'Работа моделей приостановлена' : 'Не запущено'
    }
    if (workAllowed(focus, direction)) return item
    return {
      ...item,
      active: false,
      status: item.status === 'работает' ? 'на паузе' : item.status,
      activity: 'Новые запуски выключены фильтром',
      detail:
        item.detail
          .replace('Live запущен.', 'Live-портфель подключён; новые покупки запрещены фильтром.')
          .replace('Paper: активен.', 'Paper: новые входы выключены фильтром.')
          .replace(
            'Активна тренировка на виртуальных средствах.',
            'Paper-портфель сохранён; новые операции выключены фильтром.',
          ) + ' Обслуживание открытых позиций и принятых заказов продолжается.',
    }
  })
}
