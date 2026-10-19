import { z } from 'zod'

/** Browser viewport on the VM. Coordinates outside it are refused before any request. */
export const VIEWPORT = Object.freeze({ width: 1280, height: 800 })

const coordinate = (max: number) => z.number().int().min(0).max(max)
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[<>]/.test(value), 'ANGLE_BRACKETS')
export const urlField = z
  .string()
  .trim()
  .min(8)
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), 'HTTP_URL_REQUIRED')

export const keyNames = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Space',
] as const

/** Actions the VM agent executes. The same shape is validated again inside the VM. */
export const browserActionSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('navigate'), url: urlField }).strict(),
  z
    .object({
      name: z.literal('click'),
      x: coordinate(VIEWPORT.width - 1),
      y: coordinate(VIEWPORT.height - 1),
    })
    .strict(),
  z.object({ name: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ name: z.literal('key'), key: z.enum(keyNames) }).strict(),
  z
    .object({
      name: z.literal('scroll'),
      x: coordinate(VIEWPORT.width - 1),
      y: coordinate(VIEWPORT.height - 1),
      deltaY: z.number().int().min(-3000).max(3000),
    })
    .strict(),
  z.object({ name: z.literal('back') }).strict(),
  z.object({ name: z.literal('wait'), ms: z.number().int().min(100).max(5000) }).strict(),
])
export type BrowserAction = z.infer<typeof browserActionSchema>
export const browserActionNames = browserActionSchema.options.map(
  (option) => option.shape.name.value,
)

export const opportunityKinds = [
  'bounty',
  'freelance',
  'grant',
  'airdrop',
  'digital_product',
  'service_demand',
  'other',
] as const
export type OpportunityKind = (typeof opportunityKinds)[number]

/** Everything the model may answer with: one browser action or one bookkeeping call. */
export const toolCallSchema = z.discriminatedUnion('name', [
  ...browserActionSchema.options,
  z.object({ name: z.literal('finish'), report: text(4000) }).strict(),
  z
    .object({
      name: z.literal('request_approval'),
      reason: text(1000),
      action: browserActionSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal('note_opportunity'),
      title: text(160).refine((value) => value.length >= 4, 'TITLE_SHORT'),
      url: urlField,
      summary: text(1500),
      kind: z.enum(opportunityKinds),
      requiresHuman: z.boolean(),
    })
    .strict(),
])
export type ToolCall = z.infer<typeof toolCallSchema>

/** Rebuilds `{name, ...arguments}` from a raw function call and validates it strictly. */
export function parseToolCall(name: string, parameters: unknown): ToolCall {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
    throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  const candidate = { ...(parameters as Record<string, unknown>), name }
  const parsed = toolCallSchema.safeParse(candidate)
  if (!parsed.success) throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  return parsed.data
}
