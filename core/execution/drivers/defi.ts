import { EXECUTION_POLICY as P } from '../../policy'
import { BPS, decimal, min, SCALE, units } from '../../trading/decimal'
import {
  createAaveAdapter,
  createAaveExecutionAdapter,
  type AaveRpc,
  type AaveSettings,
} from '../adapters/aave'
import {
  ExecutionRejected,
  type ExecutionAdapter,
  type ExecutionDecision,
  type ExecutionDriver,
  type ExecutionIntent,
  type ExecutionLeg,
  type ExecutionMode,
  type ExecutionOperation,
  type ExecutionPortfolio,
  type ExecutionReceipt,
  type Json,
} from '../types'

export type DefiYieldSource = () => Promise<{ apyBps: number; observedAt: number }>
const yearMs = 365n * 24n * 60n * 60n * 1000n

function virtualAdapter(now: () => number): ExecutionAdapter {
  return {
    async prepare(intent) {
      if (
        intent.venue !== 'aave' ||
        intent.symbol !== 'USDC' ||
        !['approve', 'revoke', 'supply', 'withdraw'].includes(intent.action) ||
        intent.expiresAt <= now()
      )
        throw new ExecutionRejected('EXECUTION_DEFI_INTENT_INVALID')
      const n = units(intent.quantity)
      if (intent.action === 'revoke' ? n !== 0n : n <= 0n)
        throw new ExecutionRejected('EXECUTION_DEFI_AMOUNT_INVALID')
      if (intent.action === 'supply' && n > units(intent.quoteBudget))
        throw new ExecutionRejected('EXECUTION_DEFI_BUDGET')
      if (intent.action === 'withdraw' && n > units(intent.positionQuantity))
        throw new ExecutionRejected('EXECUTION_DEFI_POSITION')
      const approval = intent.action === 'approve' || intent.action === 'revoke'
      const receipt: ExecutionReceipt = {
        status: 'filled',
        externalId: `paper:${intent.clientId}`,
        filledQuantity: approval ? '0' : intent.quantity,
        grossQuote: approval ? '0' : intent.quantity,
        quoteFee: '0',
        baseFee: '0',
      }
      return {
        intent,
        payload: { paper: true, receipt: receipt as unknown as Json },
        externalId: receipt.externalId,
      }
    },
    async broadcast() {},
    async lookup(prepared) {
      return prepared.payload.receipt as unknown as ExecutionReceipt
    },
  }
}

/** Read-only decisions; each approval/supply/redeem is a separate persisted execution leg. */
export function createDefiDriver(
  mode: ExecutionMode,
  settings: AaveSettings | null,
  source?: DefiYieldSource,
  options: { rpc?: AaveRpc; now?: () => number } = {},
): ExecutionDriver {
  const now = options.now || Date.now
  if (mode !== 'paper' && !settings) throw new Error('EXECUTION_WALLET_REQUIRED')
  if (
    mode !== 'paper' &&
    settings &&
    (mode === 'live' ? settings.network !== 'live' : settings.network === 'live')
  )
    throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  if (settings && settings.decimals !== 6) throw new Error('EXECUTION_DEFI_USDC_REQUIRED')
  const chain = mode === 'paper' || !settings ? null : createAaveAdapter(settings, options.rpc)
  const adapter =
    chain && settings
      ? createAaveExecutionAdapter(settings, { symbol: 'USDC', nativeAsset: 'ETH' }, options.rpc)
      : virtualAdapter(now)
  const factor = SCALE / 1_000_000n
  const atomic = (n: bigint) => (n / factor) * factor
  function assertScope(p: ExecutionPortfolio) {
    if (p.track !== 'defi' || p.mode !== mode) throw new Error('EXECUTION_SCOPE_MISMATCH')
  }
  function leg(
    action: 'approve' | 'revoke' | 'supply' | 'withdraw',
    qty: bigint,
    op: ExecutionOperation,
    supplied = 0n,
  ): ExecutionDecision {
    return {
      type: 'leg',
      role: action,
      intent: {
        clientId: '',
        venue: 'aave',
        action,
        symbol: 'USDC',
        quantity: decimal(qty),
        limitPrice: '1',
        quoteBudget: op.reserve,
        positionQuantity: decimal(supplied),
        expiresAt: now() + P.intentLifetimeMs,
      },
    }
  }
  function filled(legs: ExecutionLeg[], action: string) {
    return legs.filter(
      (item) => item.prepared.intent.action === action && item.receipt?.status === 'filled',
    )
  }
  function sum(legs: ExecutionLeg[]) {
    return legs.reduce((n, item) => n + units(item.receipt!.filledQuantity), 0n)
  }
  function virtualSupply(op: ExecutionOperation, supplied: ExecutionLeg[], redeemed: bigint) {
    const principal = sum(supplied)
    if (!supplied.length || redeemed >= principal) return 0n
    // Paper estimates interest at the entry APY over elapsed time. It is never real revenue.
    const elapsed = BigInt(Math.max(0, now() - supplied[0]!.created_at.getTime()))
    const interest = (principal * units(op.plan.rate) * elapsed) / SCALE / yearMs
    return atomic(principal + interest - redeemed)
  }
  return {
    async accounts(p) {
      assertScope(p)
      if (!chain || !settings) return [{ identity: 'paper:aave', venue: 'aave' }]
      await chain.verifyDeployment()
      const b = await chain.balances()
      if (b.debt !== 0n || (!p.started_at && b.supplied !== 0n))
        throw new Error('EXECUTION_DEFI_DEDICATED_WALLET_REQUIRED')
      if (!p.started_at && b.wallet * factor < units(p.capital))
        throw new Error('EXECUTION_DEFI_BALANCE')
      if (b.native < settings.maxGasCostWei * (p.started_at ? 1n : 3n))
        throw new Error('EXECUTION_DEFI_GAS_BALANCE')
      return [
        { identity: `aave:${settings.chainId}:${settings.sender.toLowerCase()}`, venue: 'aave' },
      ]
    },
    async plan(p) {
      assertScope(p)
      if (p.close_requested || (!source && !chain)) return null
      const quote = source
        ? await source()
        : { apyBps: await chain!.reserveRateBps(), observedAt: now() }
      if (
        !Number.isInteger(quote.apyBps) ||
        quote.apyBps <= 0 ||
        quote.apyBps > 20_000 ||
        !Number.isSafeInteger(quote.observedAt) ||
        quote.observedAt > now() + 2_000 ||
        now() - quote.observedAt > P.defiYieldMaxAgeMs
      )
        return null
      const cap = min((units(p.capital) * BigInt(P.maxSupplyShareBps)) / BPS, units(p.cash))
      let qty = atomic(cap)
      if (chain && settings) {
        await chain.verifyDeployment()
        const b = await chain.balances()
        if (b.debt !== 0n || b.supplied !== 0n)
          throw new Error('EXECUTION_DEFI_DEDICATED_WALLET_REQUIRED')
        qty = min(qty, min(b.wallet, settings.maxAmountAtoms) * factor)
      }
      if (qty < units(P.minOrder)) return null
      return {
        reserve: decimal(qty),
        plan: {
          symbol: 'USDC',
          quantity: decimal(qty),
          entryPrice: '1',
          hedgePrice: '1',
          buyVenue: 'aave',
          sellVenue: 'aave',
          outcome: 'yes',
          rate: decimal((BigInt(quote.apyBps) * SCALE) / BPS),
          nextPaymentAt: 0,
          intervalMs: 0,
        },
      }
    },
    async decide(p, op, legs) {
      assertScope(p)
      if (op.track !== 'defi' || op.mode !== mode || op.plan.symbol !== 'USDC')
        throw new Error('EXECUTION_SCOPE_MISMATCH')
      if (legs.some((item) => item.state === 'unknown' || item.receipt?.status === 'unknown'))
        return { type: 'attention', reason: 'EXECUTION_DEFI_UNCERTAIN_TRANSACTION' }
      if (legs.some((item) => item.state !== 'terminal'))
        return { type: 'hold', pnl: op.pnl, fees: op.fees }
      const supplies = filled(legs, 'supply')
      const withdrawals = filled(legs, 'withdraw')
      const principal = sum(supplies)
      const redeemed = sum(withdrawals)
      let balance = virtualSupply(op, supplies, redeemed)
      let allowance = 0n
      if (chain) {
        await chain.verifyDeployment()
        const actual = await chain.balances()
        if (actual.debt !== 0n) return { type: 'attention', reason: 'EXECUTION_AAVE_DEBT_PRESENT' }
        balance = actual.supplied * factor
        allowance = actual.allowance * factor
      } else {
        for (const item of legs) {
          if (item.receipt?.status !== 'filled') continue
          switch (item.prepared.intent.action) {
            case 'approve':
              allowance = units(item.prepared.intent.quantity)
              break
            case 'revoke':
            case 'supply':
              allowance = 0n
              break
          }
        }
      }
      const last = legs.at(-1)
      if (last && last.receipt?.status !== 'filled') {
        if (last.prepared.intent.action === 'approve' || last.prepared.intent.action === 'revoke')
          return { type: 'attention', reason: 'EXECUTION_DEFI_APPROVAL_FAILED' }
        if (last.prepared.intent.action === 'withdraw')
          return { type: 'attention', reason: 'EXECUTION_DEFI_WITHDRAW_FAILED' }
        // A confirmed revert is not a deposit. Clear any leftover permission before closing.
        if (allowance > 0n) return leg('revoke', 0n, op)
        return { type: 'close', pnl: '0', fees: '0' }
      }
      if (!supplies.length) {
        if (balance !== 0n) return { type: 'attention', reason: 'EXECUTION_DEFI_FOREIGN_POSITION' }
        const cancelled =
          p.close_requested ||
          p.status !== 'running' ||
          legs.some((item) => item.prepared.intent.action === 'supply')
        if (cancelled) {
          if (allowance > 0n) return leg('revoke', 0n, op)
          return { type: 'close', pnl: '0', fees: '0' }
        }
        const qty = units(op.plan.quantity)
        if (allowance !== 0n && allowance !== qty) return leg('revoke', 0n, op)
        if (allowance === 0n) return leg('approve', qty, op)
        return leg('supply', qty, op)
      }
      const pnl = redeemed + balance - principal
      const heldMs = now() - supplies[0]!.created_at.getTime()
      const stop = pnl < 0n && -pnl * BPS >= principal * BigInt(P.positionLossBps)
      const closing =
        p.close_requested ||
        p.status !== 'running' ||
        stop ||
        withdrawals.length > 0 ||
        heldMs >= p.settings.maxHoldHours * 60 * 60 * 1000
      if (!closing) return { type: 'hold', pnl: decimal(pnl), fees: '0' }
      if (balance > 0n) {
        if (withdrawals.length >= P.maxRepairLegs)
          return { type: 'attention', reason: 'EXECUTION_DEFI_REMAINING_SUPPLY' }
        const qty = settings && chain ? min(balance, settings.maxAmountAtoms * factor) : balance
        return leg('withdraw', qty, op, balance)
      }
      if (allowance > 0n) return leg('revoke', 0n, op)
      return { type: 'close', pnl: decimal(redeemed - principal), fees: '0' }
    },
    adapter(venue) {
      if (venue !== 'aave') throw new Error('EXECUTION_VENUE_MISMATCH')
      return adapter
    },
  }
}
