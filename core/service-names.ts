/**
 * One name per service type, the same on the public site and in the owner office.
 * Pure data: the office frontend imports it directly.
 */
export const serviceNames = Object.freeze({
  description: 'Описание товара для маркетплейса',
  faq: 'Ответы на частые вопросы для сайта',
  social: 'Три поста из вашего текста',
  proofreading: 'Вычитка текста',
  translation: 'Перевод на английский и другие языки',
  summary: 'Краткое содержание документа',
  email: 'Ответ на вопрос или отзыв клиента',
  landing: 'Текст для страницы услуги',
  proposal: 'Коммерческое предложение по брифу',
  instruction: 'Пошаговая инструкция',
  lesson: 'Мини-урок по вашему материалу',
  job_post: 'Вакансия, на которую откликаются',
} as const)

export type ServiceNameKey = keyof typeof serviceNames

/** Name of a service type for people; unknown types keep the stored name. */
export function serviceName(template: unknown, fallback = 'Текстовая услуга') {
  return typeof template === 'string' && Object.hasOwn(serviceNames, template)
    ? serviceNames[template as ServiceNameKey]
    : fallback
}

/** «Заказ №1042». Numbers come from the orders.number sequence (db/022). */
export function orderTitle(number: unknown) {
  const n = Number(number)
  return Number.isSafeInteger(n) && n > 0 ? `Заказ №${n}` : 'Заказ'
}
