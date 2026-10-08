import type { ProductSpec, Template } from '../policy'
import { serviceCatalog } from '../service-catalog'

const originalNames: Partial<Record<Template, string>> = {
  description: 'Карточка без лишних слов',
  faq: 'Ответы до первого вопроса',
  social: 'Из материала в публикации',
}
export const demoSpecs: Record<Template, ProductSpec> = Object.fromEntries(
  serviceCatalog.map((service) => [
    service.id,
    {
      template: service.id,
      name: originalNames[service.id] ?? service.label,
      audience: service.audience,
      promise: service.delivery,
      inputLabel: service.inputLabel,
    },
  ]),
) as Record<Template, ProductSpec>

export function demoResult(template: Template, input: string) {
  const raw = input.trim().slice(0, 3500)
  const marker = 'ДЕМОНСТРАЦИЯ · шаблонная сборка без вызова модели'
  if (template === 'description')
    return `ДЕМОНСТРАЦИЯ · шаблонная сборка без вызова модели\n\nОписание товара\n- ${raw}\n\nПеред публикацией уточните отсутствующие характеристики. Новые свойства и гарантии не добавлены.`
  if (template === 'faq')
    return `ДЕМОНСТРАЦИЯ · шаблонная сборка без вызова модели\n\nЧто известно об услуге?\n${raw}\n\nЧто уточнить перед заказом?\nСроки, итоговый состав услуги и ограничения, если их нет в исходном материале.`
  if (template === 'social')
    return `${marker}\n\nЧерновик 1. Знакомство\n${raw}\n\nЧерновик 2. Основные сведения\n${raw}\n\nЧерновик 3. Перед обращением\nУточните необходимые детали по исходному материалу. Неуказанные свойства не добавлены.`
  if (template === 'proofreading')
    return `${marker}\n\nИсправленный текст:\n${raw}\n\nПравки:\nВ демонстрации сохранён исходный текст; редактура моделью не выполнялась.`
  if (template === 'translation')
    return `${marker}\n\nПеревод моделью не выполнялся. Для проверки показан исходный материал:\n${raw.slice(raw.indexOf('\n') + 1)}`
  if (template === 'summary')
    return `${marker}\n\nКратко:\nВ демонстрации показан исходник без модельного сокращения.\n\nКлючевые факты:\n- ${raw}`
  if (template === 'email')
    return `${marker}\n\nТема:\nОтвет по вашему вопросу\n\nЧерновик ответа:\n${raw}\n\nЭто демонстрационный материал. Отправка письма не выполнялась.`
  if (template === 'landing')
    return `${marker}\n\nЗаголовок:\nОписание услуги\n\nОписание:\n${raw}\n\nЧто уточнить:\nПроверьте недостающие условия по исходному материалу. Страница не публиковалась.`
  if (template === 'proposal')
    return `${marker}\n\nПредложение:\nМатериал для обсуждения\n\nОбъём работ:\n${raw}\n\nУсловия:\nТолько сведения из исходного материала.\n\nЧто уточнить:\nПроверьте отсутствующие условия до согласования. Предложение не отправлялось.`
  if (template === 'instruction')
    return `${marker}\n\nШаги:\n1. ${raw}\n\nЧто уточнить:\nПорядок действий в демонстрации моделью не проверялся.`
  if (template === 'lesson')
    return `${marker}\n\nТема:\nИзучение предоставленного материала\n\nОбъяснение:\n${raw}\n\nСамопроверка:\nКакие сведения приведены в исходном материале?\n\nОтвет:\nСверьтесь с исходным материалом: модельная подготовка урока не выполнялась.`
  if (template === 'job_post')
    return `${marker}\n\nВакансия:\nМатериал работодателя\n\nЗадачи:\n${raw}\n\nТребования:\nТолько указанные в исходном материале.\n\nУсловия:\nНеизвестные сведения требуют уточнения. Вакансия не размещалась.`
  throw new Error('TEMPLATE_UNSUPPORTED')
}
