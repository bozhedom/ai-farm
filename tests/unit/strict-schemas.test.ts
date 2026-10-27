import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ideaSchemaForEvidence,
  productOfferSchemaFor,
  productSchema,
  replyDraftSchemaFor,
  reportSchemaFor,
  researchSchemaForEvidence,
  reviewSchema,
  templates,
  withResultLanguage,
  type Evidence,
} from '../../core/policy'
import { outputSchemaForTemplate } from '../../core/policy'
import { structuredTemplates, structuredTextSchema } from '../../core/structured-text'
import { sourcePostsSchema } from '../../core/source-posts'
import { managerPlanSchema } from '../../core/manager/plan'
import { documentSchema } from '../../core/computer-use/model'
import { toolCallSchema } from '../../core/computer-use/schema'
import { computerUseTools, strictCompatible } from '../../core/computer-use/tools'
import { modelJsonSchema, strictSchemaIssues } from '../../core/providers/json-schema'
import { prepareModelRequest } from '../../core/providers'

const evidence: Evidence[] = [
  { url: 'https://a.example/1', title: 'A', snippet: 'a', observedAt: '', demo: false },
  { url: 'https://b.example/2', title: 'B', snippet: 'b', observedAt: '', demo: false },
]

/** Every schema a farm job sends to a paid model (core/jobs, core/manager). */
const modelSchemas: [string, z.ZodType][] = [
  ['product', productSchema],
  ['review', reviewSchema],
  ['research', researchSchemaForEvidence(evidence, false)],
  ['idea', ideaSchemaForEvidence(evidence, false)],
  ['report', reportSchemaFor(['00000000-0000-0000-0000-000000000001'])],
  ['reply', replyDraftSchemaFor('https://farm.example/services/description')],
  ['source posts', sourcePostsSchema],
  ['manager plan', managerPlanSchema],
  ...templates.map((t): [string, z.ZodType] => [`offer ${t}`, productOfferSchemaFor(t)]),
  ...templates.map((t): [string, z.ZodType] => [
    `output ${t}`,
    withResultLanguage(outputSchemaForTemplate(t), t, 'Исходный текст'),
  ]),
  ...structuredTemplates.map((t): [string, z.ZodType] => [
    `structured ${t}`,
    withResultLanguage(structuredTextSchema(t), t, 'Исходный текст'),
  ]),
  ['computer-use document', documentSchema],
]

describe('strict structured output schemas', () => {
  it.each(modelSchemas)('%s: every object lists all properties as required', (_, schema) => {
    expect(strictSchemaIssues(modelJsonSchema(schema))).toEqual([])
  })

  it.each(toolCallSchema.options.map((option) => [option.shape.name.value, option] as const))(
    'computer-use tool %s: zod schema is strict',
    (_, schema) => {
      expect(strictSchemaIssues(modelJsonSchema(schema))).toEqual([])
    },
  )

  it('computer-use OpenRouter tool parameters stay strict after anyOf rewrite', () => {
    expect(computerUseTools.length).toBe(toolCallSchema.options.length)
    for (const tool of computerUseTools) {
      const parameters = strictCompatible(tool.parameters)
      expect(strictSchemaIssues(parameters)).toEqual([])
    }
  })

  it('covers the architect offers for job posts, landings and proofreading', () => {
    for (const template of ['job_post', 'landing', 'proofreading'])
      expect(modelSchemas.map(([name]) => name)).toContain(`offer ${template}`)
  })

  it('finds optional and open objects at any depth', () => {
    const bad = z.object({
      page: z.object({ a: z.string(), b: z.array(z.string()).optional() }).strict(),
      list: z.array(z.object({ c: z.string() }).passthrough()),
    })
    expect(strictSchemaIssues(modelJsonSchema(bad))).toEqual([
      '$.properties.page: not required b',
      '$.properties.list.items: additionalProperties',
    ])
    const good = z.object({ b: z.array(z.string()).nullable() }).strict()
    expect(strictSchemaIssues(modelJsonSchema(good))).toEqual([])
  })

  it('refuses a non-strict schema before anything is reserved', () => {
    const schema = z.object({ text: z.string(), extra: z.string().optional() }).strict()
    expect(() =>
      prepareModelRequest({
        role: 'Архитектор',
        key: 'k',
        reservationId: 'r',
        context: {},
        schema,
        demoValue: { text: 'x' },
      }),
    ).toThrow('MODEL_SCHEMA_NOT_STRICT')
  })
})
