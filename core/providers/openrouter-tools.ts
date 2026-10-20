import { z } from 'zod'
import { reportProgress } from '../activity'
import { openrouterPaidRequest } from './openrouter-paid'

/**
 * The only model call path that may carry function tools: computer use. The tools are the
 * browser actions and bookkeeping functions declared by core/computer-use/tools.ts; nothing else
 * is ever sent. Exactly one tool call is accepted per answer, its arguments are returned raw for
 * the server-side zod validation, and nothing is retried.
 */
export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}
export type RawToolCall = { name: string; arguments: unknown; note: string }

const toolCallSchema = z.object({
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(60), arguments: z.string().max(20000) }),
})

export async function openrouterToolCall(args: {
  key: string
  system: string
  text: string
  imagePng: Buffer | null
  tools: ToolDefinition[]
  maxTokens: number
}): Promise<{ value: RawToolCall; microusd: number; cost: number }> {
  if (!args.tools.length || args.tools.length > 16) throw new Error('COMPUTER_USE_TOOLS_INVALID')
  const names = new Set(args.tools.map((tool) => tool.name))
  const content: Record<string, unknown>[] = [{ type: 'text', text: args.text }]
  if (args.imagePng)
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${args.imagePng.toString('base64')}` },
    })
  const { choice, microusd, cost } = await openrouterPaidRequest({
    key: args.key,
    maxTokens: args.maxTokens,
    body: {
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content },
      ],
      tools: args.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        },
      })),
      tool_choice: 'required',
      // No Astra endpoint accepts parallel_tool_calls with require_parameters (HTTP 404, checked
      // 20.10.2026); a reply with more than one call is rejected below instead.
    },
  })
  if (!['tool_calls', 'stop'].includes(choice?.finish_reason))
    throw new Error('MODEL_OUTPUT_INCOMPLETE')
  const calls = choice.message?.tool_calls
  if (!Array.isArray(calls) || calls.length !== 1) throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  const parsed = toolCallSchema.safeParse(calls[0])
  if (!parsed.success || !names.has(parsed.data.function.name))
    throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  let parameters: unknown
  try {
    parameters = JSON.parse(parsed.data.function.arguments)
  } catch {
    throw new Error('COMPUTER_USE_TOOL_CALL_INVALID')
  }
  const note = typeof choice.message?.content === 'string' ? choice.message.content : ''
  await reportProgress(args.key, parsed.data.function.arguments.length + note.length)
  return {
    value: { name: parsed.data.function.name, arguments: parameters, note: note.slice(0, 2000) },
    microusd,
    cost,
  }
}
