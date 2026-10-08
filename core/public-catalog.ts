import { config } from './config'
import { query } from './db'
import type { PaymentModeInfo } from './contracts/common'
import type { PublicCatalog } from './contracts/public'
import { serviceByTemplate, type ServiceTemplate } from './service-catalog'
import { publicServiceProjection } from './storefront'

export function paymentModeInfo(): PaymentModeInfo {
  return config().PAYMENT_MODE === 'sepolia'
    ? { mode: 'sepolia', test: true, label: 'Тестовый ETH, сеть Sepolia' }
    : { mode: 'sandbox', test: true, label: 'Тестовая оплата' }
}

/** Products the owner published. Private, archived and unknown templates never leave the server. */
export async function publicCatalog(): Promise<PublicCatalog> {
  const c = config()
  const rows = await query(
    `SELECT template,slug,version,price_kopecks,page,is_demo,spec FROM products
     WHERE status='sandbox' AND visibility='public' ORDER BY published_at,slug`,
  )
  return {
    services: rows
      .filter((row) => serviceByTemplate[row.template as ServiceTemplate])
      .map((row) =>
        publicServiceProjection(row as any, serviceByTemplate[row.template as ServiceTemplate], {
          paymentMode: c.PAYMENT_MODE,
        }),
      ),
    payment: paymentModeInfo(),
    // Public ordering arrives with the buyer path; until then the catalog is read-only.
    acceptingOrders: false,
    notice: 'Тестовый магазин: оплата ненастоящая, деньги не списываются.',
    seller:
      c.PUBLIC_SELLER && c.PUBLIC_CONTACT
        ? { name: c.PUBLIC_SELLER, contact: c.PUBLIC_CONTACT, termsUrl: c.PUBLIC_TERMS_URL || null }
        : null,
  }
}
