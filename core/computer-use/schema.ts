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
const domainField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(100)
  .refine((value) => /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(value), 'DOMAIN_REQUIRED')
const currencyField = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => /^[A-Z]{3}$/.test(value), 'CURRENCY_CODE')
/** Integer minor units (kopecks, cents); the ledger never holds floats. */
const minorAmount = z.number().int().min(0).max(1_000_000_000_000)

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
  // No control characters: a line break or tab would press Enter or Tab past the policy check
  // of the `key` action (Playwright types "\n" as Enter).
  z
    .object({
      name: z.literal('type'),
      text: z
        .string()
        .min(1)
        .max(2000)
        .regex(/^[^\p{Cc}]+$/u, 'CONTROL_CHARACTERS'),
    })
    .strict(),
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

/**
 * Server-only VM action: stored text goes in through `insertText`, so a line break becomes a
 * line break in the field and never a submitting Enter. The model cannot call it directly; the
 * server sends a stored proposal or document in chunks through `type_stored`.
 */
export const insertTextSchema = z
  .object({
    name: z.literal('insert_text'),
    text: z
      .string()
      .min(1)
      .max(2000)
      .regex(/^(?:[^\p{Cc}]|\n)+$/u, 'CONTROL_CHARACTERS'),
  })
  .strict()
export const vmActionSchema = z.discriminatedUnion('name', [
  ...browserActionSchema.options,
  insertTextSchema,
])
export type VmAction = z.infer<typeof vmActionSchema>
export const INSERT_CHUNK = 2000

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
export const opportunityDecisions = ['take', 'human', 'skip'] as const
export type OpportunityDecision = (typeof opportunityDecisions)[number]
export const documentKinds = [
  'article',
  'product_description',
  'translation',
  'summary',
  'instruction',
  'reply',
  'other',
] as const
export type DocumentKind = (typeof documentKinds)[number]
export const sendPurposes = ['delivery', 'reply'] as const

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
      // Self-assessment. The server overrides `decision` to skip when the job forbids AI.
      decision: z.enum(opportunityDecisions),
      fit: z.number().int().min(0).max(100),
      ai_forbidden: z.boolean(),
      estimated_value: z
        .object({ amount: minorAmount, currency: currencyField })
        .strict()
        .nullable(),
      reason: text(500),
    })
    .strict(),
  z
    .object({
      name: z.literal('draft_proposal'),
      opportunity_url: urlField,
      platform_domain: domainField,
      text: z
        .string()
        .trim()
        .min(200)
        .max(3000)
        .refine((value) => !/[<>]/.test(value), 'ANGLE_BRACKETS')
        .refine((value) => !/\p{Cc}/u.test(value.replace(/\n/g, '')), 'CONTROL_CHARACTERS'),
      price_amount: minorAmount.nullable(),
      price_currency: currencyField.nullable(),
    })
    .strict(),
  z.object({ name: z.literal('type_stored'), id: z.uuid() }).strict(),
  z
    .object({
      name: z.literal('write_document'),
      title: text(160).refine((value) => value.length >= 4, 'TITLE_SHORT'),
      brief: text(3000).refine((value) => value.length >= 20, 'BRIEF_SHORT'),
      kind: z.enum(documentKinds),
    })
    .strict(),
  z
    .object({
      name: z.literal('prepare_send'),
      domain: domainField,
      purpose: z.enum(sendPurposes),
    })
    .strict(),
])
export type ToolCall = z.infer<typeof toolCallSchema>
export const toolNames = toolCallSchema.options.map((option) => option.shape.name.value)

/** Rebuilds `{name, ...arguments}` from a raw function call and validates it strictly. */
export function parseToolCall(name: string, parameters: unknown): ToolCall {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
    throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  const candidate = { ...(parameters as Record<string, unknown>), name }
  const parsed = toolCallSchema.safeParse(candidate)
  if (!parsed.success) throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  return parsed.data
}

/** Splits stored text into VM-sized pieces at line or word boundaries where possible. */
export function chunkStoredText(text: string, size = INSERT_CHUNK): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size / 2) cut = rest.lastIndexOf(' ', size)
    if (cut < size / 2) cut = size
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length) chunks.push(rest)
  return chunks
}
