import type { Evidence } from '../../core/policy'

export const researchEvidence: Evidence[] = [
  'https://example.com/first-offer',
  'https://www.example.com/second-offer',
  'https://example.org/alternative',
].map((url) => ({
  url,
  title: 'Предложение текстовой услуги',
  snippet: 'Тестовый источник: оформление материалов заказчика.',
  observedAt: '2026-10-05T00:00:00.000Z',
  demo: false,
}))

export const dependentResearchIdea = {
  title: 'Оформление материалов мастерских',
  problem: 'Небольшим мастерским требуется подготовка материалов для публикации.',
  audience: 'Небольшие мастерские',
  hypothesis: 'Подготовленное оформление может сэкономить время владельца мастерской.',
  counterargument: 'Бесплатного текстового редактора может быть достаточно.',
  experiment: 'Проверить оформление на обезличенных исходных материалах.',
  estimatedCostRub: 0,
  sources: researchEvidence.slice(0, 2).map((item) => item.url),
  uncertainties: ['Готовность владельцев платить пока не проверена.'],
}
