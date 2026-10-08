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
  version: number
  isDemo: boolean
  page: ProductPage
}
export type PublicCatalog = {
  services: PublicService[]
  payment: PaymentModeInfo
  acceptingOrders: boolean
  notice: string | null
  seller: { name: string; contact: string; termsUrl: string | null } | null
}
export type PublicOrderCreate = { slug: string; input: string; requestKey: string }
export type PublicOrderCreated = { orderId: string; token: string; url: string }
export type PublicOrderView = {
  id: string
  status: PublicOrderStatus
  service: { slug: string; name: string; promise: string; version: number }
  price: { kopecks: number; currency: 'RUB' | 'TEST_ETH'; test: boolean }
  payment:
    | { mode: 'sandbox'; canConfirm: boolean }
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
      }
  steps: { label: string; at: string | null; done: boolean }[]
  message: { title: string; detail: string; tone: 'good' | 'warn' }
  result: { text: string; downloadUrl: string } | null
  createdAt: string
  expiresAt: string
  contact: string | null
}
export type PublicPayRequest = { mode: 'sandbox' } | { mode: 'sepolia'; hash: string }
export type PublicPayResponse = { ok: true }
