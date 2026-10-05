import { z } from 'zod'
import { validateInput, validateOutput } from './policy'

export const sourceSocialDelivery =
  'Три варианта оформления полного исходного текста. Без сокращения и перефразирования.'
export const sourceSocialInputLimit = 3000
export const sourcePostLayouts = ['paragraph', 'lines', 'spaced'] as const
export const sourcePostsSchema = z
  .object({ layouts: z.array(z.enum(sourcePostLayouts)).length(3) })
  .strict()

/** Formatting may change whitespace, never words, punctuation, order or conditions. */
export function sourceSentences(input: string) {
  return [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(input)]
    .map((item) => item.segment.trim())
    .filter(Boolean)
}
export function renderSourcePosts(input: string, candidate: unknown) {
  const { layouts } = sourcePostsSchema.parse(candidate)
  if (new Set(layouts).size !== 3) throw new Error('OUTPUT_SOURCE_DUPLICATE')
  const sentences = sourceSentences(input)
  const separators = { paragraph: ' ', lines: '\n', spaced: '\n\n' }
  const text = layouts
    .map((layout, index) => `${index + 1}. ${sentences.join(separators[layout])}`)
    .join('\n\n')
  validateOutput('social', text)
  return { text }
}
export function validateSourcePostInput(input: string) {
  validateInput(input)
  if (input.length > sourceSocialInputLimit) throw new Error('INPUT_SOCIAL_LENGTH')
  // Check the full result before accepting payment, including server formatting overhead.
  renderSourcePosts(input, { layouts: sourcePostLayouts })
}
