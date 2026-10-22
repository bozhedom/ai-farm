import { describe, expect, it } from 'vitest'
import {
  launchSteps,
  recommendedPlatforms,
  since,
  tradingWord,
  type LaunchInput,
} from '../../core/launch/steps'
import { defaultPlatformDomains } from '../../core/computer-use/platforms'

const now = new Date('2026-10-21T12:00:00Z')
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString()

/** The production server on 21.10: model and autopilot work, nothing else is connected. */
function production(overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    now,
    system: {
      mode: 'running',
      workerAlive: true,
      scheduleEnabled: true,
      autonomyAllowed: true,
      researchEnabled: true,
      autopilotOnBoot: true,
      workspaceMode: 'studio',
    },
    model: {
      provider: 'openai',
      configured: true,
      paid: true,
      readyNow: true,
      lastSuccessAt: minutesAgo(7),
      lastErrorCode: '',
      costAlert: false,
      dailyKopecks: 120_000,
      monthlyKopecks: 1_080_000,
      paidTotalMicrousd: 90_000_000,
      daySpentKopecks: 4_321,
      monthSpentKopecks: 54_321,
      paidSpentMicrousd: 1_234_567,
    },
    computer: {
      blocker: '',
      demo: false,
      enabled: true,
      failures: 3,
      maxFailures: 3,
      lastError: 'COMPUTER_USE_VM_UNAVAILABLE',
      lastStepAt: minutesAgo(90),
      lastDoneAt: minutesAgo(300),
      approvals: 0,
      autoProposalsAllowed: true,
      autoProposals: true,
      proposalsPerDay: 15,
      platforms: defaultPlatformDomains.map((domain) => ({ domain, loggedIn: false })),
      sentToday: 0,
      opportunities: 12,
      humanOpportunities: 12,
    },
    seller: {
      seller: false,
      contact: false,
      terms: false,
      paymentMode: 'sandbox',
      publicProducts: 3,
    },
    wallet: {
      address: false,
      network: '',
      keyStatus: 'not_configured',
      keyError: '',
      lastSyncAt: null,
      unclassified: 0,
      incomeDeposits: 0,
    },
    trading: {
      liveEnabled: false,
      minLiveUsdt: 20,
      bybit: {
        demoKeys: false,
        liveKeys: true,
        demo: { status: 'idle', checkError: '', checkedAt: null, roundTrips: false },
        live: {
          status: 'idle',
          checkError: 'TRADING_KEY_PERMISSIONS',
          reason: '',
          capitalOk: false,
          startedAt: null,
          checkedAt: '2026-10-20T11:00:00.000Z',
        },
        paper: { status: 'running', qualified: false },
      },
      otherLiveKeys: [],
    },
    manager: { enabled: true },
    execution: [
      {
        track: 'arbitrage',
        title: 'Арбитраж',
        demoReady: 'EXECUTION_ASSET_REGISTRY_REQUIRED',
        paperStatus: 'running',
      },
      {
        track: 'funding',
        title: 'Фандинг',
        demoReady: 'EXECUTION_CREDENTIALS_REQUIRED',
        paperStatus: 'running',
      },
    ],
    ...overrides,
  }
}
const byId = (view: ReturnType<typeof launchSteps>, id: string) =>
  view.groups.flatMap((g) => g.steps).find((s) => s.id === id)!

describe('launch checklist', () => {
  it('reads the production state: the halted browser agent is the next step, platforms follow', () => {
    const view = launchSteps(production())
    expect(view.groups.map((g) => g.id)).toEqual([
      'required',
      'freelance',
      'payments',
      'trading',
      'extra',
    ])
    for (const id of ['server', 'model', 'budgets', 'autopilot', 'computer-vm', 'auto-proposals'])
      expect([id, byId(view, id).status]).toEqual([id, 'done'])
    const halted = byId(view, 'computer-on')
    expect(halted.status).toBe('needed')
    expect(halted.state).toContain('3 сбоя подряд')
    expect(halted.state).toContain('Виртуальная машина не отвечает')
    expect(halted.actions.join(' ')).toContain('переключатель «Работа модели в браузере»')
    expect(halted.codes).toEqual(['COMPUTER_USE_VM_UNAVAILABLE'])
    expect(view.next?.id).toBe('computer-on')

    const platforms = byId(view, 'platforms')
    expect(platforms.status).toBe('needed')
    expect(platforms.state).toContain('Ни одной')
    expect(platforms.state).toContain('«нужен человек» 12')
    expect(platforms.actions.at(-1)).toBe(`Начните с: ${recommendedPlatforms.join(', ')}.`)
    expect(platforms.link).toBe('/office/computer#computer-manual')

    expect(byId(view, 'usdt-address').status).toBe('needed')
    expect(byId(view, 'wallet-key')).toMatchObject({ status: 'needed', state: 'Ключ не внесён.' })
    const key = byId(view, 'bybit-live-key')
    expect(key.status).toBe('needed')
    expect(key.state).toContain('отклонён')
    expect(key.state).toContain('только с правом Spot Trade')
    expect(key.codes).toEqual(['TRADING_KEY_PERMISSIONS'])
    expect(byId(view, 'bybit-demo')).toMatchObject({
      status: 'needed',
      state: 'Demo-ключ не внесён.',
    })
    const live = byId(view, 'live-trading')
    expect(live).toMatchObject({ status: 'blocked', required: false })
    expect(live.state).toContain('TRADING_LIVE_ENABLED=true')
    expect(live.state).toContain('проверка Demo')
    expect(byId(view, 'seller')).toMatchObject({ status: 'optional', required: false })
    expect(byId(view, 'manager').status).toBe('done')
    expect(byId(view, 'execution').state).toContain('Арбитраж, Фандинг')
    expect(byId(view, 'other-exchanges').status).toBe('optional')

    // Readiness counts required steps only.
    const required = view.groups.flatMap((g) => g.steps).filter((s) => s.required)
    expect(view.total).toBe(required.length)
    expect(view.done).toBe(required.filter((s) => s.status === 'done').length)
    expect(view.done).toBe(6)
    expect(view.total).toBe(12)
  })

  it('never carries a secret: the view is built from booleans, counts and codes only', () => {
    const text = JSON.stringify(launchSteps(production()))
    // Env variable names may appear in instructions; values never do.
    expect(text).not.toMatch(/sk-or-|password|пароль:|[0-9a-f]{40}/i)
  })

  it('blocks the freelance steps until the machine is configured and explains why', () => {
    const view = launchSteps(
      production({
        computer: {
          ...production().computer,
          blocker: 'COMPUTER_USE_VM_NOT_CONFIGURED',
          enabled: false,
          failures: 0,
          lastError: '',
        },
      }),
    )
    expect(byId(view, 'computer-vm')).toMatchObject({
      status: 'needed',
      state: 'Не настроена виртуальная машина: VM_AGENT_URL и VM_AGENT_TOKEN.',
      codes: ['COMPUTER_USE_VM_NOT_CONFIGURED'],
    })
    for (const id of ['computer-on', 'platforms', 'auto-proposals'])
      expect([id, byId(view, id).status]).toEqual([id, 'blocked'])
    expect(view.next?.id).toBe('computer-vm')
  })

  it('a stopped farm, a demo model or an unavailable model come first', () => {
    const stopped = launchSteps(
      production({ system: { ...production().system, mode: 'emergency_stop' } }),
    )
    expect(stopped.next?.id).toBe('server')
    expect(byId(stopped, 'server').actions[0]).toContain('«Продолжить»')

    const demo = launchSteps(
      production({
        model: { ...production().model, provider: 'demo', configured: false, paid: false },
      }),
    )
    expect(byId(demo, 'model')).toMatchObject({ status: 'needed' })
    expect(byId(demo, 'model').state).toContain('демо-режим')
    expect(demo.next?.id).toBe('model')

    const down = launchSteps(
      production({
        model: { ...production().model, readyNow: false, lastErrorCode: 'OPENROUTER_HTTP_402' },
      }),
    )
    expect(byId(down, 'model').status).toBe('needed')
    expect(byId(down, 'model').state).toContain('OPENROUTER_HTTP_402')
    expect(byId(down, 'model').state).toContain('7 мин назад')
  })

  it('marks the freelance path done once a platform is logged in and sending is allowed', () => {
    const base = production()
    const view = launchSteps(
      production({
        computer: {
          ...base.computer,
          failures: 0,
          lastError: '',
          platforms: base.computer.platforms.map((p) => ({
            ...p,
            loggedIn: p.domain === 'kwork.ru' || p.domain === 'fl.ru',
          })),
          sentToday: 4,
          approvals: 2,
        },
      }),
    )
    expect(byId(view, 'computer-on').status).toBe('done')
    expect(byId(view, 'platforms')).toMatchObject({ status: 'done' })
    expect(byId(view, 'platforms').state).toContain('fl.ru, kwork.ru')
    expect(byId(view, 'platforms').state).toContain('сегодня: 4')
    expect(byId(view, 'approvals')).toMatchObject({
      status: 'needed',
      link: '/office/computer#computer-approvals',
    })
    // Approvals block work right now: they come before the money steps.
    expect(view.next?.id).toBe('approvals')
  })

  it('explains the wallet key states and the USDT address without exposing them', () => {
    const base = production()
    const rejected = launchSteps(
      production({
        wallet: { ...base.wallet, address: true, network: 'TRC20', keyStatus: 'rejected' },
      }),
    )
    expect(byId(rejected, 'usdt-address')).toMatchObject({ status: 'done' })
    expect(byId(rejected, 'usdt-address').state).toContain('TRC20')
    expect(byId(rejected, 'wallet-key').state).toContain('права на изменение')
    expect(byId(rejected, 'wallet-key').actions.at(-1)).toContain('Удалите отклонённый ключ')

    const ok = launchSteps(
      production({
        wallet: {
          ...base.wallet,
          address: true,
          network: 'TRC20',
          keyStatus: 'read_only',
          lastSyncAt: minutesAgo(3),
          unclassified: 2,
        },
      }),
    )
    expect(byId(ok, 'wallet-key')).toMatchObject({ status: 'done' })
    expect(byId(ok, 'wallet-key').state).toContain('3 мин назад')
    expect(byId(ok, 'wallet-key').state).toContain('без отметки: 2')

    const error = launchSteps(
      production({
        wallet: { ...base.wallet, keyStatus: 'error', keyError: 'BYBIT_HTTP_403' },
      }),
    )
    expect(byId(error, 'wallet-key').state).toContain('Bybit ответил: BYBIT_HTTP_403')
    expect(byId(error, 'wallet-key').codes).toEqual(['BYBIT_HTTP_403'])
  })

  it('never reports an unchecked live key as accepted', () => {
    const base = production()
    const withLive = (live: Partial<typeof base.trading.bybit.live>) =>
      byId(
        launchSteps(
          production({
            trading: {
              ...base.trading,
              bybit: { ...base.trading.bybit, live: { ...base.trading.bybit.live, ...live } },
            },
          }),
        ),
        'bybit-live-key',
      )
    const unchecked = withLive({ checkError: '', checkedAt: null })
    expect(unchecked.status).toBe('needed')
    expect(unchecked.state).toContain('ещё не проверялся')
    expect(unchecked.state).not.toContain('принят')
    const accepted = withLive({ checkError: '', checkedAt: minutesAgo(5) })
    expect(accepted).toMatchObject({ status: 'done' })
    expect(accepted.state).toContain('Ключ принят, проверен 5 мин назад')
    const unfunded = withLive({
      checkError: 'TRADING_INSUFFICIENT_FUNDS',
      checkedAt: minutesAgo(5),
    })
    expect(unfunded.status).toBe('done')
    expect(unfunded.state).toContain('счёт не готов')
  })

  it('opens live trading only when every gate passes, and reports a running portfolio', () => {
    const base = production()
    const ready = {
      ...base.trading,
      liveEnabled: true,
      bybit: {
        demoKeys: true,
        liveKeys: true,
        demo: { status: 'running', checkError: '', checkedAt: minutesAgo(2), roundTrips: true },
        live: {
          status: 'idle',
          checkError: '',
          reason: '',
          capitalOk: true,
          startedAt: null,
          checkedAt: minutesAgo(30),
        },
        paper: { status: 'running', qualified: true },
      },
    }
    const gates = launchSteps(production({ trading: ready }))
    expect(byId(gates, 'bybit-demo').status).toBe('done')
    expect(byId(gates, 'bybit-live-key').status).toBe('done')
    expect(byId(gates, 'live-trading')).toMatchObject({ status: 'needed' })
    expect(byId(gates, 'live-trading').state).toContain('фразой подтверждения')

    const running = launchSteps(
      production({
        trading: {
          ...ready,
          bybit: {
            ...ready.bybit,
            live: { ...ready.bybit.live, status: 'running', startedAt: minutesAgo(60 * 50) },
          },
        },
      }),
    )
    expect(byId(running, 'live-trading')).toMatchObject({ status: 'done' })
    expect(byId(running, 'live-trading').state).toContain('2 дн назад')

    const paused = launchSteps(
      production({
        trading: {
          ...ready,
          bybit: {
            ...ready.bybit,
            live: { ...ready.bybit.live, status: 'paused', reason: 'DAILY_LOSS_LIMIT' },
          },
        },
      }),
    )
    expect(byId(paused, 'live-trading').state).toContain('Остановлена')
  })

  it('reports everything done when every required step is done', () => {
    const base = production()
    const view = launchSteps(
      production({
        computer: {
          ...base.computer,
          failures: 0,
          lastError: '',
          platforms: base.computer.platforms.map((p) => ({
            ...p,
            loggedIn: p.domain === 'kwork.ru',
          })),
        },
        wallet: { ...base.wallet, address: true, network: 'TRC20', keyStatus: 'read_only' },
        trading: {
          ...base.trading,
          bybit: {
            ...base.trading.bybit,
            demoKeys: true,
            demo: { status: 'running', checkError: '', checkedAt: minutesAgo(1), roundTrips: true },
            live: { ...base.trading.bybit.live, checkError: '' },
          },
        },
      }),
    )
    expect(view.done).toBe(view.total)
    expect(view.next).toBeNull()
  })

  it('has plain words for times and trading codes', () => {
    expect(since(null, now)).toBe('ещё не было')
    expect(since(minutesAgo(0), now)).toBe('только что')
    expect(since(minutesAgo(59), now)).toBe('59 мин назад')
    expect(since(minutesAgo(60 * 5), now)).toBe('5 ч назад')
    expect(since(minutesAgo(60 * 72), now)).toBe('3 дн назад')
    expect(tradingWord('')).toBe('')
    expect(tradingWord('TRADING_KEY_PERMISSIONS')).toContain('Spot Trade')
    expect(tradingWord('TRADING_SOMETHING_NEW')).toContain('TRADING_SOMETHING_NEW')
  })
})
