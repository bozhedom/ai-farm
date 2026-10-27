import { z } from 'zod'
import { audit, pool, query, transaction, type Connection } from '../db'
import { WALLET_POLICY } from '../policy'
import type { WalletClassification, WalletKeyStatus } from '../contracts/wallet'
import {
  assertReadOnly,
  walletCredentials,
  WalletClient,
  type WalletCredentials,
  type WalletTransport,
} from './bybit'
import { fromMinor, parseInternal, parseOnchain, type DepositRecord } from './math'
import { paymentAddress } from './view'

/**
 * The `wallet` worker loop: checks that the Bybit key is read-only, then stores deposits
 * idempotently. Coverage walks forward from `synced_through` in Bybit's 30-day windows so a
 * long outage does not permanently drop successful deposits. Deposits start "unclassified";
 * only the owner decides what is income.
 */
export type WalletDeps = {
  transport?: WalletTransport
  credentials?: WalletCredentials | null
  now?: Date
}

async function setKey(status: WalletKeyStatus, error = '', db: Connection = pool) {
  const [before] = await query(
    `INSERT INTO wallet_sync(id,key_status,key_error,key_checked_at) VALUES(true,$1,$2,now())
     ON CONFLICT(id) DO UPDATE SET key_status=$1,key_error=$2,key_checked_at=now()
     RETURNING (SELECT key_status FROM wallet_sync WHERE id) AS previous`,
    [status, error],
    db,
  )
  return before?.previous as WalletKeyStatus | undefined
}
const code = (error: unknown) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
    ? error.message
    : 'WALLET_FAILED'

/** Checks the key and records the result. Throws WALLET_KEY_NOT_READ_ONLY for a writable key. */
export async function checkWalletKey(deps: WalletDeps = {}) {
  const credentials = deps.credentials === undefined ? walletCredentials() : deps.credentials
  if (!credentials) {
    await setKey('not_configured')
    return { status: 'not_configured' as const, client: null }
  }
  const client = new WalletClient(credentials, deps.transport)
  try {
    const info = await client.keyInfo()
    assertReadOnly(info)
  } catch (error) {
    const reason = code(error)
    const rejected = reason === 'WALLET_KEY_NOT_READ_ONLY'
    const previous = await setKey(rejected ? 'rejected' : 'error', reason)
    if (rejected && previous !== 'rejected')
      await audit(
        'wallet_key_rejected',
        'Ключ кошелька Bybit отклонён: у него есть права не только на чтение. Поступления не читаются.',
        { reason },
      )
    throw new Error(reason)
  }
  const previous = await setKey('read_only')
  if (previous !== 'read_only')
    await audit('wallet_key_accepted', 'Ключ кошелька Bybit проверен: только чтение.')
  return { status: 'read_only' as const, client }
}

async function store(record: DepositRecord, db: Connection) {
  const expected = paymentAddress()
  const toAddress = record.raw.toAddress || ''
  const addressMismatch =
    !!expected &&
    record.source === 'onchain' &&
    !!toAddress &&
    toAddress.toLowerCase() !== expected.address.toLowerCase()

  const [row] = await query(
    `WITH prev AS (SELECT status FROM wallet_deposits WHERE source=$1 AND external_id=$2)
     INSERT INTO wallet_deposits(source,external_id,tx_id,coin,chain,amount,amount_minor,decimals,
       status,raw_status,confirmations,success_at,raw)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT(source,external_id) DO UPDATE SET tx_id=EXCLUDED.tx_id,coin=EXCLUDED.coin,
       chain=EXCLUDED.chain,amount=EXCLUDED.amount,amount_minor=EXCLUDED.amount_minor,
       decimals=EXCLUDED.decimals,status=EXCLUDED.status,raw_status=EXCLUDED.raw_status,
       confirmations=EXCLUDED.confirmations,success_at=EXCLUDED.success_at,raw=EXCLUDED.raw,
       updated_at=now()
     WHERE (wallet_deposits.tx_id,wallet_deposits.coin,wallet_deposits.chain,wallet_deposits.amount,
       wallet_deposits.status,wallet_deposits.raw_status,wallet_deposits.confirmations,
       wallet_deposits.success_at,wallet_deposits.raw)
       IS DISTINCT FROM (EXCLUDED.tx_id,EXCLUDED.coin,EXCLUDED.chain,EXCLUDED.amount,
       EXCLUDED.status,EXCLUDED.raw_status,EXCLUDED.confirmations,EXCLUDED.success_at,EXCLUDED.raw)
     RETURNING id,(SELECT status FROM prev) AS previous`,
    [
      record.source,
      record.externalId,
      record.txId,
      record.coin,
      record.chain,
      record.amount,
      record.minor.toString(),
      record.decimals,
      record.status,
      record.rawStatus,
      record.confirmations,
      record.successAt,
      record.raw,
    ],
    db,
  )
  // Newly successful: one feed line, so the owner sees the payment and can classify it.
  if (row && record.status === 'success' && row.previous !== 'success') {
    const mismatchNote = addressMismatch
      ? ` Адрес (${toAddress}) не совпадает с опубликованным ${expected!.network} ${expected!.address}.`
      : ''
    await audit(
      addressMismatch ? 'wallet_deposit_address_mismatch' : 'wallet_deposit',
      `Поступление на кошелёк Bybit: ${fromMinor(record.minor, record.decimals)} ${record.coin}` +
        `${record.chain ? ` (${record.chain})` : ''}.${mismatchNote} Отметьте: доход или перевод себе.`,
      {
        deposit: row.id,
        coin: record.coin,
        amount: record.amount,
        source: record.source,
        ...(addressMismatch ? { toAddress, expected: expected!.address } : {}),
      },
      db,
    )
  }
  return !!row
}

/** Windows of [start, end] ms to fetch, walking forward from the coverage cursor. */
export function syncWindows(end: number, syncedThroughMs: number | null) {
  const { windowMs, overlapMs, maxWindowsPerTick } = WALLET_POLICY
  // Already covered through `end` (same tick or clock skew): nothing to fetch.
  if (syncedThroughMs != null && syncedThroughMs >= end)
    return [] as { start: number; end: number }[]
  // First run covers the latest Bybit-sized window. Later runs resume from the cursor with overlap.
  let from =
    syncedThroughMs == null ? end - windowMs + overlapMs : Math.max(0, syncedThroughMs - overlapMs)
  const windows: { start: number; end: number }[] = []
  for (let i = 0; i < maxWindowsPerTick && from < end; i++) {
    const to = Math.min(from + windowMs - overlapMs, end)
    if (to <= from) break
    windows.push({ start: from, end: to })
    from = to
  }
  return windows
}

/** One pass of the `wallet` loop. Returns counts; throws a code when anything went wrong. */
export async function walletTick(deps: WalletDeps = {}) {
  const { status, client } = await checkWalletKey(deps)
  if (!client) return { status, seen: 0, changed: 0 }
  const end = (deps.now ?? new Date()).getTime()
  const [state] = await query<{ synced_through: Date | null }>(
    'SELECT synced_through FROM wallet_sync WHERE id=true',
  )
  const windows = syncWindows(end, state?.synced_through?.getTime() ?? null)
  let errorCode = ''
  let seen = 0
  let changed = 0
  let coveredThrough = state?.synced_through?.getTime() ?? null
  try {
    for (const window of windows) {
      const onchain = await client.pages('/v5/asset/deposit/query-record', window.start, window.end)
      const internal = await client.pages(
        '/v5/asset/deposit/query-internal-record',
        window.start,
        window.end,
      )
      const records: DepositRecord[] = []
      for (const [rows, parse] of [
        [onchain, parseOnchain],
        [internal, parseInternal],
      ] as const)
        for (const raw of rows) {
          try {
            const record = parse(raw)
            if (record) records.push(record)
          } catch (error) {
            // One unreadable row must not hide the others; the loop still reports the code.
            errorCode ||= code(error)
          }
        }
      seen += records.length
      await transaction(async (db) => {
        for (const record of records) if (await store(record, db)) changed++
      })
      coveredThrough = window.end
      if (errorCode) break
    }
  } catch (error) {
    errorCode = code(error)
  }
  if (errorCode) {
    await query(
      `INSERT INTO wallet_sync(id,sync_error,sync_error_at,synced_through) VALUES(true,$1,now(),$2)
       ON CONFLICT(id) DO UPDATE SET sync_error=$1,sync_error_at=now(),
         synced_through=COALESCE($2,wallet_sync.synced_through)`,
      [errorCode, coveredThrough != null ? new Date(coveredThrough) : null],
    )
    throw new Error(errorCode)
  }
  await query(
    `INSERT INTO wallet_sync(id,synced_at,sync_error,rows_seen,synced_through)
     VALUES(true,now(),'',$1,$2)
     ON CONFLICT(id) DO UPDATE SET synced_at=now(),sync_error='',rows_seen=$1,synced_through=$2`,
    [seen, coveredThrough != null ? new Date(coveredThrough) : new Date(end)],
  )
  return { status, seen, changed }
}

export const classificationSchema = z
  .object({ classification: z.enum(['income', 'not_income', 'unclassified']) })
  .strict()
const words: Record<WalletClassification, string> = {
  income: 'доход',
  not_income: 'не доход',
  unclassified: 'не разобрано',
}

/** Owner decision on one successful deposit. Audited; repeating the same choice changes nothing. */
export async function classifyDeposit(id: string, classification: WalletClassification) {
  if (!z.uuid().safeParse(id).success) throw new Error('WALLET_DEPOSIT_NOT_FOUND')
  return transaction(async (db) => {
    const [row] = await query(
      'SELECT id,status,classification,coin,amount,source FROM wallet_deposits WHERE id=$1 FOR UPDATE',
      [id],
      db,
    )
    if (!row) throw new Error('WALLET_DEPOSIT_NOT_FOUND')
    if (row.status !== 'success') throw new Error('WALLET_DEPOSIT_NOT_FINAL')
    if (row.classification === classification) return { id, classification, changed: false }
    await query(
      'UPDATE wallet_deposits SET classification=$2,classified_at=now() WHERE id=$1',
      [id, classification],
      db,
    )
    await audit(
      'wallet_deposit_classified',
      `Поступление ${row.amount} ${row.coin}: владелец отметил «${words[classification]}».`,
      { deposit: id, from: row.classification, to: classification },
      db,
    )
    return { id, classification, changed: true }
  })
}
