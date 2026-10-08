import type { Template } from '../../core/policy'

export type ServiceDirection = {
  id: Template
  label: string
  category: string
  audience: string
  delivery: string
  inputLabel: string
  example: string
  searchQuery: string
  channels: string[]
}

export function useServiceCatalog() {
  const { state, failure } = useFarm()
  const services = computed<ServiceDirection[]>(() => state.value?.serviceCatalog || [])
  const service = (template: string) => services.value.find((item) => item.id === template)
  const serviceLabel = (template: string) =>
    service(template)?.label || labels[template] || 'Другое направление'
  const productLink = (id: string) => ({ path: '/office/products', query: { product: id } })
  const researchBlockedReason = computed(() => {
    if (failure.value) return 'Данные не обновляются. Дождитесь восстановления соединения.'
    if (!state.value?.autonomy.workerAlive)
      return 'Обработчик не на связи. Проверьте его состояние в настройках.'
    if (state.value.state.mode !== 'running')
      return 'Продолжите работу, чтобы запустить исследование.'
    if (!state.value.state.research_enabled) return 'Начните новый эксперимент в обзоре.'
    if (
      state.value.state.provider_readiness?.model === false ||
      state.value.state.provider_readiness?.search === false
    )
      return 'Модель или поиск недоступны. Проверьте подключения в настройках.'
    if (state.value.researchCampaign?.status === 'running')
      return state.value.researchCampaign.source === 'scheduled' && !state.value.autonomy.enabled
        ? 'Автоматический обход ждёт включения расписания в настройках. Можно отменить оставшиеся направления.'
        : 'Идёт исследование всех направлений. Прогресс виден ниже и в истории исследований.'
    if (state.value.autonomy.activeRun)
      return 'Дождитесь текущего исследования. Его результат сохранится в истории.'
    return ''
  })
  return { services, service, serviceLabel, productLink, researchBlockedReason }
}
