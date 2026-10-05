import { config } from '../config'
import { model } from '../providers'
import { demoResult } from '../providers/demo'
import { outputSchema, type ProductSpec } from '../policy'
import {
  sourceSocialDelivery,
  sourcePostsSchema,
  sourcePostLayouts,
  renderSourcePosts,
  validateSourcePostInput,
} from '../source-posts'
import { generationContext } from './text-context'

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
  if (config().MODEL_PROVIDER === 'ollama' && args.product.template === 'social')
    throw new Error('PRODUCT_RECIPE_REFRESH_REQUIRED')
  return model({
    role: 'Исполнитель',
    key: args.key,
    reservationId: args.reservationId,
    context: generationContext(args.product, args.input, args.approach),
    schema: outputSchema,
    demoValue: { text: demoResult(args.product.template, args.input) },
  })
}
