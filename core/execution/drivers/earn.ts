import { EXECUTION_POLICY as P } from '../../policy'
import { BPS, decimal, min, units } from '../../trading/decimal'
import { earnVenue } from '../venues'
import type {
  ExecutionAdapter,
  ExecutionDecision,
  ExecutionDriver,
  ExecutionExchange,
  ExecutionFlow,
  ExecutionIntent,
  ExecutionLeg,
  ExecutionMode,
  ExecutionOperation,
  ExecutionPortfolio,
  ExecutionReceipt,
  Json,
} from '../types'

export type EarnClient = {
  identity(): Promise<string>
  available(): Promise<bigint>
  subscribe(asset: string, amount: bigint): Promise<ExecutionReceipt>
  redeem(asset: string, amount: bigint): Promise<ExecutionReceipt>
  rateBps(): Promise<number>
}

function paperReceipt(intent: ExecutionIntent): ExecutionReceipt {
  return {
    status: 'filled',
    externalId: `paper:${intent.clientId}`,
    filledQuantity: intent.quantity,
    grossQuote: intent.quantity,
    quoteFee: '0',
    baseFee: '0',
  }
}

export function createEarnDriver(
  mode: ExecutionMode,
  exchange: ExecutionExchange,
  client?: EarnClient,
  now: () => number = Date.now,
): ExecutionDriver {
  if (exchange === 'bitget') throw new Error('EXECUTION_EARN_VENUE_UNSUPPORTED')
  const venue = earnVenue(exchange)
  const paper: ExecutionAdapter = {
    async prepare(intent) {
      if (!['subscribe', 'redeem'].includes(intent.action)) throw new Error('EXECUTION_ACTION_INVALID')
      const receipt = paperReceipt(intent)
      return { intent, externalId: receipt.externalId, payload: { receipt: receipt as unknown as Json } }
    },
    async broadcast() {},
    async lookup(prepared) {
      return prepared.payload.receipt as unknown as ExecutionReceipt
    },
  }
  const live: ExecutionAdapter = {
    async prepare(intent) {
      if (!client) throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
      return { intent, externalId: null, payload: { amount: intent.quantity, asset: intent.symbol } }
    },
    async broadcast(prepared) {
      if (!client) throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
      const amount = units(prepared.intent.quantity)
      const receipt =
        prepared.intent.action === 'subscribe'
          ? await client.subscribe(prepared.intent.symbol, amount)
          : await client.redeem(prepared.intent.symbol, amount)
      prepared.payload.receipt = receipt as never
      prepared.externalId = receipt.externalId
    },
    async lookup(prepared) {
      return (prepared.payload.receipt as unknown as ExecutionReceipt) || null
    },
  }
  const execution = mode === 'paper' ? paper : live

  function yieldFlow(op: ExecutionOperation, principal: bigint): ExecutionFlow[] {
    const elapsed = now() - op.created_at.getTime()
    if (elapsed < P.earn.minHoldMs) return []
    const amount = (principal * BigInt(P.earn.paperApyBps) * BigInt(elapsed)) / (BPS * 365n * 24n * 60n * 60n * 1000n)
    if (amount <= 0n) return []
    return [{ externalId: `paper-yield:${op.id}`, kind: 'yield', amount: decimal(amount), at: now() }]
  }

  return {
    adapter(selected) {
      if (selected !== venue) throw new Error('EXECUTION_VENUE_MISMATCH')
      return execution
    },
    async accounts(p) {
      if (mode === 'paper') return [{ identity: `${venue}:paper:virtual`, venue }]
      if (!client) throw new Error('EXECUTION_CREDENTIALS_REQUIRED')
      const available = await client.available()
      if (!p.started_at && available < units(p.capital)) throw new Error('EXECUTION_INSUFFICIENT_BALANCE')
      return [{ identity: await client.identity(), venue }]
    },
    async plan(p) {
      const budget = min(units(p.cash), (units(p.capital) * BigInt(P.maxOrderShareBps)) / BPS)
      if (budget < units(P.minOrder)) return null
      return {
        reserve: decimal(budget),
        plan: {
          symbol: 'USDT',
          quantity: decimal(budget),
          entryPrice: '1',
          hedgePrice: '0',
          buyVenue: venue,
          sellVenue: venue,
          outcome: 'yes',
          rate: decimal(BigInt(P.earn.paperApyBps)),
          nextPaymentAt: now() + P.earn.minHoldMs,
          intervalMs: P.earn.minHoldMs,
        },
      }
    },
    async decide(p, op, legs: ExecutionLeg[]): Promise<ExecutionDecision> {
      if (legs.some((item) => item.state !== 'terminal' || !item.receipt || ['unknown', 'pending'].includes(item.receipt.status)))
        return { type: 'attention', reason: 'EXECUTION_ORDER_UNKNOWN' }
      const subscribed = legs
        .filter((item) => item.prepared.intent.action === 'subscribe' && item.receipt)
        .reduce((total, item) => total + units(item.receipt!.filledQuantity), 0n)
      const redeemed = legs
        .filter((item) => item.prepared.intent.action === 'redeem' && item.receipt)
        .reduce((total, item) => total + units(item.receipt!.filledQuantity), 0n)
      const open = subscribed - redeemed
      const flows = yieldFlow(op, subscribed)
      const income = flows.reduce((total, item) => total + units(item.amount), 0n)
      const intent = (role: string, action: 'subscribe' | 'redeem', qty: bigint) =>
        ({
          type: 'leg' as const,
          role,
          intent: {
            clientId: '',
            venue,
            action,
            symbol: 'USDT',
            quantity: decimal(qty),
            limitPrice: '1',
            quoteBudget: decimal(qty),
            positionQuantity: decimal(open),
            expiresAt: now() + P.intentLifetimeMs,
          },
        }) satisfies ExecutionDecision
      if (!legs.length) {
        if (p.close_requested) return { type: 'close', pnl: '0', fees: '0' }
        return intent('open', 'subscribe', units(op.plan.quantity))
      }
      const due = now() - op.created_at.getTime() >= p.settings.maxHoldHours * 60 * 60_000 || p.close_requested
      if (open > 0n && due) return intent('close', 'redeem', open)
      if (open <= 0n) return { type: 'close', pnl: decimal(income), fees: '0', flows }
      return { type: 'hold', pnl: decimal(income), fees: '0', flows }
    },
  }
}
