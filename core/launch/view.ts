import { computerUseReady, config, modelConfigured } from '../config'
import { query } from '../db'
import { budgetSummary } from '../budget'
import { COMPUTER_USE_POLICY } from '../computer-use/policy'
import { platformDomains } from '../computer-use/platforms'
import { effectiveProposalsPerDay, readProfile } from '../computer-use/profile'
import { executionReady } from '../execution/config'
import { executionTracks, type ExecutionTrack } from '../execution/types'
import { TRADING_POLICY } from '../policy'
import { ensurePortfolios, paperCandidates } from '../trading/store'
import { hasKeys } from '../trading/wire'
import { exchanges } from '../trading/types'
import { units } from '../trading/decimal'
import { walletView } from '../wallet/view'
import type { LaunchView } from '../contracts/launch'
import { launchSteps, type LaunchInput } from './steps'

/**
 * `GET /api/office/launch`: facts from existing tables and the environment, reduced to
 * booleans, counts and codes before they reach the steps. No external calls, no secrets.
 */
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null)
const trackTitle: Record<ExecutionTrack, string> = {
  arbitrage: 'Арбитраж',
  funding: 'Фандинг',
  defi: 'DeFi',
  prediction: 'Прогнозы',
}

export async function launchInput(now = new Date()): Promise<LaunchInput> {
  const c = config()
  await ensurePortfolios()
  const [
    [state],
    [calls],
    budget,
    [cu],
    platformRows,
    [cuCounts],
    [sent],
    [products],
    wallet,
    portfolios,
    [demoTrips],
    paper,
    [manager],
    execution,
    performer,
  ] = await Promise.all([
    query(
      'SELECT mode,worker_heartbeat,schedule_enabled,research_enabled,provider_readiness FROM system_state WHERE id=true',
    ),
    query(
      `SELECT
        (SELECT max(coalesce(finished_at,created_at)) FROM tool_calls WHERE status='done' AND NOT is_demo) AS last_ok,
        (SELECT error_code FROM tool_calls WHERE status<>'done' AND error_code IS NOT NULL AND NOT is_demo
           ORDER BY created_at DESC LIMIT 1) AS last_error`,
    ),
    budgetSummary(),
    query(
      `SELECT enabled,failures,last_error,auto_proposals,
        (SELECT max(created_at) FROM computer_use_steps) AS last_step,
        (SELECT max(finished_at) FROM computer_use_tasks WHERE status='done') AS last_done,
        (SELECT count(*)::int FROM computer_use_approvals WHERE status='pending') AS approvals
       FROM computer_use WHERE id=true`,
    ),
    query('SELECT domain,logged_in FROM computer_use_platforms'),
    query(
      `SELECT count(*)::int AS found,
        count(*) FILTER (WHERE requires_human OR decision='human')::int AS human
       FROM computer_use_opportunities`,
    ),
    query(
      `SELECT count(*)::int AS n FROM computer_use_proposals
       WHERE status='sent' AND sent_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    ),
    query("SELECT count(*)::int AS n FROM products WHERE status='sandbox' AND visibility='public'"),
    walletView(now),
    query(
      'SELECT exchange,mode,status,reason,check_error,checked_at,capital::text,started_at FROM trading_portfolios',
    ),
    query(
      "SELECT EXISTS(SELECT 1 FROM trading_agents WHERE exchange='bybit' AND mode='demo' AND round_trips>0) AS trips",
    ),
    paperCandidates('bybit'),
    query('SELECT enabled FROM trading_manager WHERE id=true'),
    query('SELECT track,mode,status FROM execution_portfolios'),
    readProfile(),
  ])
  const alive =
    !!state?.worker_heartbeat && now.getTime() - new Date(state.worker_heartbeat).getTime() < 90_000
  const readiness = state?.provider_readiness
  const readinessFresh =
    alive && !!readiness && now.getTime() - new Date(readiness.checkedAt).getTime() < 90_000
  const paid = c.MODEL_PROVIDER === 'openai'
  const loggedIn = new Map(platformRows.map((r) => [r.domain as string, !!r.logged_in]))
  const bybit = (mode: string) => portfolios.find((p) => p.exchange === 'bybit' && p.mode === mode)
  const demo = bybit('demo'),
    live = bybit('live'),
    paperRow = bybit('paper')
  const minLive = units(String(TRADING_POLICY.minLiveCapitalUsdt))
  return {
    now,
    system: {
      mode: state?.mode ?? 'running',
      workerAlive: alive,
      scheduleEnabled: !!state?.schedule_enabled,
      autonomyAllowed: c.AUTONOMY_ENABLED,
      researchEnabled: state?.research_enabled !== false,
      autopilotOnBoot: c.AUTOPILOT_ON_BOOT,
      workspaceMode: c.WORKSPACE_MODE,
    },
    model: {
      provider: c.MODEL_PROVIDER,
      configured: modelConfigured(c),
      paid,
      readyNow: readinessFresh ? !!readiness.model : null,
      lastSuccessAt: iso(calls?.last_ok),
      lastErrorCode: String(calls?.last_error ?? ''),
      costAlert: c.MODEL_PROVIDER === 'openrouter' && budget.openrouterActualMicrousd > 0,
      dailyKopecks: c.DAILY_BUDGET_KOPECKS,
      monthlyKopecks: c.MONTHLY_BUDGET_KOPECKS,
      paidTotalMicrousd: c.OPENAI_TOTAL_BUDGET_MICROUSD,
      daySpentKopecks: budget.daySpent,
      monthSpentKopecks: budget.monthSpent,
      paidSpentMicrousd: budget.openaiSpentMicrousd,
    },
    computer: {
      blocker: computerUseReady(c),
      demo: c.MODEL_PROVIDER === 'demo',
      enabled: !!cu?.enabled,
      failures: cu?.failures ?? 0,
      maxFailures: COMPUTER_USE_POLICY.maxFailuresInRow,
      lastError: String(cu?.last_error ?? ''),
      lastStepAt: iso(cu?.last_step),
      lastDoneAt: iso(cu?.last_done),
      approvals: cu?.approvals ?? 0,
      autoProposalsAllowed: c.COMPUTER_USE_AUTO_PROPOSALS,
      autoProposals: !!cu?.auto_proposals,
      proposalsPerDay: effectiveProposalsPerDay(
        performer.profile,
        c.COMPUTER_USE_PROPOSALS_PER_DAY,
      ),
      platforms: platformDomains().map((domain) => ({
        domain,
        loggedIn: loggedIn.get(domain) ?? false,
      })),
      sentToday: sent?.n ?? 0,
      opportunities: cuCounts?.found ?? 0,
      humanOpportunities: cuCounts?.human ?? 0,
    },
    seller: {
      seller: !!c.PUBLIC_SELLER,
      contact: !!c.PUBLIC_CONTACT,
      terms: !!c.PUBLIC_TERMS_URL,
      paymentMode: c.PAYMENT_MODE,
      publicProducts: products?.n ?? 0,
    },
    wallet: {
      address: !!wallet.address,
      network: wallet.address?.network ?? '',
      keyStatus: wallet.keyStatus,
      keyError: wallet.keyError,
      lastSyncAt: wallet.lastSyncAt,
      unclassified: wallet.unclassifiedCount,
      incomeDeposits: wallet.periods.month.income.length,
    },
    trading: {
      liveEnabled: c.TRADING_LIVE_ENABLED,
      minLiveUsdt: TRADING_POLICY.minLiveCapitalUsdt,
      bybit: {
        demoKeys: hasKeys({ exchange: 'bybit', mode: 'demo' }),
        liveKeys: hasKeys({ exchange: 'bybit', mode: 'live' }),
        demo: {
          status: demo?.status ?? 'idle',
          checkError: String(demo?.check_error ?? ''),
          checkedAt: iso(demo?.checked_at),
          roundTrips: !!demoTrips?.trips,
        },
        live: {
          status: live?.status ?? 'idle',
          checkError: String(live?.check_error ?? ''),
          reason: String(live?.reason ?? ''),
          capitalOk: !!live && BigInt(live.capital) >= minLive,
          startedAt: iso(live?.started_at),
          checkedAt: iso(live?.checked_at),
        },
        paper: { status: paperRow?.status ?? 'idle', qualified: paper.length > 0 },
      },
      otherLiveKeys: exchanges.filter(
        (e) => e !== 'bybit' && hasKeys({ exchange: e, mode: 'live' }),
      ),
    },
    manager: { enabled: !!manager?.enabled },
    execution: executionTracks.map((track) => ({
      track,
      title: trackTitle[track],
      demoReady: executionReady(track, 'demo'),
      paperStatus: execution.find((r) => r.track === track && r.mode === 'paper')?.status ?? 'idle',
    })),
  }
}

export async function launchView(now = new Date()): Promise<LaunchView> {
  return launchSteps(await launchInput(now))
}
