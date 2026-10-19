import { z } from 'zod'

/** The same action shapes as core/computer-use/schema.ts, validated again inside the VM. */
export const VIEWPORT = Object.freeze({ width: 1280, height: 800 })
const coordinate = (max: number) => z.number().int().min(0).max(max)
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

export const actionSchema = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('navigate'),
      url: z
        .string()
        .trim()
        .min(8)
        .max(2000)
        .refine((value) => /^https?:\/\//i.test(value)),
    })
    .strict(),
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
export type Action = z.infer<typeof actionSchema>
export const inspectSchema = z
  .object({ x: coordinate(VIEWPORT.width - 1), y: coordinate(VIEWPORT.height - 1) })
  .strict()
