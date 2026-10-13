import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../../core/db'
import {
  configureExecution,
  controlExecution,
  executionTick,
  type ExecutionFactory,
} from '../../core/execution/engine'
import {
  defaultExecutionSettings,
  ensureExecution,
  executionConfiguration,
  portfolio,
} from '../../core/execution/store'
import { executionView } from '../../core/execution/view'
import { decimal, units } from '../../core/trading/decimal'
import {
  ExecutionRejected,
  type ExecutionDecision,
  type ExecutionDriver,
  type ExecutionIntent,
  type ExecutionLeg,
  type ExecutionMode,
  type ExecutionOperation,
  type ExecutionPlan,
  type ExecutionReceipt,
  type ExecutionSettings,
  type ExecutionTrack,
  type PreparedExecution,
} from '../../core/execution/types'
import { applyMigrations, resetDatabase } from './helpers/db'

const plan: ExecutionPlan = {
  symbol: 'KXTEST-26OCT13',
  quantity: '2',
  entryPrice: '1',
  hedgePrice: '0',
  buyVenue: 'kalshi',
  sellVenue: 'kalshi',
  outcome: 'yes',
  rate: '0.8',
  nextPaymentAt: 0,
  intervalMs: 0,
}
const terminal = (
  intent: ExecutionIntent,
  overrides: Partial<ExecutionReceipt> = {},
): ExecutionReceipt => ({
  status: 'filled',
  externalId: `exchange:${intent.clientId}`,
  filledQuantity: intent.quantity,
  grossQuote: intent.action === 'sell' ? '3' : '2',
  quoteFee: intent.action === 'sell' ? '0.02' : '0.01',
  baseFee: '0',
  ...overrides,
})
function intent(action: ExecutionIntent['action'] = 'buy', quantity = '2'): ExecutionIntent {
  return {
    clientId: randomUUID().replaceAll('-', ''),
    venue: 'kalshi',
    action,
    symbol: plan.symbol,
    quantity,
    limitPrice: action === 'sell' ? '1.5' : '1',
    quoteBudget: action === 'sell' ? '1' : '10',
    positionQuantity: action === 'sell' ? quantity : '0',
    outcome: 'yes',
    expiresAt: Date.now() + 10000,
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function harness() {
  const state = {
    close: false,
    identity: '',
    planEnabled: true,
    prepareError: null as Error | null,
    broadcastError: null as Error | null,
    lookup: null as ((prepared: PreparedExecution) => Promise<ExecutionReceipt | null>) | null,
    decision: null as ExecutionDecision | null,
    wait: null as {
      entered: ReturnType<typeof deferred>
      release: ReturnType<typeof deferred>
    } | null,
  }
  const prepare = vi.fn(async (input: ExecutionIntent): Promise<PreparedExecution> => {
    if (state.prepareError) throw state.prepareError
    return { intent: input, externalId: null, payload: { internalOnly: 'not-for-the-browser' } }
  })
  const broadcast = vi.fn(async (_prepared: PreparedExecution) => {
    if (state.wait) {
      state.wait.entered.resolve()
      await state.wait.release.promise
    }
    if (state.broadcastError) throw state.broadcastError
  })
  const lookup = vi.fn(async (prepared: PreparedExecution) =>
    state.lookup ? state.lookup(prepared) : terminal(prepared.intent),
  )
  const adapter = { prepare, broadcast, lookup }
  const factory: ExecutionFactory = (p) => ({
    async accounts() {
      return [{ identity: state.identity || `fixture:${p.track}:${p.mode}`, venue: 'kalshi' }]
    },
    async plan(current) {
      return state.planEnabled
        ? {
            plan: { ...plan, symbol: current.settings.predictionTicker || plan.symbol },
            reserve: '10',
          }
        : null
    },
    async decide(current, op, legs) {
      if (state.decision) return state.decision
      if (!legs.length)
        return {
          type: 'leg',
          role: 'open',
          intent: { ...intent(), symbol: op.plan.symbol, outcome: op.plan.outcome, clientId: '' },
        }
      const bought = legs
        .filter((leg) => leg.prepared.intent.action === 'buy')
        .reduce((n, leg) => n + units(leg.receipt?.filledQuantity || '0'), 0n)
      const sold = legs
        .filter((leg) => leg.prepared.intent.action === 'sell')
        .reduce((n, leg) => n + units(leg.receipt?.filledQuantity || '0'), 0n)
      const fees = legs.reduce((n, leg) => n + units(leg.receipt?.quoteFee || '0'), 0n)
      const cash = legs.reduce(
        (n, leg) =>
          n +
          (leg.prepared.intent.action === 'sell' ? 1n : -1n) *
            units(leg.receipt?.grossQuote || '0'),
        0n,
      )
      if (!bought || sold === bought)
        return { type: 'close', pnl: decimal(cash - fees), fees: decimal(fees) }
      if (current.close_requested || state.close)
        return {
          type: 'leg',
          role: 'compensate',
          intent: {
            ...intent('sell', decimal(bought - sold)),
            symbol: op.plan.symbol,
            outcome: op.plan.outcome,
            clientId: '',
          },
        }
      return { type: 'hold', pnl: decimal(-fees), fees: decimal(fees) }
    },
    adapter() {
      return adapter
    },
  })
  return { state, factory, prepare, broadcast, lookup }
}
async function configure(track: ExecutionTrack = 'prediction', mode: ExecutionMode = 'paper') {
  await configureExecution({
    track,
    mode,
    capital: '100',
    settings: { ...defaultExecutionSettings, predictionTicker: plan.symbol },
  })
}
async function start(
  h: ReturnType<typeof harness>,
  track: ExecutionTrack = 'prediction',
  mode: ExecutionMode = 'paper',
) {
  await configure(track, mode)
  await controlExecution(track, mode, 'start', h.factory)
}
async function onlyLeg() {
  return (await query<ExecutionLeg>('SELECT * FROM execution_legs ORDER BY sequence'))[0]!
}
async function openOperation() {
  return (
    await query<ExecutionOperation>('SELECT * FROM execution_operations WHERE closed_at IS NULL')
  )[0]!
}
async function seedPrepared(
  h: ReturnType<typeof harness>,
  state: ExecutionLeg['state'] = 'prepared',
) {
  const opId = randomUUID(),
    input = intent()
  const prepared = await h.prepare(input)
  await query(
    "INSERT INTO execution_operations(id,track,mode,reserve,plan) VALUES($1,'prediction','paper',10,$2)",
    [opId, plan],
  )
  await query(
    "UPDATE execution_portfolios SET cash=90,last_scan=now() WHERE track='prediction' AND mode='paper'",
  )
  await query(
    "INSERT INTO execution_legs(id,operation_id,sequence,role,state,prepared) VALUES($1,$2,0,'open',$3,$4)",
    [input.clientId, opId, state, prepared],
  )
  return prepared
}

beforeAll(applyMigrations)
beforeEach(async () => {
  await resetDatabase()
  await ensureExecution()
  vi.stubEnv('EXECUTION_LIVE_ENABLED', 'false')
  vi.stubEnv('EXECUTION_LIVE_ACCEPTED_TRACKS', '')
  for (const mode of ['DEMO', 'LIVE']) {
    vi.stubEnv(`EXECUTION_PREDICTION_KALSHI_${mode}_KEY_ID`, 'fixture-key')
    vi.stubEnv(`EXECUTION_PREDICTION_KALSHI_${mode}_PRIVATE_KEY`, 'fixture-secret')
    vi.stubEnv(`EXECUTION_PREDICTION_KALSHI_${mode}_ACCOUNT_ID`, 'fixture-account')
    vi.stubEnv(`EXECUTION_PREDICTION_KALSHI_${mode}_SUBACCOUNT`, '1')
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
})
afterAll(() => pool.end())

describe('durable earning execution', () => {
  it('resumes a persisted prepared order and records only one broadcast across restarts', async () => {
    const h = harness()
    await start(h)
    const prepared = await seedPrepared(h)
    expect(await executionTick(h.factory)).toBe(true)
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(h.broadcast.mock.calls[0]![0]).toEqual(prepared)
    expect((await onlyLeg()).state).toBe('terminal')
    await executionTick(h.factory)
    await executionTick(h.factory)
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(decimal(units((await portfolio('prediction', 'paper')).fees))).toBe('0.01')
  })

  it('never resends after a crash between the submitted marker and acknowledgement', async () => {
    const h = harness()
    await start(h)
    await seedPrepared(h, 'submitted')
    h.state.lookup = async () => null
    await executionTick(h.factory)
    expect(h.broadcast).not.toHaveBeenCalled()
    expect((await onlyLeg()).state).toBe('unknown')
    expect(await portfolio('prediction', 'paper')).toMatchObject({
      status: 'attention',
      reason: 'EXECUTION_ORDER_UNKNOWN',
    })
    h.state.lookup = async (prepared) => terminal(prepared.intent)
    await executionTick(h.factory)
    expect(h.broadcast).not.toHaveBeenCalled()
    expect((await onlyLeg()).state).toBe('terminal')
    expect((await portfolio('prediction', 'paper')).status).toBe('paused')
  })

  it('continues reconciling unknown executions without clearing an existing risk stop', async () => {
    const h = harness()
    await start(h)
    await seedPrepared(h, 'submitted')
    await query(
      "UPDATE execution_portfolios SET status='stopped',reason='EXECUTION_DRAWDOWN_STOP',close_requested=true WHERE track='prediction' AND mode='paper'",
    )
    h.state.lookup = async () => null
    await executionTick(h.factory)
    expect(await portfolio('prediction', 'paper')).toMatchObject({
      status: 'stopped',
      reason: 'EXECUTION_DRAWDOWN_STOP',
      close_requested: true,
    })
    h.state.lookup = async (prepared) => terminal(prepared.intent)
    await executionTick(h.factory)
    expect((await onlyLeg()).state).toBe('terminal')
    expect(await portfolio('prediction', 'paper')).toMatchObject({
      status: 'stopped',
      reason: 'EXECUTION_DRAWDOWN_STOP',
    })
  })

  it('persists late cumulative fees, stops on an actual budget overrun and still permits an exit', async () => {
    const h = harness()
    await start(h)
    let complete = false
    h.state.lookup = async (prepared) =>
      terminal(
        prepared.intent,
        prepared.intent.action === 'buy'
          ? { status: complete ? 'filled' : 'pending', quoteFee: complete ? '8.01' : '0' }
          : {},
      )
    await executionTick(h.factory)
    expect((await onlyLeg()).state).toBe('submitted')
    expect(decimal(units((await portfolio('prediction', 'paper')).fees))).toBe('0')
    complete = true
    await executionTick(h.factory)
    expect((await onlyLeg()).receipt!.quoteFee).toBe('8.01')
    expect(await portfolio('prediction', 'paper')).toMatchObject({
      status: 'stopped',
      close_requested: true,
      reason: 'EXECUTION_FILL_BUDGET_EXCEEDED',
    })
    await executionTick(h.factory)
    expect(h.broadcast.mock.calls.map(([prepared]) => prepared.intent.action)).toEqual([
      'buy',
      'sell',
    ])
    await executionTick(h.factory)
    const p = await portfolio('prediction', 'paper')
    expect(decimal(units(p.fees))).toBe('8.03')
    expect(decimal(units(p.cash))).toBe('92.97')
    expect(p.reason).toBe('EXECUTION_FILL_BUDGET_EXCEEDED')
  })

  it('compensates only a partial actual fill and closes the ledger once', async () => {
    const h = harness()
    await start(h)
    h.state.close = true
    h.state.lookup = async (prepared) =>
      terminal(
        prepared.intent,
        prepared.intent.action === 'buy'
          ? { status: 'cancelled', filledQuantity: '0.75', grossQuote: '0.75' }
          : { grossQuote: '0.8' },
      )
    await executionTick(h.factory)
    await executionTick(h.factory)
    const exit = h.broadcast.mock.calls[1]![0]
    expect(exit.intent).toMatchObject({
      action: 'sell',
      quantity: '0.75',
      positionQuantity: '0.75',
    })
    await executionTick(h.factory)
    const closed = await portfolio('prediction', 'paper')
    expect(decimal(units(closed.cash))).toBe('100.02')
    await executionTick(h.factory)
    expect(decimal(units((await portfolio('prediction', 'paper')).cash))).toBe('100.02')
    expect(await query('SELECT id FROM execution_operations')).toHaveLength(1)
  })

  it('preserves settled payouts and their ledger effects exactly once', async () => {
    const h = harness()
    await start(h)
    await executionTick(h.factory)
    const op = await openOperation()
    h.state.decision = {
      type: 'close',
      pnl: '0.99',
      fees: '0.01',
      flows: [
        { externalId: 'actual-settlement-id', kind: 'settlement', amount: '3', at: Date.now() },
      ],
    }
    await executionTick(h.factory)
    await executionTick(h.factory)
    expect(
      await query('SELECT * FROM execution_cashflows WHERE operation_id=$1', [op.id]),
    ).toHaveLength(1)
    const p = await portfolio('prediction', 'paper')
    expect(decimal(units(p.realized))).toBe('0.99')
    expect(decimal(units(p.cash))).toBe('100.99')
    expect(decimal(units(p.fees))).toBe('0.01')
  })

  it('cancels an unsent opening when close was requested but lets ordinary pause finish an accepted cycle', async () => {
    const h = harness()
    await start(h)
    await seedPrepared(h)
    await controlExecution('prediction', 'paper', 'close', h.factory)
    await executionTick(h.factory)
    expect(h.broadcast).not.toHaveBeenCalled()
    expect((await onlyLeg()).receipt!.status).toBe('rejected')
    await executionTick(h.factory)
    expect(decimal(units((await portfolio('prediction', 'paper')).cash))).toBe('100')
    await controlExecution('prediction', 'paper', 'start', h.factory)
    await query(
      "UPDATE execution_portfolios SET last_scan=NULL WHERE track='prediction' AND mode='paper'",
    )
    const created = await seedPrepared(h)
    await controlExecution('prediction', 'paper', 'pause', h.factory)
    await executionTick(h.factory)
    expect(h.broadcast).toHaveBeenCalledWith(created)
  })

  it('records a definitive preparation rejection and does not rebuild it every tick', async () => {
    const h = harness()
    await start(h)
    h.state.prepareError = new ExecutionRejected('EXECUTION_AAVE_APPROVAL_REQUIRED')
    await executionTick(h.factory)
    expect(await portfolio('prediction', 'paper')).toMatchObject({
      status: 'attention',
      reason: 'EXECUTION_AAVE_APPROVAL_REQUIRED',
    })
    expect((await onlyLeg()).receipt!.status).toBe('rejected')
    expect((await openOperation()).status).toBe('attention')
    await executionTick(h.factory)
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.broadcast).not.toHaveBeenCalled()
  })

  it('keeps a private unsigned Aave rejection terminal without reserving a wallet nonce', async () => {
    const h = harness()
    vi.stubEnv('EXECUTION_DEFI_DEMO_CONFIG', '{}')
    h.state.decision = {
      type: 'leg',
      role: 'supply',
      intent: { ...intent(), clientId: '', venue: 'aave', action: 'supply' },
    }
    h.state.prepareError = new ExecutionRejected('EXECUTION_AAVE_APPROVAL_REQUIRED')
    await start(h, 'defi', 'demo')
    await executionTick(h.factory)
    const leg = await onlyLeg()
    expect(leg.state).toBe('terminal')
    expect(leg.receipt!.status).toBe('rejected')
    expect(leg.prepared.payload).toEqual({})
    expect((await query('SELECT chain_id,sender,nonce FROM execution_legs'))[0]).toEqual({
      chain_id: null,
      sender: null,
      nonce: null,
    })
    await executionTick(h.factory)
    expect(h.prepare).toHaveBeenCalledTimes(1)
    expect(h.broadcast).not.toHaveBeenCalled()
  })

  it('normalizes a prepared wallet identity before reserving its signed nonce', async () => {
    const h = harness()
    vi.stubEnv('EXECUTION_DEFI_DEMO_CONFIG', '{}')
    h.state.decision = {
      type: 'leg',
      role: 'supply',
      intent: { ...intent(), clientId: '', venue: 'aave', action: 'supply' },
    }
    h.prepare.mockImplementation(async (input) => ({
      intent: input,
      externalId: '0xsynthetictransactionhash',
      payload: { chainId: 11155111, sender: `0x${'Ab'.repeat(20)}`, nonce: 0 },
    }))
    await start(h, 'defi', 'demo')
    await executionTick(h.factory)
    expect((await query('SELECT chain_id,sender,nonce FROM execution_legs'))[0]).toEqual({
      chain_id: '11155111',
      sender: `0x${'ab'.repeat(20)}`,
      nonce: '0',
    })
    expect((await onlyLeg()).state).toBe('terminal')
    expect(h.broadcast).toHaveBeenCalledTimes(1)
  })

  it('recovers an absent EVM hash by resending only the same persisted bytes and nonce', async () => {
    const h = harness()
    vi.stubEnv('EXECUTION_DEFI_DEMO_CONFIG', '{}')
    await start(h, 'defi', 'demo')
    const opId = randomUUID()
    const input: ExecutionIntent = { ...intent(), venue: 'aave', action: 'supply' }
    const prepared: PreparedExecution = {
      intent: input,
      externalId: '0xsynthetictransactionhash',
      payload: {
        chainId: 11155111,
        sender: `0x${'ab'.repeat(20)}`,
        nonce: 7,
        rawTransaction: '0xsyntheticsignedbytes',
      },
    }
    await query(
      "INSERT INTO execution_operations(id,track,mode,reserve,plan) VALUES($1,'defi','demo',10,$2)",
      [opId, { ...plan, buyVenue: 'aave', sellVenue: 'aave' }],
    )
    await query(
      "UPDATE execution_portfolios SET cash=90,last_scan=now() WHERE track='defi' AND mode='demo'",
    )
    await query(
      "INSERT INTO execution_legs(id,operation_id,sequence,role,state,prepared,chain_id,sender,nonce,submitted_at) VALUES($1,$2,0,'supply','submitted',$3,11155111,$4,7,now())",
      [input.clientId, opId, prepared, prepared.payload.sender],
    )
    h.state.lookup = async (persisted) =>
      h.broadcast.mock.calls.length
        ? terminal(persisted.intent, { externalId: prepared.externalId })
        : null
    await executionTick(h.factory)
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(prepared)
    expect((await onlyLeg()).state).toBe('terminal')
    expect((await query('SELECT nonce FROM execution_legs'))[0]!.nonce).toBe('7')
  })

  it('keeps allocation immutable and rejects reused account identities', async () => {
    const h = harness()
    h.state.identity = 'same-real-exchange-account'
    await start(h)
    await expect(
      configureExecution({
        track: 'prediction',
        mode: 'paper',
        capital: '200',
        settings: { ...defaultExecutionSettings, predictionTicker: plan.symbol },
      }),
    ).rejects.toThrow('EXECUTION_ALLOCATION_IMMUTABLE')
    await expect(
      query(
        "UPDATE execution_portfolios SET capital=200 WHERE track='prediction' AND mode='paper'",
      ),
    ).rejects.toThrow('EXECUTION_ALLOCATION_IMMUTABLE')
    await configure('defi')
    await expect(controlExecution('defi', 'paper', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_ACCOUNT_ALREADY_USED',
    )
    expect((await portfolio('defi', 'paper')).started_at).toBeNull()
  })

  it('changes a closed paused strategy without resetting its financial history or account claims', async () => {
    const h = harness()
    await start(h)
    h.state.close = true
    await executionTick(h.factory)
    await executionTick(h.factory)
    await executionTick(h.factory)
    await controlExecution('prediction', 'paper', 'pause', h.factory)
    const before = await portfolio('prediction', 'paper')
    const accounts = await query('SELECT * FROM execution_accounts')
    const [closed] = await query<ExecutionOperation>('SELECT * FROM execution_operations')
    const changed = {
      ...before.settings,
      predictionTicker: 'KXNEXT-26OCT14',
      probabilityBps: 7300,
      maxHoldHours: 12,
    }
    expect(decimal(units(before.realized))).toBe('0.97')
    expect(closed!.plan.configuration).toBe(executionConfiguration(before.settings))
    await configureExecution({
      track: 'prediction',
      mode: 'paper',
      capital: '100.000000',
      settings: changed,
    })
    const after = await portfolio('prediction', 'paper')
    expect(after.settings).toEqual(changed)
    expect({ ...after, settings: before.settings }).toEqual(before)
    expect(await query('SELECT * FROM execution_accounts')).toEqual(accounts)
    expect((await executionView('prediction', 'paper')).activated).toBe(true)
    expect(
      (await query<ExecutionOperation>('SELECT * FROM execution_operations'))[0]!.plan,
    ).toEqual(closed!.plan)
    expect(
      await query("SELECT * FROM execution_events WHERE code='EXECUTION_SETTINGS_UPDATED'"),
    ).toHaveLength(1)
    await controlExecution('prediction', 'paper', 'start', h.factory)
    await query(
      "UPDATE execution_portfolios SET last_scan=NULL WHERE track='prediction' AND mode='paper'",
    )
    await executionTick(h.factory)
    expect((await openOperation()).plan).toMatchObject({
      symbol: changed.predictionTicker,
      configuration: executionConfiguration(changed),
    })
    expect((await openOperation()).plan.configuration).not.toBe(closed!.plan.configuration)
  })

  it('rejects settings edits while running or while a paused position is still open', async () => {
    const h = harness()
    await start(h)
    const settings = { ...(await portfolio('prediction', 'paper')).settings, probabilityBps: 7100 }
    const change = () =>
      configureExecution({ track: 'prediction', mode: 'paper', capital: '100', settings })
    const direct = () =>
      query(
        "UPDATE execution_portfolios SET settings=$1 WHERE track='prediction' AND mode='paper'",
        [settings],
      )
    await expect(change()).rejects.toThrow('EXECUTION_SETTINGS_REQUIRE_PAUSE')
    await expect(direct()).rejects.toThrow('EXECUTION_SETTINGS_REQUIRE_PAUSE')
    await executionTick(h.factory)
    await controlExecution('prediction', 'paper', 'pause', h.factory)
    await expect(change()).rejects.toThrow('EXECUTION_SETTINGS_POSITION_OPEN')
    await expect(direct()).rejects.toThrow('EXECUTION_SETTINGS_POSITION_OPEN')
    expect((await portfolio('prediction', 'paper')).settings.probabilityBps).toBe(5000)
  })

  it('cannot edit or resume a risk-stopped strategy through the settings path', async () => {
    const h = harness()
    await start(h)
    const settings = { ...(await portfolio('prediction', 'paper')).settings, probabilityBps: 7100 }
    await query(
      "UPDATE execution_portfolios SET status='stopped',reason='EXECUTION_DRAWDOWN_STOP',close_requested=true WHERE track='prediction' AND mode='paper'",
    )
    await controlExecution('prediction', 'paper', 'pause', h.factory)
    await expect(
      configureExecution({ track: 'prediction', mode: 'paper', capital: '100', settings }),
    ).rejects.toThrow('EXECUTION_RISK_STOP')
    await expect(
      query(
        "UPDATE execution_portfolios SET status='paused',settings=$1,reason='' WHERE track='prediction' AND mode='paper'",
        [settings],
      ),
    ).rejects.toThrow('EXECUTION_RISK_STOP')
    await query(
      "UPDATE execution_portfolios SET status='paused' WHERE track='prediction' AND mode='paper'",
    )
    await expect(
      configureExecution({ track: 'prediction', mode: 'paper', capital: '100', settings }),
    ).rejects.toThrow('EXECUTION_RISK_STOP')
    await expect(controlExecution('prediction', 'paper', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_RISK_STOP',
    )
    expect((await portfolio('prediction', 'paper')).reason).toBe('EXECUTION_DRAWDOWN_STOP')
  })

  it('keeps connections, activation and accounting immutable during an allowed settings edit', async () => {
    const h = harness()
    await start(h)
    await controlExecution('prediction', 'paper', 'pause', h.factory)
    const before = await portfolio('prediction', 'paper')
    const changed = { ...before.settings, buyExchange: 'binance' as const }
    await expect(
      configureExecution({ track: 'prediction', mode: 'paper', capital: '100', settings: changed }),
    ).rejects.toThrow('EXECUTION_CONNECTIONS_IMMUTABLE')
    await expect(
      query(
        "UPDATE execution_portfolios SET settings=$1 WHERE track='prediction' AND mode='paper'",
        [changed],
      ),
    ).rejects.toThrow('EXECUTION_CONNECTIONS_IMMUTABLE')
    await expect(
      query(
        "UPDATE execution_portfolios SET started_at=NULL WHERE track='prediction' AND mode='paper'",
      ),
    ).rejects.toThrow('EXECUTION_ALLOCATION_IMMUTABLE')
    await expect(
      query(
        "UPDATE execution_portfolios SET cash=0,settings=$1 WHERE track='prediction' AND mode='paper'",
        [{ ...before.settings, probabilityBps: 7100 }],
      ),
    ).rejects.toThrow('EXECUTION_SETTINGS_HISTORY_IMMUTABLE')
    expect(await portfolio('prediction', 'paper')).toEqual(before)
  })

  it('serializes concurrent workers around the same private submission', async () => {
    const h = harness()
    await start(h)
    h.state.wait = { entered: deferred(), release: deferred() }
    const first = executionTick(h.factory)
    await h.state.wait.entered.promise
    expect(await executionTick(h.factory)).toBe(false)
    h.state.wait.release.resolve()
    expect(await first).toBe(true)
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(await query('SELECT * FROM execution_legs')).toHaveLength(1)
  })

  it('does not expose signed payloads, keys or account identities in the owner view', async () => {
    const h = harness()
    h.prepare.mockImplementation(async (input) => ({
      intent: input,
      externalId: 'public-order-id',
      payload: {
        rawTransaction: 'SYNTHETIC_SIGNED_BYTES',
        privateKey: 'SYNTHETIC_SECRET',
        keyId: 'SYNTHETIC_KEY_ID',
        internalOnly: 'SYNTHETIC_PRIVATE_DATA',
      },
    }))
    h.state.identity = 'SYNTHETIC_PRIVATE_ACCOUNT_ID'
    await start(h)
    await executionTick(h.factory)
    const view = await executionView('prediction', 'paper')
    const serialized = JSON.stringify(view)
    expect(view.currency).toBe('USD')
    expect(view.legs).toHaveLength(1)
    for (const hidden of [
      'prepared',
      'payload',
      'rawTransaction',
      'privateKey',
      'keyId',
      'SYNTHETIC_',
    ])
      expect(serialized).not.toContain(hidden)
  })

  it('reuses an identical funding receipt and rejects changed amounts for the same external ID', async () => {
    const h = harness()
    await start(h)
    await executionTick(h.factory)
    const flow = {
      externalId: 'same-income-id',
      kind: 'funding' as const,
      amount: '0.05',
      at: Date.now(),
    }
    h.state.decision = { type: 'hold', pnl: '0.04', fees: '0.01', flows: [flow] }
    await executionTick(h.factory)
    await executionTick(h.factory)
    expect(await query('SELECT * FROM execution_cashflows')).toHaveLength(1)
    h.state.decision = {
      type: 'hold',
      pnl: '0.09',
      fees: '0.01',
      flows: [{ ...flow, amount: '0.1' }],
    }
    await executionTick(h.factory)
    expect((await portfolio('prediction', 'paper')).reason).toBe('EXECUTION_CASHFLOW_MISMATCH')
    expect(decimal(units((await openOperation()).pnl))).toBe('0.04')
    expect(
      decimal(
        units(
          (await query<{ amount: string }>('SELECT amount FROM execution_cashflows'))[0]!.amount,
        ),
      ),
    ).toBe('0.05')
  })
})

async function seedDemoCycles(
  success: boolean,
  settings: ExecutionSettings = { ...defaultExecutionSettings, predictionTicker: plan.symbol },
  withConfiguration = true,
) {
  await configureExecution({ track: 'prediction', mode: 'demo', capital: '100', settings })
  await query(
    "UPDATE execution_portfolios SET status='paused',started_at=coalesce(started_at,now()-interval '28 hours') WHERE track='prediction' AND mode='demo'",
  )
  for (let i = 0; i < 5; i++) {
    const id = randomUUID(),
      created = new Date(Date.now() - (27 - i * 6) * 3600000)
    await query(
      "INSERT INTO execution_operations(id,track,mode,status,reserve,plan,created_at,closed_at) VALUES($1,'prediction','demo','closed',10,$2,$3,$4)",
      [
        id,
        {
          ...plan,
          symbol: settings.predictionTicker,
          outcome: settings.outcome,
          ...(withConfiguration ? { configuration: executionConfiguration(settings) } : {}),
        },
        created,
        new Date(created.getTime() + 60000),
      ],
    )
    for (const action of ['buy', 'sell'] as const) {
      const input = {
        ...intent(action),
        symbol: settings.predictionTicker,
        outcome: settings.outcome,
      }
      const receipt = terminal(
        input,
        success
          ? {}
          : {
              status: 'rejected',
              externalId: null,
              filledQuantity: '0',
              grossQuote: '0',
              quoteFee: '0',
            },
      )
      await query(
        "INSERT INTO execution_legs(id,operation_id,sequence,role,state,prepared,receipt,settled_at) VALUES($1,$2,$3,$4,'terminal',$5,$6,$7)",
        [
          input.clientId,
          id,
          action === 'buy' ? 0 : 1,
          action,
          { intent: input, payload: {}, externalId: null },
          receipt,
          created,
        ],
      )
    }
  }
}

describe('execution Live acceptance', () => {
  it('requires new verified cycles after changing parameters even if Demo and Live settings now match', async () => {
    const h = harness()
    vi.stubEnv('EXECUTION_LIVE_ENABLED', 'true')
    vi.stubEnv('EXECUTION_LIVE_ACCEPTED_TRACKS', 'prediction')
    await seedDemoCycles(true)
    const changed = {
      ...(await portfolio('prediction', 'demo')).settings,
      predictionTicker: 'KXNEXT-26OCT14',
      probabilityBps: 7100,
    }
    for (const mode of ['demo', 'live'] as const)
      await configureExecution({ track: 'prediction', mode, capital: '100', settings: changed })
    await expect(controlExecution('prediction', 'live', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_DEMO_ACCEPTANCE_REQUIRED',
    )
    await seedDemoCycles(true, changed)
    await controlExecution('prediction', 'live', 'start', h.factory)
    expect((await portfolio('prediction', 'live')).status).toBe('running')
    expect(await query('SELECT id FROM execution_operations')).toHaveLength(10)
    expect(h.broadcast).not.toHaveBeenCalled()
  })

  it('does not grandfather legacy cycles or permit rewriting their configuration evidence', async () => {
    const h = harness()
    vi.stubEnv('EXECUTION_LIVE_ENABLED', 'true')
    vi.stubEnv('EXECUTION_LIVE_ACCEPTED_TRACKS', 'prediction')
    await configure('prediction', 'live')
    const settings = (await portfolio('prediction', 'live')).settings
    await seedDemoCycles(true, settings, false)
    await expect(controlExecution('prediction', 'live', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_DEMO_ACCEPTANCE_REQUIRED',
    )
    await expect(
      query(
        "UPDATE execution_operations SET plan=plan||jsonb_build_object('configuration',$1::text) WHERE mode='demo'",
        [executionConfiguration(settings)],
      ),
    ).rejects.toThrow('EXECUTION_PLAN_IMMUTABLE')
    expect(
      (await query<ExecutionOperation>('SELECT * FROM execution_operations'))[0]!.plan
        .configuration,
    ).toBeUndefined()
  })

  it('uses the immutable settings snapshot independently of object key order and later Demo edits', async () => {
    const h = harness()
    vi.stubEnv('EXECUTION_LIVE_ENABLED', 'true')
    vi.stubEnv('EXECUTION_LIVE_ACCEPTED_TRACKS', 'prediction')
    await seedDemoCycles(true)
    const original = (await portfolio('prediction', 'demo')).settings
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as unknown as ExecutionSettings
    expect(executionConfiguration(reordered)).toBe(executionConfiguration(original))
    await configureExecution({
      track: 'prediction',
      mode: 'live',
      capital: '100',
      settings: reordered,
    })
    await configureExecution({
      track: 'prediction',
      mode: 'demo',
      capital: '100',
      settings: { ...original, probabilityBps: 7100 },
    })
    await controlExecution('prediction', 'live', 'start', h.factory)
    expect((await portfolio('prediction', 'live')).status).toBe('running')
  })

  it('requires explicit enablement and never accepts five rejected demo attempts', async () => {
    const h = harness()
    await configure('prediction', 'live')
    await expect(controlExecution('prediction', 'live', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_LIVE_DISABLED',
    )
    vi.stubEnv('EXECUTION_LIVE_ENABLED', 'true')
    vi.stubEnv('EXECUTION_LIVE_ACCEPTED_TRACKS', 'prediction')
    await seedDemoCycles(false)
    await expect(controlExecution('prediction', 'live', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_DEMO_ACCEPTANCE_REQUIRED',
    )
  })

  it('accepts verified complete cycles spanning a day and rejects unresolved state or incidents', async () => {
    const h = harness()
    await configure('prediction', 'live')
    vi.stubEnv('EXECUTION_LIVE_ENABLED', 'true')
    vi.stubEnv('EXECUTION_LIVE_ACCEPTED_TRACKS', 'prediction')
    await seedDemoCycles(true)
    await query(
      "UPDATE execution_portfolios SET status='attention' WHERE track='prediction' AND mode='demo'",
    )
    await expect(controlExecution('prediction', 'live', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_DEMO_ACCEPTANCE_REQUIRED',
    )
    await query(
      "UPDATE execution_portfolios SET status='paused' WHERE track='prediction' AND mode='demo'",
    )
    await query(
      "INSERT INTO execution_events(track,mode,code,created_at) VALUES('prediction','demo','EXECUTION_ORDER_UNKNOWN',now()-interval '20 hours')",
    )
    await expect(controlExecution('prediction', 'live', 'start', h.factory)).rejects.toThrow(
      'EXECUTION_DEMO_ACCEPTANCE_REQUIRED',
    )
    await query("DELETE FROM execution_events WHERE code='EXECUTION_ORDER_UNKNOWN'")
    await controlExecution('prediction', 'live', 'start', h.factory)
    expect((await portfolio('prediction', 'live')).status).toBe('running')
    expect(h.broadcast).not.toHaveBeenCalled()
  })
})
