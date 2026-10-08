import { config, usesSourcePosts } from '../config'
import { model } from '../providers'
import { demoResult } from '../providers/demo'
import { outputSchemaForTemplate, type ProductSpec } from '../policy'
import {
  sourceSocialDelivery,
  sourcePostsSchema,
  sourcePostLayouts,
  renderSourcePosts,
  validateSourcePostInput,
} from '../source-posts'
import { generationContext } from './text-context'
import {
  isStructuredTemplate,
  structuredTextFormat,
  structuredTextSchema,
  renderStructuredText,
} from '../structured-text'

type TextProduct = Pick<ProductSpec, 'template' | 'promise'>

/** Use the saved promise: changing providers never silently changes an accepted order's recipe. */
export async function generateText(args: {
  key: string
  reservationId: string
  product: TextProduct
  input: string
  approach: string
}) {
  if (args.product.template === 'social' && args.product.promise === sourceSocialDelivery) {
    validateSourcePostInput(args.input)
    const result = await model({
      role: 'Исполнитель',
      key: args.key,
      reservationId: args.reservationId,
      schema: sourcePostsSchema,
      context: {
        template: 'social',
        input: args.input,
        task: 'Выбери порядок трёх оформлений полного исходного текста: paragraph (один абзац), lines (предложения с новой строки), spaced (предложения с пустой строкой). Верни каждое оформление ровно один раз в layouts. Сервер сохранит все исходные фразы и их порядок в каждом варианте. Нельзя сокращать, перефразировать или добавлять факты.',
      },
      demoValue: { layouts: [...sourcePostLayouts] },
    })
    return renderSourcePosts(args.input, result)
  }
  if (usesSourcePosts(config().MODEL_PROVIDER) && args.product.template === 'social')
    throw new Error('PRODUCT_RECIPE_REFRESH_REQUIRED')
  const template = args.product.template
  if (config().MODEL_PROVIDER !== 'demo' && isStructuredTemplate(template)) {
    const context = generationContext(args.product, args.input, args.approach)
    const result = await model({
      role: 'Исполнитель',
      key: args.key,
      reservationId: args.reservationId,
      context: {
        ...context,
        task: context.task.replace(
          'Выполни recipe и верни текст.',
          'Выполни смысловые требования recipe и верни поля JSON-схемы.',
        ),
        outputFormat: structuredTextFormat(template),
      },
      schema: structuredTextSchema(template),
      // Demo follows the original branch below; this fallback stays explicitly synthetic.
      demoValue: { text: demoResult(template, args.input) },
    })
    // Persisted successful calls from the previous renderer keep their idempotency key.
    // A live response cannot take this branch: its fields must pass the structured schema.
    if (Object.hasOwn(result, 'text')) return outputSchemaForTemplate(template).parse(result)
    return renderStructuredText(template, result)
  }
  return model({
    role: 'Исполнитель',
    key: args.key,
    reservationId: args.reservationId,
    context: generationContext(args.product, args.input, args.approach),
    schema: outputSchemaForTemplate(args.product.template),
    demoValue: { text: demoResult(args.product.template, args.input) },
  })
}
