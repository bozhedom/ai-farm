import { serviceCatalog, type ServiceTemplate } from './service-catalog'

/** Server-owned recipes: product specifications can specialize the audience, not add actions. */
type Recipe = { task: string; delivery: string; fixture: string }
export const recipes: Record<ServiceTemplate, Recipe> = Object.fromEntries(
  serviceCatalog.map((service) => [
    service.id,
    { task: service.task, delivery: service.delivery, fixture: service.example },
  ]),
) as Record<ServiceTemplate, Recipe>
