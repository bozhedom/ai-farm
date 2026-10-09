/**
 * Public buyer API contracts (`/api/public/**`). No owner session.
 * Buyers never see model names, agents, costs, QA reasons or other buyers' orders.
 */
import type { PaymentModeInfo, ProductPage, PublicOrderStatus } from './common'

export type { PublicOrderStatus } from './common'

export type PublicService = {
  slug: string
  name: string
  category: string
  audience: string
  promise: string
  inputLabel: string
  example: string
  inputLimit: number
  priceKopecks: number
  currency: 'RUB' | 'TEST_ETH'
  page: ProductPage
  /** Slice A: a short example for the input placeholder. */
  placeholder?: string
  /** Slice A: the control example that passed the check: what was sent and what came out. */
  sample?: { input: string; output: string }
}
export type PublicCatalog = {
  services: PublicService[]
  payment: PaymentModeInfo
  acceptingOrders: boolean
  notice: string | null
  seller: { name: string; contact: string; termsUrl: string | null } | null
}
/** Slice A: `GET /api/public/services/[slug]`. */
export type PublicServicePage = Omit<PublicCatalog, 'services'> & { service: PublicService }
export type PublicOrderCreate = {
  slug: string
  input: string
  requestKey: string
  /** Slice A: the buyer ticked "I have the rights to this text". The server requires true. */
  rightsConfirmed?: boolean
}
export type PublicOrderCreated = { orderId: string; token: string; url: string }
export type PublicOrderView = {
  id: string
  /** Added by the UX pass: short order number, «Заказ №1042». */
  number?: number
  status: PublicOrderStatus
  service: { slug: string; name: string; promise: string }
  price: { kopecks: number; currency: 'RUB' | 'TEST_ETH'; test: boolean }
  payment:
    | {
        mode: 'sandbox'
        /** False unless PUBLIC_SANDBOX_PAY: then the owner confirms the test payment. */
        canConfirm: boolean
      }
    | {
        mode: 'sepolia'
        chainId: number
        receiver: string
        amountWei: string
        /** Decimal string of the exact wei amount, for display only. */
        amountEth: string
        /** EIP-681 link for wallets and QR codes: ethereum:<receiver>@11155111?value=<wei> */
        paymentUri: string
        hash: string | null
        confirmations: number
        required: number
        canSubmit: boolean
        /** True when the worker found the transfer by scanning blocks, without a submitted hash. */
        detectedAutomatically: boolean
        /** Slice A: 'local' is an anvil node imitating Sepolia for tests and demos. */
        network?: 'sepolia' | 'local'
        /** Slice A: block explorer link for the buyer's own transfer, public Sepolia only. */
        explorerUrl?: string | null
      }
  steps: { label: string; at: string | null; done: boolean }[]
  message: { title: string; detail: string; tone: 'good' | 'warn' }
  result: { text: string; downloadUrl: string } | null
  createdAt: string
  expiresAt: string
  contact: string | null
  /** Slice A: first lines of the buyer's own text, for the order summary. */
  inputPreview?: string
}
export type PublicPayRequest = { mode: 'sandbox' } | { mode: 'sepolia'; hash: string }
export type PublicPayResponse = { ok: true }
