import { launchSteps } from '../../../core/launch/steps'
import { defaultPlatformDomains } from '../../../core/computer-use/platforms'
import type { LaunchView } from '../../../core/contracts/launch'

/**
 * The production state of 21.10 through the real step computation: model and autopilot work,
 * the browser agent is halted after three failures, no platform is logged in, no wallet key or
 * USDT address, the Bybit trading key is rejected.
 */
export function launchFixture(now: Date): LaunchView {
  const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000).toISOString()
  return launchSteps({
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
      lastSuccessAt: minutesAgo(6),
      lastErrorCode: '',
      costAlert: false,
      dailyKopecks: 120_000,
      monthlyKopecks: 1_080_000,
      paidTotalMicrousd: 90_000_000,
      daySpentKopecks: 18_700,
      monthSpentKopecks: 212_400,
      paidSpentMicrousd: 17_320_000,
    },
    computer: {
      blocker: '',
      demo: false,
      enabled: true,
      failures: 3,
      maxFailures: 3,
      lastError: 'COMPUTER_USE_VM_UNAVAILABLE',
      lastStepAt: minutesAgo(130),
      lastDoneAt: minutesAgo(60 * 9),
      approvals: 0,
      autoProposalsAllowed: true,
      autoProposals: true,
      proposalsPerDay: 15,
      platforms: defaultPlatformDomains.map((domain) => ({ domain, loggedIn: false })),
      sentToday: 0,
      opportunities: 23,
      humanOpportunities: 23,
    },
    seller: {
      seller: false,
      contact: false,
      terms: false,
      paymentMode: 'sandbox',
      publicProducts: 4,
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
          checkedAt: '2026-10-21T11:00:00.000Z',
        },
        paper: { status: 'paused', qualified: false },
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
      {
        track: 'defi',
        title: 'DeFi',
        demoReady: 'EXECUTION_WALLET_REQUIRED',
        paperStatus: 'running',
      },
      {
        track: 'prediction',
        title: 'Прогнозы',
        demoReady: 'EXECUTION_CREDENTIALS_REQUIRED',
        paperStatus: 'idle',
      },
    ],
  })
}
