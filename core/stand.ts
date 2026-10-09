import { config } from './config'

/**
 * A demo stand runs the demo provider. Elsewhere demo ideas, products, orders and leads stay out
 * of the storefront, the farm's work and its numbers.
 */
export function isDemoStand() {
  return config().MODEL_PROVIDER === 'demo'
}
