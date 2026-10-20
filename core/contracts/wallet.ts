/**
 * Deposits to the owner's Bybit account (`GET /api/office/wallet`, and `wallet` in the income
 * overview). Amounts are exact decimal strings in their own coin; never converted to rubles.
 * Only deposits the owner marked "income" are real income; "unclassified" is shown separately.
 */
export type WalletClassification = 'unclassified' | 'income' | 'not_income'
/** unchecked: credentials are set, the worker has not checked them yet. */
export type WalletKeyStatus = 'not_configured' | 'unchecked' | 'read_only' | 'rejected' | 'error'
export type WalletAmount = { coin: string; amount: string }

export type WalletTotals = {
  income: WalletAmount[]
  unclassified: WalletAmount[]
  notIncome: WalletAmount[]
}

export type WalletDeposit = {
  id: string
  source: 'onchain' | 'internal'
  coin: string
  chain: string
  amount: string
  status: 'pending' | 'success' | 'failed'
  confirmations: string
  txId: string
  /** Sender of an internal Bybit transfer (UID, email or phone as Bybit shows it). */
  from: string
  successAt: string | null
  firstSeenAt: string
  classification: WalletClassification
}

export type OfficeWallet = {
  /** The published deposit address; null when PAYMENT_USDT_* is not set. */
  address: { address: string; network: string; memo: string } | null
  keyConfigured: boolean
  keyStatus: WalletKeyStatus
  keyError: string
  keyCheckedAt: string | null
  lastSyncAt: string | null
  syncError: string
  periods: Record<'today' | 'week' | 'month' | 'all', WalletTotals>
  unclassifiedCount: number
  recent: WalletDeposit[]
}
