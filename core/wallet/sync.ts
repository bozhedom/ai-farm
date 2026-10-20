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

/**
 * The `wallet` worker loop: checks that the Bybit key is read-only, then stores the last 30 days
 * of deposits idempotently. Deposits start "unclassified"; only the owner decides what is income.
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
  if (row && record.status === 'success' && row.previous !== 'success')
    await audit(
      'wallet_deposit',
      `Поступление на кошелёк Bybit: ${fromMinor(record.minor, record.decimals)} ${record.coin}` +
        `${record.chain ? ` (${record.chain})` : ''}. Отметьте: доход или перевод себе.`,
      { deposit: row.id, coin: record.coin, amount: record.amount, source: record.source },
      db,
    )
  return !!row
}

/** One pass of the `wallet` loop. Returns counts; throws a code when anything went wrong. */
export async function walletTick(deps: WalletDeps = {}) {
  const { status, client } = await checkWalletKey(deps)
  if (!client) return { status, seen: 0, changed: 0 }
  const end = (deps.now ?? new Date()).getTime()
  // Bybit allows at most 30 days per request; keep a minute of margin.
  const start = end - WALLET_POLICY.windowMs + 60_000
  let errorCode = ''
  let seen = 0
  let changed = 0
  try {
    const onchain = await client.pages('/v5/asset/deposit/query-record', start, end)
    const internal = await client.pages('/v5/asset/deposit/query-internal-record', start, end)
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
    seen = records.length
    await transaction(async (db) => {
      for (const record of records) if (await store(record, db)) changed++
    })
  } catch (error) {
    errorCode = code(error)
  }
  if (errorCode) {
    await query(
      `INSERT INTO wallet_sync(id,sync_error,sync_error_at) VALUES(true,$1,now())
       ON CONFLICT(id) DO UPDATE SET sync_error=$1,sync_error_at=now()`,
      [errorCode],
    )
    throw new Error(errorCode)
  }
  await query(
    `INSERT INTO wallet_sync(id,synced_at,sync_error,rows_seen) VALUES(true,now(),'',$1)
     ON CONFLICT(id) DO UPDATE SET synced_at=now(),sync_error='',rows_seen=$1`,
    [seen],
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
