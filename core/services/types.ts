import type { ServiceTemplate } from '../service-catalog'
import type { OrderStatus } from '../orders'

export type ServiceOffer = {
  template: ServiceTemplate
  name: string
  description: string
  inputLabel: string
  example: string
  productId: string | null
  version: number | null
  priceKopecks: number | null
  currency: 'RUB'
  testOnly: true
  ready: boolean
  blockers: string[]
}

export type ServiceCatalogView = {
  paymentMode: 'sandbox' | 'sepolia'
  modelMode: 'demo' | 'configured'
  acceptingJobs: boolean
  blockers: string[]
  apiAccess: 'owner-session'
  x402: { status: 'not-implemented'; reason: string }
  storefront: { url: '/storefront'; published: number; testOnly: true }
  services: ServiceOffer[]
}

export type ServiceQuoteView = {
  quote: string
  expiresAt: string
  productId: string
  version: number
  name: string
  priceKopecks: number
  currency: 'RUB'
  paymentMode: 'sandbox' | 'sepolia'
  testOnly: true
}

export type ServiceJobView = {
  id: string
  orderId: string
  number: number
  status: OrderStatus
  orderUrl: string
  paymentMode: 'sandbox' | 'sepolia'
  testOnly: true
  result: string | null
  createdAt: string
  deliveredAt: string | null
}
