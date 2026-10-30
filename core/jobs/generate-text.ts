import { config, usesSourcePosts } from '../config'
import { model, type ModelArgs } from '../providers'
import { demoResult } from '../providers/demo'
import {
  outputSchemaForTemplate,
  polishOutput,
  withResultLanguage,
  type ProductSpec,
} from '../policy'
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

export type GenerateArgs = {
  key: string
  reservationId: string
  product: TextProduct
  input: string
  approach: string
}

/**
 * Use the saved promise: changing providers never silently changes an accepted order's recipe.
 * The server polishes the result (long dashes, an empty "what to clarify") without new facts.
 */
export async function generateText(args: GenerateArgs) {
  const result = await generateRaw(args)
  return { ...result, text: polishOutput(args.product.template, args.input, result.text) }
}

async function generateRaw(args: GenerateArgs): Promise<{ text: string }> {
  const result = await model(textGenerationRequest(args))
  if (args.product.template === 'social' && args.product.promise === sourceSocialDelivery)
    return renderSourcePosts(args.input, sourcePostsSchema.parse(result))
  const template = args.product.template
  if (config().MODEL_PROVIDER !== 'demo' && isStructuredTemplate(template)) {
    // Persisted successful calls from the previous renderer keep their idempotency key.
    if (Object.hasOwn(result, 'text')) return outputSchemaForTemplate(template).parse(result)
    return renderStructuredText(template, result)
  }
  // model() validates the schema; the caller retains its existing content/format checks.
  return result as { text: string }
}

/** Shared with order admission: the estimate uses exactly the request sent to the provider. */
export function textGenerationRequest(args: GenerateArgs): ModelArgs<Record<string, any>> {
  if (args.product.template === 'social' && args.product.promise === sourceSocialDelivery) {
    validateSourcePostInput(args.input)
    return {
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
    }
  }
  if (usesSourcePosts(config().MODEL_PROVIDER) && args.product.template === 'social')
    throw new Error('PRODUCT_RECIPE_REFRESH_REQUIRED')
  const template = args.product.template
  if (config().MODEL_PROVIDER !== 'demo' && isStructuredTemplate(template)) {
    const context = generationContext(args.product, args.input, args.approach)
    return {
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
      schema: withResultLanguage(structuredTextSchema(template), template, args.input),
      // Demo follows the original branch below; this fallback stays explicitly synthetic.
      demoValue: { text: demoResult(template, args.input) },
    }
  }
  return {
    role: 'Исполнитель',
    key: args.key,
    reservationId: args.reservationId,
    context: generationContext(args.product, args.input, args.approach),
    schema: withResultLanguage(
      outputSchemaForTemplate(args.product.template),
      args.product.template,
      args.input,
    ),
    demoValue: { text: demoResult(args.product.template, args.input) },
  }
}
