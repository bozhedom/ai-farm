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
  // Line breaks and tabs would press Enter or Tab: those are separate `key` actions.
  z
    .object({
      name: z.literal('type'),
      text: z
        .string()
        .min(1)
        .max(2000)
        .regex(/^[^\p{Cc}]+$/u),
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
  // Stored text goes in through insertText: a line break stays a line break in the field and
  // never becomes a submitting Enter. Other control characters are still refused.
  z
    .object({
      name: z.literal('insert_text'),
      text: z
        .string()
        .min(1)
        .max(2000)
        .regex(/^(?:[^\p{Cc}]|\n)+$/u),
    })
    .strict(),
  // Server-only: the farm fills the owner's stored platform login. The agent checks the page
  // host against `hosts` itself right before filling and never echoes the values back.
  z
    .object({
      name: z.literal('fill_login'),
      hosts: z
        .array(
          z
            .string()
            .max(100)
            .regex(/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/),
        )
        .min(1)
        .max(3),
      username: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\p{Cc}]+$/u),
      password: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\p{Cc}]+$/u),
    })
    .strict(),
])
export type Action = z.infer<typeof actionSchema>
export const inspectSchema = z
  .object({ x: coordinate(VIEWPORT.width - 1), y: coordinate(VIEWPORT.height - 1) })
  .strict()
