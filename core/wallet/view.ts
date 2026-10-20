import { config } from '../config'
import { query } from '../db'
import { WALLET_POLICY } from '../policy'
import type { OfficeWallet, WalletKeyStatus } from '../contracts/wallet'
import { walletCredentials } from './bybit'
import { walletPeriods } from './math'

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null)

/** The deposit address that may be given to foreign clients, or null when not configured. */
export function paymentAddress() {
  const c = config()
  return c.PAYMENT_USDT_ADDRESS && c.PAYMENT_USDT_NETWORK
    ? {
        address: c.PAYMENT_USDT_ADDRESS,
        network: c.PAYMENT_USDT_NETWORK,
        memo: c.PAYMENT_USDT_MEMO,
      }
    : null
}

/** Owner view of the Bybit wallet: key state, totals by classification and recent deposits. */
export async function walletView(now = new Date()): Promise<OfficeWallet> {
  const [[state], days, [counts], recent] = await Promise.all([
    query('SELECT * FROM wallet_sync WHERE id=true'),
    query(
      `SELECT coin,decimals,classification,to_char(success_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
        sum(amount_minor)::text AS minor
       FROM wallet_deposits WHERE status='success' GROUP BY 1,2,3,4`,
    ),
    query(
      `SELECT count(*)::int AS n FROM wallet_deposits
       WHERE status='success' AND classification='unclassified'`,
    ),
    query(
      `SELECT id,source,coin,chain,amount,status,confirmations,tx_id,raw,success_at,first_seen_at,
        classification
       FROM wallet_deposits ORDER BY coalesce(success_at,first_seen_at) DESC,id LIMIT $1`,
      [WALLET_POLICY.recentRows],
    ),
  ])
  const keyConfigured = !!walletCredentials()
  // The table may describe an older key: without credentials now, nothing is configured.
  const keyStatus: WalletKeyStatus = keyConfigured
    ? ((state?.key_status as WalletKeyStatus | undefined) ?? 'not_configured')
    : 'not_configured'
  return {
    address: paymentAddress(),
    keyConfigured,
    keyStatus: keyConfigured && keyStatus === 'not_configured' ? 'unchecked' : keyStatus,
    keyError: keyConfigured ? String(state?.key_error ?? '') : '',
    keyCheckedAt: keyConfigured ? iso(state?.key_checked_at) : null,
    lastSyncAt: iso(state?.synced_at),
    syncError: keyConfigured ? String(state?.sync_error ?? '') : '',
    periods: walletPeriods(
      days.map((r) => ({
        coin: r.coin,
        decimals: r.decimals,
        classification: r.classification,
        day: r.day,
        minor: BigInt(r.minor),
      })),
      now,
    ),
    unclassifiedCount: counts?.n ?? 0,
    recent: recent.map((r) => ({
      id: r.id,
      source: r.source,
      coin: r.coin,
      chain: r.chain,
      amount: r.amount,
      status: r.status,
      confirmations: r.confirmations,
      txId: r.tx_id,
      from: r.source === 'internal' ? String(r.raw?.from ?? '') : '',
      successAt: iso(r.success_at),
      firstSeenAt: iso(r.first_seen_at)!,
      classification: r.classification,
    })),
  }
}
