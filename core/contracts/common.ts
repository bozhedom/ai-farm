/**
 * Shared API contracts for the public site (slice A), the farm (slice B) and the owner office
 * frontend (stream C). Types only: no runtime code, no imports from server modules.
 * Fields are added only by agreement; existing fields are never renamed or removed.
 */

/** Integer kopecks only. Test payments are never revenue. */
export type Money = { kopecks: number; currency: 'RUB' }

/** Crypto only: Sepolia test network, or the explicit sandbox fallback for a demo. */
export type PaymentMode = 'sandbox' | 'sepolia'

/** What a buyer sees about an order. Owner-only states map onto these. */
export type PublicOrderStatus =
  | 'awaiting_payment'
  | 'checking_payment'
  | 'in_progress'
  | 'delivered'
  | 'needs_attention'
  | 'expired'
  | 'closed'

/** One step of the buyer-facing order timeline. `at` is an ISO timestamp. */
export type OrderStep = { label: string; at: string | null; done: boolean }

/** Server-validated product page. Plain text only, no HTML. */
export type ProductPage = {
  headline?: string
  forWhom?: string[]
  youGet?: string[]
  limits?: string[]
}

/** `test` is always true: sandbox and Sepolia test ETH are never revenue. */
export type PaymentModeInfo = { mode: PaymentMode; test: boolean; label: string }
