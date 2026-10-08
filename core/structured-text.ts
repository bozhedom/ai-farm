import { z } from 'zod'
import { POLICY, validateContent, validateOutput, type Template } from './policy'

export const structuredTemplates = [
  'proofreading',
  'summary',
  'email',
  'landing',
  'proposal',
  'instruction',
  'lesson',
  'job_post',
] as const
export type StructuredTemplate = (typeof structuredTemplates)[number]

type Section = {
  field: string
  heading: string
  description: string
  format?: 'bullets' | 'steps'
}

/** Fields contain facts; only this server-owned map controls the delivered document layout. */
const sections: Record<StructuredTemplate, Section[]> = {
  proofreading: [
    {
      field: 'correctedText',
      heading: 'Исправленный текст',
      description: 'Весь исправленный исходный текст без заголовка раздела. Сохрани факты и числа.',
    },
    {
      field: 'changes',
      heading: 'Правки',
      description:
        'Только действительно внесённые правки. Если правок нет, один элемент «Правок нет».',
      format: 'bullets',
    },
  ],
  summary: [
    { field: 'summary', heading: 'Кратко', description: 'Краткое содержание исходного материала.' },
    {
      field: 'facts',
      heading: 'Ключевые факты',
      description: 'Ключевые исходные факты, числа, ограничения и нерешённые вопросы.',
      format: 'bullets',
    },
  ],
  email: [
    { field: 'subject', heading: 'Тема', description: 'Краткая тема ответа на входящий вопрос.' },
    {
      field: 'body',
      heading: 'Черновик ответа',
      description:
        'Черновик ответа только по вопросу и подтверждённым условиям. Письмо не отправляется.',
    },
  ],
  landing: [
    {
      field: 'headline',
      heading: 'Заголовок',
      description: 'Заголовок страницы по исходным фактам.',
    },
    {
      field: 'description',
      heading: 'Описание',
      description: 'Описание услуги, известного состава, сроков и ограничений.',
    },
    {
      field: 'clarifications',
      heading: 'Что уточнить',
      description: 'Недостающие сведения. Если пробелов нет, один элемент «Уточнений нет».',
      format: 'bullets',
    },
  ],
  proposal: [
    {
      field: 'proposal',
      heading: 'Предложение',
      description: 'Суть делового предложения по брифу.',
    },
    {
      field: 'scope',
      heading: 'Объём работ',
      description: 'Только предоставленный состав работ. Неизвестный состав требует уточнения.',
      format: 'bullets',
    },
    {
      field: 'terms',
      heading: 'Условия',
      description: 'Только известные цена, сроки и ограничения; отсутствующие условия явно отметь.',
      format: 'bullets',
    },
    {
      field: 'clarifications',
      heading: 'Что уточнить',
      description: 'Недостающие условия до согласования. Если пробелов нет, укажи «Уточнений нет».',
      format: 'bullets',
    },
  ],
  instruction: [
    {
      field: 'steps',
      heading: 'Шаги',
      description:
        'Известные шаги процесса в исходном порядке. Каждый элемент без номера и маркера.',
      format: 'steps',
    },
    {
      field: 'clarifications',
      heading: 'Что уточнить',
      description: 'Неизвестные действия или условия. Если пробелов нет, укажи «Уточнений нет».',
      format: 'bullets',
    },
  ],
  lesson: [
    { field: 'topic', heading: 'Тема', description: 'Тема мини-урока из исходного материала.' },
    {
      field: 'explanation',
      heading: 'Объяснение',
      description: 'Краткое объяснение только исходных фактов.',
    },
    {
      field: 'question',
      heading: 'Самопроверка',
      description: 'Вопрос с ответом в исходном материале.',
    },
    {
      field: 'answer',
      heading: 'Ответ',
      description: 'Ответ на вопрос строго по исходному материалу.',
    },
  ],
  job_post: [
    { field: 'title', heading: 'Вакансия', description: 'Название роли, указанной работодателем.' },
    {
      field: 'tasks',
      heading: 'Задачи',
      description: 'Только известные задачи роли.',
      format: 'bullets',
    },
    {
      field: 'requirements',
      heading: 'Требования',
      description: 'Только предоставленные необходимые навыки. Неизвестные требования отметь.',
      format: 'bullets',
    },
    {
      field: 'terms',
      heading: 'Условия',
      description: 'Подтверждённые условия работы. Недостающие сведения требуют уточнения.',
      format: 'bullets',
    },
  ],
}

type FieldValue = string | string[]
type StructuredFields = Record<string, FieldValue>
const fieldText = () =>
  z
    .string()
    .trim()
    .min(3)
    .max(POLICY.maxOutputChars)
    .refine((value) => !/[<>]/.test(value), 'HTML_FORBIDDEN')

function assemble(template: StructuredTemplate, fields: StructuredFields) {
  return sections[template]
    .map((section) => {
      const value = fields[section.field]!
      const body = Array.isArray(value)
        ? value
            .map(
              (item, index) =>
                `${section.format === 'steps' ? `${index + 1}.` : '-'} ${item.replace(/\s+/gu, ' ')}`,
            )
            .join('\n')
        : value
      return `${section.heading}:\n${body}`
    })
    .join('\n\n')
}

const schemas = Object.fromEntries(
  structuredTemplates.map((template): [StructuredTemplate, z.ZodType<StructuredFields>] => {
    const shape = Object.fromEntries(
      sections[template].map((section) => [
        section.field,
        (section.format ? z.array(fieldText()).min(1).max(100) : fieldText()).describe(
          section.description + ' Содержимое без заголовков разделов и служебных пояснений.',
        ),
      ]),
    )
    return [
      template,
      z
        .object(shape)
        .strict()
        .superRefine((fields, context) => {
          const text = assemble(template, fields)
          // Policy refusals remain hard errors; a format repair cannot disguise forbidden text.
          validateContent(text)
          try {
            validateOutput(template, text)
          } catch (error) {
            if (
              !(error instanceof z.ZodError) &&
              (!(error instanceof Error) || error.message !== 'OUTPUT_FORMAT_REQUIRED')
            )
              throw error
            context.addIssue({
              code: 'custom',
              message: `Заполни поля содержимым без повторения заголовков разделов. Весь результат вместе с заголовками и маркерами должен занимать не более ${POLICY.maxOutputChars} символов. Сохрани исходные факты; убери только лишнее оформление.`,
            })
          }
        }),
    ]
  }),
) as Record<StructuredTemplate, z.ZodType<StructuredFields>>

export function isStructuredTemplate(template: Template): template is StructuredTemplate {
  return (structuredTemplates as readonly string[]).includes(template)
}

export function structuredTextSchema(template: StructuredTemplate) {
  if (!Object.hasOwn(schemas, template)) throw new Error('TEMPLATE_UNSUPPORTED')
  return schemas[template]
}

export function structuredTextFormat(template: StructuredTemplate) {
  return {
    fields: sections[template].map(({ field, description, format }) => ({
      field,
      description,
      type: format ? 'array of strings' : 'string',
    })),
    instruction:
      'Верни один JSON-объект с конкретным содержимым каждого поля указанной схемы. Выполни смысловые требования recipe. Заголовки разделов, маркированные списки и номера шагов добавит сервер. В значениях полей пиши только содержимое без этих заголовков, номеров и маркеров. Не добавляй поле text, описание JSON-схемы или пояснения вокруг JSON. Неизвестные сведения явно обозначь, не выдумывай факты.',
  }
}

export function renderStructuredText(template: StructuredTemplate, candidate: unknown) {
  const fields = structuredTextSchema(template).parse(candidate)
  return { text: assemble(template, fields) }
}
