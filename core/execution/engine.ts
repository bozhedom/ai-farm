import { randomUUID } from 'node:crypto'
import { query, transaction } from '../db'
import { EXECUTION_POLICY as P } from '../policy'
import { BPS, decimal, max, units } from '../trading/decimal'
import { executionReady, executionWritesAllowed } from './config'
import {
  ensureExecution,
  executionEvent,
  executionLock,
  portfolio,
  safeExecutionError,
  allocationSchema,
  executionConfiguration,
  executionRiskStopped,
} from './store'
import {
  ExecutionRejected,
  type ExecutionDriver,
  type ExecutionIntent,
  type ExecutionLeg,
  type ExecutionMode,
  type ExecutionOperation,
  type ExecutionPortfolio,
  type ExecutionReceipt,
  type ExecutionTrack,
  type PreparedExecution,
} from './types'

export type ExecutionFactory = (p: ExecutionPortfolio) => ExecutionDriver
async function defaultFactory(p: ExecutionPortfolio) {
  return (await import('./factory')).createExecutionDriver(p)
}

const opening = (intent: ExecutionIntent) =>
  ['buy', 'short', 'approve', 'supply'].includes(intent.action)
const openingForbidden = (p: ExecutionPortfolio) =>
  p.close_requested || p.status === 'stopped' || p.status === 'attention'

function nonceReservation(p: ExecutionPortfolio, prepared: PreparedExecution) {
  if (p.mode === 'paper' || prepared.intent.venue !== 'aave') return [null, null, null]
  const { chainId, sender, nonce } = prepared.payload
  if (
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    typeof nonce !== 'number' ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0 ||
    typeof sender !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(sender)
  )
    throw new ExecutionRejected('EXECUTION_NONCE_INVALID')
  return [chainId, sender.toLowerCase(), nonce]
}
export async function configureExecution(input: unknown) {
  const data = allocationSchema.parse(input)
  if (data.track === 'arbitrage' && data.settings.buyExchange === data.settings.sellExchange)
    throw new Error('EXECUTION_DIFFERENT_EXCHANGES_REQUIRED')
  return executionLock(async () => {
    await ensureExecution()
    await transaction(async (db) => {
      const p = await portfolio(data.track, data.mode, db)
      if (p.started_at) {
        if (units(data.capital) !== units(p.capital))
          throw new Error('EXECUTION_ALLOCATION_IMMUTABLE')
        if (
          data.settings.buyExchange !== p.settings.buyExchange ||
          data.settings.sellExchange !== p.settings.sellExchange
        )
          throw new Error('EXECUTION_CONNECTIONS_IMMUTABLE')
        if (executionRiskStopped(p)) throw new Error('EXECUTION_RISK_STOP')
        if (p.status !== 'paused') throw new Error('EXECUTION_SETTINGS_REQUIRE_PAUSE')
        const unfinished = await query(
          `SELECT 1 FROM execution_operations o WHERE o.track=$1 AND o.mode=$2
           AND (o.closed_at IS NULL OR o.status<>'closed' OR EXISTS
             (SELECT 1 FROM execution_legs l WHERE l.operation_id=o.id AND l.state<>'terminal')) LIMIT 1`,
          [data.track, data.mode],
          db,
        )
        if (unfinished.length) throw new Error('EXECUTION_SETTINGS_POSITION_OPEN')
        await query(
          'UPDATE execution_portfolios SET settings=$3 WHERE track=$1 AND mode=$2',
          [data.track, data.mode, data.settings],
          db,
        )
        await executionEvent(p, 'EXECUTION_SETTINGS_UPDATED', db)
        return
      }
      await query(
        "UPDATE execution_portfolios SET capital=$3,cash=$3,equity=$3,peak=$3,day_equity=$3,settings=$4,reason='' WHERE track=$1 AND mode=$2",
        [data.track, data.mode, data.capital, data.settings],
        db,
      )
      await executionEvent(p, 'EXECUTION_CONFIGURED', db)
    })
    return { ok: true }
  })
}
export async function controlExecution(
  track: ExecutionTrack,
  mode: ExecutionMode,
  action: 'start' | 'pause' | 'close',
  factory?: ExecutionFactory,
) {
  return executionLock(async () => {
    await ensureExecution()
    const p = await portfolio(track, mode)
    if (action === 'pause' || action === 'close') {
      await query(
        "UPDATE execution_portfolios SET status=CASE WHEN status IN ('stopped','attention') THEN status ELSE 'paused' END,close_requested=close_requested OR $3 WHERE track=$1 AND mode=$2",
        [track, mode, action === 'close'],
      )
      await executionEvent(p, action === 'close' ? 'EXECUTION_CLOSE_REQUESTED' : 'EXECUTION_PAUSED')
      return { ok: true }
    }
    if (p.status === 'running') return { ok: true }
    if (executionRiskStopped(p)) throw new Error('EXECUTION_RISK_STOP')
    if (units(p.capital) < units(P.minCapital)) throw new Error('EXECUTION_ALLOCATION_REQUIRED')
    const ready = executionReady(track, mode)
    if (ready) throw new Error(ready)
    const open = await query<ExecutionOperation>(
      'SELECT * FROM execution_operations WHERE track=$1 AND mode=$2 AND closed_at IS NULL',
      [track, mode],
    )
    if (p.status === 'attention' || (p.close_requested && open.length))
      throw new Error('EXECUTION_RECONCILIATION_REQUIRED')
    // Owner waived Demo profitability acceptance on 28.10.2026; Live still needs
    // EXECUTION_LIVE_ENABLED, accepted tracks, capital and credentials.
    const driver = factory ? factory(p) : await defaultFactory(p)
    const identities = await driver.accounts(p)
    if (
      !identities.length ||
      identities.some((a) => !a.identity || !a.venue) ||
      new Set(identities.map((a) => a.identity)).size !== identities.length
    )
      throw new Error('EXECUTION_ACCOUNT_INVALID')
    await transaction(async (db) => {
      if (!p.started_at) {
        for (const account of identities)
          await query(
            'INSERT INTO execution_accounts(identity,track,mode,venue,snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [account.identity, track, mode, account.venue, account.snapshot || null],
            db,
          )
      }
      {
        const existing = await query<{ identity: string; venue: string }>(
          'SELECT identity,venue FROM execution_accounts WHERE track=$1 AND mode=$2',
          [track, mode],
          db,
        )
        if (
          existing.length !== identities.length ||
          existing.some(
            (a) => !identities.some((b) => a.identity === b.identity && a.venue === b.venue),
          )
        )
          throw new Error(
            p.started_at ? 'EXECUTION_ACCOUNT_CHANGED' : 'EXECUTION_ACCOUNT_ALREADY_USED',
          )
      }
      await query(
        "UPDATE execution_portfolios SET status='running',reason='',close_requested=false,risk_day=CASE WHEN started_at IS NULL THEN to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') ELSE risk_day END,started_at=coalesce(started_at,now()) WHERE track=$1 AND mode=$2",
        [track, mode],
        db,
      )
      await executionEvent(p, 'EXECUTION_STARTED', db)
    })
    return { ok: true }
  })
}
const emptyReceipt: ExecutionReceipt = {
  status: 'rejected',
  externalId: null,
  filledQuantity: '0',
  grossQuote: '0',
  quoteFee: '0',
  baseFee: '0',
}
function checkReceipt(r: ExecutionReceipt, leg: ExecutionLeg) {
  const qty = units(r.filledQuantity),
    quote = units(r.grossQuote)
  if (qty < 0n || qty > units(leg.prepared.intent.quantity) || quote < 0n || units(r.baseFee) > qty)
    throw new Error('EXECUTION_RECEIPT_INVALID')
  units(r.quoteFee)
  units(r.baseFee)
  if (r.networkFee && units(r.networkFee.amount) < 0n) throw new Error('EXECUTION_RECEIPT_INVALID')
  if (
    !['pending', 'filled', 'cancelled', 'rejected', 'unknown'].includes(r.status) ||
    (r.status === 'rejected' &&
      (qty !== 0n || quote !== 0n || units(r.quoteFee) !== 0n || units(r.baseFee) !== 0n)) ||
    (qty > 0n && !r.externalId)
  )
    throw new Error('EXECUTION_RECEIPT_INVALID')
  if (
    leg.receipt &&
    (qty < units(leg.receipt.filledQuantity) || quote < units(leg.receipt.grossQuote))
  )
    throw new Error('EXECUTION_RECEIPT_REGRESSION')
  if (leg.receipt?.externalId && r.externalId !== leg.receipt.externalId)
    throw new Error('EXECUTION_RECEIPT_ID_CHANGED')
}

function receiptOverBudget(receipt: ExecutionReceipt, prepared: PreparedExecution) {
  const spends = ['buy', 'cover', 'supply'].includes(prepared.intent.action)
  if (
    (spends ? units(receipt.grossQuote) : 0n) + units(receipt.quoteFee) >
    units(prepared.intent.quoteBudget)
  )
    return true
  if (
    receipt.networkFee &&
    prepared.intent.venue === 'aave' &&
    prepared.payload.gas &&
    prepared.payload.maxFeePerGas
  ) {
    const gas = BigInt(String(prepared.payload.gas)),
      price = BigInt(String(prepared.payload.maxFeePerGas))
    if (receipt.networkFee.asset !== 'ETH' || units(receipt.networkFee.amount) > gas * price)
      return true
  }
  return false
}

async function settleLeg(
  p: ExecutionPortfolio,
  leg: ExecutionLeg,
  driver: ExecutionDriver,
  isStopping: () => boolean,
) {
  const adapter = driver.adapter(leg.prepared.intent.venue)
  if (leg.state === 'prepared') {
    if (isStopping()) return false
    if (openingForbidden(p) && opening(leg.prepared.intent)) {
      await transaction(async (db) => {
        await query(
          "UPDATE execution_legs SET state='terminal',receipt=$2,settled_at=now() WHERE id=$1 AND state='prepared'",
          [leg.id, emptyReceipt],
          db,
        )
        await executionEvent(p, 'EXECUTION_UNSENT_ORDER_CANCELLED', db)
      })
      return true
    }
    executionWritesAllowed(p.mode, p.track)
    // Mark before sending: a crash at any later instruction is reconciled, never resent.
    await query("UPDATE execution_legs SET state='submitted',submitted_at=now() WHERE id=$1", [
      leg.id,
    ])
    try {
      await adapter.broadcast(leg.prepared)
    } catch (e) {
      if (e instanceof ExecutionRejected) {
        await transaction(async (db) => {
          await query(
            "UPDATE execution_legs SET state='terminal',receipt=$2,settled_at=now() WHERE id=$1",
            [leg.id, emptyReceipt],
            db,
          )
          await executionEvent(p, safeExecutionError(e), db)
        })
        return true
      }
      await query("UPDATE execution_legs SET state='unknown' WHERE id=$1", [leg.id])
    }
  }
  let r = await adapter.lookup(leg.prepared)
  if (
    !r &&
    leg.state !== 'prepared' &&
    leg.prepared.intent.venue === 'aave' &&
    p.mode !== 'paper' &&
    !isStopping() &&
    !(openingForbidden(p) && opening(leg.prepared.intent))
  ) {
    // EVM recovery is the only rebroadcast: the adapter verifies the same signed
    // bytes/hash/nonce. It cannot create a different transfer after a lost ack.
    executionWritesAllowed(p.mode, p.track)
    try {
      await adapter.broadcast(leg.prepared)
    } catch {
      /* Reconcile the original hash even when resend fails. */
    }
    r = await adapter.lookup(leg.prepared)
  }
  if (!r || r.status === 'unknown') {
    await transaction(async (db) => {
      await query("UPDATE execution_legs SET state='unknown' WHERE id=$1", [leg.id], db)
      await query(
        "UPDATE execution_portfolios SET status=CASE WHEN status='stopped' THEN status ELSE 'attention' END,reason=CASE WHEN status='stopped' THEN reason ELSE 'EXECUTION_ORDER_UNKNOWN' END WHERE track=$1 AND mode=$2",
        [p.track, p.mode],
        db,
      )
      if (leg.state !== 'unknown') await executionEvent(p, 'EXECUTION_ORDER_UNKNOWN', db)
    })
    return false
  }
  checkReceipt(r, leg)
  const terminal = ['filled', 'cancelled', 'rejected'].includes(r.status)
  const overBudget = receiptOverBudget(r, leg.prepared)
  await transaction(async (db) => {
    await query(
      'UPDATE execution_legs SET receipt=$2,state=$3,settled_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE id=$1',
      [leg.id, r, terminal ? 'terminal' : 'submitted', terminal],
      db,
    )
    if (overBudget) {
      await query(
        "UPDATE execution_portfolios SET status='stopped',close_requested=true,reason=CASE WHEN status='stopped' THEN reason ELSE 'EXECUTION_FILL_BUDGET_EXCEEDED' END WHERE track=$1 AND mode=$2",
        [p.track, p.mode],
        db,
      )
      if (p.reason !== 'EXECUTION_FILL_BUDGET_EXCEEDED')
        await executionEvent(p, 'EXECUTION_FILL_BUDGET_EXCEEDED', db)
    } else if (terminal && p.reason === 'EXECUTION_ORDER_UNKNOWN') {
      await query(
        "UPDATE execution_portfolios SET status='paused',reason='' WHERE track=$1 AND mode=$2 AND status='attention' AND reason='EXECUTION_ORDER_UNKNOWN'",
        [p.track, p.mode],
        db,
      )
      await executionEvent(p, 'EXECUTION_ORDER_RECONCILED', db)
    }
  })
  return terminal
}

async function runPortfolio(
  p: ExecutionPortfolio,
  driver: ExecutionDriver,
  isStopping: () => boolean,
) {
  await query('UPDATE execution_portfolios SET heartbeat=now() WHERE track=$1 AND mode=$2', [
    p.track,
    p.mode,
  ])
  let [op] = await query<ExecutionOperation>(
    'SELECT * FROM execution_operations WHERE track=$1 AND mode=$2 AND closed_at IS NULL',
    [p.track, p.mode],
  )
  if (!op) {
    if (
      p.status !== 'running' ||
      isStopping() ||
      (p.last_scan && Date.now() - p.last_scan.getTime() < P.scanMs)
    )
      return
    executionWritesAllowed(p.mode, p.track)
    await query('UPDATE execution_portfolios SET last_scan=now() WHERE track=$1 AND mode=$2', [
      p.track,
      p.mode,
    ])
    const [count] = await query<{ n: string }>(
      "SELECT count(*) n FROM execution_operations WHERE track=$1 AND mode=$2 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
      [p.track, p.mode],
    )
    if (Number(count?.n) >= P.maxDailyOperations) return
    if (driver.equity) {
      const mark = units(await driver.equity(p)),
        peak = max(units(p.peak), mark)
      if (
        mark * BPS < peak * (BPS - BigInt(P.drawdownBps)) ||
        (p.risk_day === new Date().toISOString().slice(0, 10) &&
          mark * BPS < units(p.day_equity) * (BPS - BigInt(P.dailyLossBps)))
      ) {
        await query(
          "UPDATE execution_portfolios SET status='stopped',reason='EXECUTION_INVENTORY_LOSS_STOP',equity=$3 WHERE track=$1 AND mode=$2",
          [p.track, p.mode, decimal(mark)],
        )
        return
      }
      await query('UPDATE execution_portfolios SET equity=$3,peak=$4 WHERE track=$1 AND mode=$2', [
        p.track,
        p.mode,
        decimal(mark),
        decimal(peak),
      ])
    }
    const next = await driver.plan(p)
    if (!next) {
      await query(
        "UPDATE execution_portfolios SET reason='EXECUTION_WAITING_OPPORTUNITY' WHERE track=$1 AND mode=$2",
        [p.track, p.mode],
      )
      return
    }
    const reserve = units(next.reserve),
      cap = units(p.capital),
      limit = BigInt(p.track === 'defi' ? P.maxSupplyShareBps : P.maxOrderShareBps)
    if (reserve <= 0n || reserve > units(p.cash) || reserve * BPS > cap * limit)
      throw new Error('EXECUTION_BUDGET_EXCEEDED')
    if (isStopping()) return
    await transaction(async (db) => {
      await query(
        'INSERT INTO execution_operations(id,track,mode,reserve,plan) VALUES($1,$2,$3,$4,$5)',
        [
          randomUUID(),
          p.track,
          p.mode,
          next.reserve,
          { ...next.plan, configuration: executionConfiguration(p.settings) },
        ],
        db,
      )
      await query(
        "UPDATE execution_portfolios SET cash=cash-$3,reason='' WHERE track=$1 AND mode=$2",
        [p.track, p.mode, next.reserve],
        db,
      )
      await executionEvent(p, 'EXECUTION_POSITION_OPENING', db)
    })
    ;[op] = await query<ExecutionOperation>(
      'SELECT * FROM execution_operations WHERE track=$1 AND mode=$2 AND closed_at IS NULL',
      [p.track, p.mode],
    )
  }
  if (!op) return
  const legs = await query<ExecutionLeg>(
    'SELECT * FROM execution_legs WHERE operation_id=$1 ORDER BY sequence',
    [op.id],
  )
  const pending = legs.find((l) => l.state !== 'terminal')
  if (pending) {
    await settleLeg(p, pending, driver, isStopping)
    return
  }
  if (op.status === 'attention') return
  let decision = await driver.decide(
    { ...p, close_requested: p.close_requested || p.status === 'stopped' },
    op,
    legs,
  )
  if (decision.type === 'leg' && openingForbidden(p) && opening(decision.intent)) {
    decision = legs.length
      ? { type: 'attention', reason: 'EXECUTION_CLOSING_OPENING_FORBIDDEN' }
      : { type: 'close', pnl: '0', fees: '0' }
  }
  if (decision.type === 'attention') {
    await transaction(async (db) => {
      await query(
        "UPDATE execution_portfolios SET status=CASE WHEN status='stopped' THEN status ELSE 'attention' END,reason=CASE WHEN status='stopped' THEN reason ELSE $3 END WHERE track=$1 AND mode=$2",
        [p.track, p.mode, decision.reason],
        db,
      )
      await query(
        "UPDATE execution_operations SET status='attention',reason=$2 WHERE id=$1",
        [op.id, decision.reason],
        db,
      )
      await executionEvent(p, decision.reason, db)
    })
    return
  }
  if (decision.type === 'leg') {
    if (isStopping()) return
    if (legs.length >= 24) throw new Error('EXECUTION_LEG_LIMIT')
    executionWritesAllowed(p.mode, p.track)
    const intent = {
      ...decision.intent,
      clientId: randomUUID().replaceAll('-', ''),
      expiresAt: Math.min(decision.intent.expiresAt || Infinity, Date.now() + P.intentLifetimeMs),
    }
    let prepared: PreparedExecution
    let nonce: (string | number | null)[]
    try {
      prepared = await driver.adapter(intent.venue).prepare(intent)
      if (JSON.stringify(prepared.intent) !== JSON.stringify(intent))
        throw new ExecutionRejected('EXECUTION_INTENT_CHANGED')
      nonce = nonceReservation(p, prepared)
    } catch (error) {
      if (!(error instanceof ExecutionRejected)) throw error
      const reason = safeExecutionError(error)
      await transaction(async (db) => {
        await query(
          "INSERT INTO execution_legs(id,operation_id,sequence,role,state,prepared,receipt,settled_at) VALUES($1,$2,$3,$4,'terminal',$5,$6,now())",
          [
            intent.clientId,
            op!.id,
            legs.length,
            decision.role,
            { intent, payload: {}, externalId: null },
            emptyReceipt,
          ],
          db,
        )
        await query(
          "UPDATE execution_operations SET status='attention',reason=$2 WHERE id=$1",
          [op!.id, reason],
          db,
        )
        await query(
          "UPDATE execution_portfolios SET status=CASE WHEN status='stopped' THEN status ELSE 'attention' END,reason=CASE WHEN status='stopped' THEN reason ELSE $3 END WHERE track=$1 AND mode=$2",
          [p.track, p.mode, reason],
          db,
        )
        await executionEvent(p, 'EXECUTION_PREPARE_REJECTED', db)
        await executionEvent(p, reason, db)
      })
      return
    }
    if (isStopping()) return
    await query(
      "INSERT INTO execution_legs(id,operation_id,sequence,role,state,prepared,chain_id,sender,nonce) VALUES($1,$2,$3,$4,'prepared',$5,$6,$7,$8)",
      [intent.clientId, op.id, legs.length, decision.role, prepared, ...nonce],
    )
    const [leg] = await query<ExecutionLeg>('SELECT * FROM execution_legs WHERE id=$1', [
      intent.clientId,
    ])
    await settleLeg(p, leg!, driver, isStopping)
    return
  }
  const pnl = units(decision.pnl),
    fees = units(decision.fees),
    day = new Date().toISOString().slice(0, 10)
  const equity = driver.equity
      ? units(await driver.equity(p))
      : units(p.capital) + units(p.realized) + pnl,
    peak = max(units(p.peak), equity)
  const dayEquity = p.risk_day === day ? units(p.day_equity) : equity
  const risk =
    equity * BPS < peak * (BPS - BigInt(P.drawdownBps))
      ? 'EXECUTION_DRAWDOWN_STOP'
      : equity * BPS < dayEquity * (BPS - BigInt(P.dailyLossBps))
        ? 'EXECUTION_DAILY_LOSS_STOP'
        : ''
  await transaction(async (db) => {
    for (const flow of decision.flows || []) {
      const amount = units(flow.amount)
      if (
        !flow.externalId ||
        flow.externalId.length > 300 ||
        !Number.isSafeInteger(flow.at) ||
        flow.at < 0 ||
        !['funding', 'settlement'].includes(flow.kind) ||
        (flow.kind === 'settlement' && amount < 0n)
      )
        throw new Error('EXECUTION_CASHFLOW_INVALID')
      const existing = await query<{ operation_id: string; amount: string; occurred_at: Date }>(
        `SELECT f.operation_id,f.amount,f.occurred_at FROM execution_cashflows f JOIN execution_operations o ON o.id=f.operation_id
         WHERE o.track=$1 AND o.mode=$2 AND f.kind=$3 AND f.external_id=$4`,
        [p.track, p.mode, flow.kind, flow.externalId],
        db,
      )
      if (
        existing.some(
          (row) =>
            row.operation_id !== op!.id ||
            units(row.amount) !== amount ||
            row.occurred_at.getTime() !== flow.at,
        )
      )
        throw new Error('EXECUTION_CASHFLOW_MISMATCH')
      await query(
        'INSERT INTO execution_cashflows(operation_id,external_id,amount,kind,occurred_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [op.id, flow.externalId, flow.amount, flow.kind, new Date(flow.at)],
        db,
      )
    }
    await query(
      'UPDATE execution_operations SET pnl=$2,fees=$3,status=$4,closed_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1',
      [
        op.id,
        decimal(pnl),
        decimal(fees),
        decision.type === 'close' ? 'closed' : 'open',
        decision.type === 'close',
      ],
      db,
    )
    await query(
      "UPDATE execution_portfolios SET equity=$3,peak=$4,day_equity=$5,risk_day=$6,fees=fees+$7,realized=realized+$8,cash=cash+$9,reason=CASE WHEN status='stopped' THEN reason WHEN $10<>'' THEN $10 ELSE '' END,status=CASE WHEN $10<>'' THEN 'stopped' ELSE status END,close_requested=close_requested OR $10<>'' WHERE track=$1 AND mode=$2",
      [
        p.track,
        p.mode,
        decimal(equity),
        decimal(peak),
        decimal(dayEquity),
        day,
        decimal(fees - units(op.fees)),
        decision.type === 'close' ? decimal(pnl) : '0',
        decision.type === 'close' ? decimal(units(op.reserve) + pnl) : '0',
        risk,
      ],
      db,
    )
    if (decision.type === 'close') await executionEvent(p, 'EXECUTION_POSITION_CLOSED', db)
    if (risk && p.status !== 'stopped') await executionEvent(p, risk, db)
  })
}
export async function executionTick(factory?: ExecutionFactory, isStopping = () => false) {
  try {
    return await executionLock(async () => {
      await ensureExecution()
      const rows = await query<ExecutionPortfolio>(
        'SELECT * FROM execution_portfolios WHERE started_at IS NOT NULL ORDER BY track,mode',
      )
      for (const p of rows) {
        if (isStopping()) break
        try {
          await runPortfolio(p, factory ? factory(p) : await defaultFactory(p), isStopping)
        } catch (e) {
          const reason = safeExecutionError(e)
          await query(
            "UPDATE execution_portfolios SET reason=CASE WHEN status='stopped' THEN reason ELSE $3 END,heartbeat=now() WHERE track=$1 AND mode=$2",
            [p.track, p.mode, reason],
          )
          if (p.reason !== reason) await executionEvent(p, reason)
        }
      }
      return true
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'EXECUTION_BUSY') return false
    throw e
  }
}
