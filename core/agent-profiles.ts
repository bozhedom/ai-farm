import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { config, paidModelId } from './config'
import { audit, query, transaction, type Connection } from './db'

export const modelRoles = [
  { id: 'scout', name: 'Разведчик' },
  { id: 'researcher', name: 'Исследователь' },
  { id: 'critic', name: 'Критик' },
  { id: 'architect', name: 'Архитектор' },
  { id: 'writer', name: 'Исполнитель' },
  { id: 'reviewer', name: 'Проверяющий' },
  { id: 'director', name: 'Руководитель' },
  { id: 'proposal', name: 'Автор отклика' },
  { id: 'manager', name: 'Торговый менеджер' },
  { id: 'browser', name: 'Оператор браузера' },
  { id: 'platform-writer', name: 'Исполнитель заданий площадки' },
] as const
export const roleId = z.enum(modelRoles.map((r) => r.id))
export type ModelPricing = { inputNano: number; outputNano: number }
type Profile = {
  role: string
  instruction: string
  model: string
  revision: number
  pricing: ModelPricing | null
}
type Context = { id: string; role: string; title: string; content: string }
type Snapshot = { profiles: Profile[]; contexts: Context[] }
const runtime = new AsyncLocalStorage<Snapshot>()
const roleRuntime = new AsyncLocalStorage<string>()
const definition = (role: string) => modelRoles.find((r) => r.id === role || r.name === role)
export const masterPrompt = () => readFileSync('prompts/master.md', 'utf8')
export function roleInstruction(role: string) {
  if (role === 'Разбор торговых инструкций')
    return readFileSync('prompts/trading-instructions.md', 'utf8')
  if (role === 'Помощник кабинета') return readFileSync('prompts/assistant.md', 'utf8')
  const item = definition(role)
  if (!item) return ''
  const baseline = readFileSync(`prompts/roles/${item.id}.md`, 'utf8')
  const extra = runtime.getStore()?.profiles.find((p) => p.role === item.id)?.instruction
  return (
    baseline +
    (extra ? `\nУточнения владельца для роли (не отменяют общие правила):\n${extra}` : '')
  )
}
export function roleContext(role: string) {
  const id = definition(role)?.id
  if (!id) return []
  return (runtime.getStore()?.contexts ?? [])
    .filter((c) => c.role === id || c.role === 'all')
    .map(({ id, title, content }) => ({ id, title, content }))
}
export function roleModel(role: string) {
  const c = config()
  if (c.MODEL_PROVIDER !== 'openai' || c.OPENAI_TRANSPORT !== 'openrouter') return ''
  return runtime.getStore()?.profiles.find((p) => p.role === definition(role)?.id)?.model || ''
}
export function rolePricing(role: string) {
  if (!roleModel(role)) return undefined
  return (
    runtime.getStore()?.profiles.find((p) => p.role === definition(role)?.id)?.pricing ?? undefined
  )
}
export function currentPricing() {
  return rolePricing(roleRuntime.getStore() ?? '')
}
export function currentModel() {
  return roleModel(roleRuntime.getStore() ?? '') || paidModelId(config())
}
export const withModelRole = <T>(role: string, work: () => T): T => roleRuntime.run(role, work)
export async function withAgentProfiles<T>(work: () => Promise<T>, fresh = false): Promise<T> {
  if (!fresh && runtime.getStore()) return work()
  const [profiles, contexts] = await Promise.all([
    query<Profile>('SELECT role,instruction,model,revision,pricing FROM agent_profiles'),
    query<Context>('SELECT id,role,title,content FROM agent_context ORDER BY created_at,id'),
  ])
  return runtime.run({ profiles, contexts }, work)
}
export const profileSchema = z
  .object({
    role: roleId,
    instruction: z.string().trim().max(6000),
    model: z
      .string()
      .trim()
      .max(160)
      .regex(/^(?:[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+)?$/),
    revision: z.number().int().nonnegative(),
  })
  .strict()
export const contextSchema = z
  .object({
    role: z.union([roleId, z.literal('all')]),
    title: z.string().trim().min(1).max(120),
    content: z
      .string()
      .trim()
      .min(1)
      .max(12000)
      .refine((s) => !s.includes('\0')),
  })
  .strict()

/** Dollars per token to integer nanodollars, rounded upward. No floating point accounting. */
export function priceNano(value: string): number | null {
  if (!/^\d{1,6}(?:\.\d{1,18})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const exact = BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, '0').slice(0, 9))
  const rounded = exact + (/[1-9]/.test(fraction.slice(9)) ? 1n : 0n)
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null
}

/** Public catalog, fixed host; never follows a model-provided URL or sends a key. */
export async function availableModels() {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('MODEL_CATALOG_UNAVAILABLE')
  const raw = await response.text()
  if (raw.length > 8_000_000) throw new Error('MODEL_CATALOG_UNAVAILABLE')
  const data = z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          context_length: z.number(),
          pricing: z.object({
            prompt: z.string(),
            completion: z.string(),
            request: z.string().optional(),
          }),
          supported_parameters: z.array(z.string()).optional(),
          architecture: z.object({ input_modalities: z.array(z.string()) }).optional(),
        }),
      ),
    })
    .parse(JSON.parse(raw))
  return data.data.flatMap((m) => {
    const inputNano = priceNano(m.pricing.prompt),
      outputNano = priceNano(m.pricing.completion)
    if (
      inputNano === null ||
      outputNano === null ||
      inputNano > 10000 ||
      outputNano > 50000 ||
      priceNano(m.pricing.request ?? '0') !== 0 ||
      m.context_length < 100000 ||
      !m.supported_parameters?.includes('structured_outputs') ||
      m.id.includes(':free')
    )
      return []
    return [
      {
        id: m.id,
        name: m.name,
        pricing: { inputNano, outputNano },
        browser:
          !!m.architecture?.input_modalities.includes('image') &&
          !!m.supported_parameters?.includes('tools'),
      },
    ]
  })
}
export async function prepareProfile(value: unknown) {
  const input = profileSchema.parse(value)
  let pricing: ModelPricing | null = null
  if (input.model) {
    const c = config()
    if (c.MODEL_PROVIDER !== 'openai' || c.OPENAI_TRANSPORT !== 'openrouter')
      throw new Error('MODEL_SWITCH_REQUIRES_OPENROUTER')
    const models = await availableModels()
    const selected = models.find(
      (m) => m.id === input.model && (input.role !== 'browser' || m.browser),
    )
    if (!selected) throw new Error('MODEL_UNSUPPORTED')
    pricing = selected.pricing
  }
  return { input, pricing }
}
export async function saveProfile(value: unknown) {
  const prepared = await prepareProfile(value)
  return transaction((db) => savePreparedProfile(prepared, db))
}
export async function refreshManagerInstructions(db: Connection) {
  await query('INSERT INTO trading_manager(id) VALUES(true) ON CONFLICT DO NOTHING', [], db)
  await query(
    `UPDATE trading_manager SET instruction_revision=instruction_revision+1,
    requested_at=CASE WHEN enabled THEN coalesce(requested_at,now()) ELSE requested_at END WHERE id=true`,
    [],
    db,
  )
  await query(
    "UPDATE trading_manager_tasks SET status='rejected',reason='MANAGER_INSTRUCTIONS_CHANGED' WHERE status='queued'",
    [],
    db,
  )
}
export async function savePreparedProfile(
  { input, pricing }: Awaited<ReturnType<typeof prepareProfile>>,
  db: Connection,
) {
  await query('SELECT pg_advisory_xact_lock(735097)', [], db)
  const [old] = await query('SELECT revision FROM agent_profiles WHERE role=$1', [input.role], db)
  if ((old?.revision ?? 0) !== input.revision) throw new Error('PROFILE_CHANGED')
  await query(
    `INSERT INTO agent_profiles(role,instruction,model,pricing) VALUES($1,$2,$3,$4)
      ON CONFLICT(role) DO UPDATE SET instruction=$2,model=$3,pricing=$4,revision=agent_profiles.revision+1,updated_at=now()`,
    [input.role, input.instruction, input.model, pricing],
    db,
  )
  await audit(
    'agent_profile_changed',
    'Владелец изменил инструкции и модель роли.',
    {
      role: input.role,
      model: input.model,
      revision: input.revision + 1,
      instructionHash: createHash('sha256').update(input.instruction).digest('hex'),
    },
    db,
  )
  if (input.role === 'manager') await refreshManagerInstructions(db)
}
export async function addContext(value: unknown) {
  const input = contextSchema.parse(value)
  return transaction(async (db) => {
    await query('SELECT pg_advisory_xact_lock(735097)', [], db)
    const [total] = await query(
      'SELECT count(*)::int AS n,coalesce(sum(length(content)),0)::int AS chars FROM agent_context',
      [],
      db,
    )
    if (total!.n >= 20 || total!.chars + input.content.length > 16000)
      throw new Error('CONTEXT_LIMIT')
    const id = randomUUID()
    await query(
      'INSERT INTO agent_context(id,role,title,content) VALUES($1,$2,$3,$4)',
      [id, input.role, input.title, input.content],
      db,
    )
    if (input.role === 'manager' || input.role === 'all') await refreshManagerInstructions(db)
    await audit(
      'agent_context_added',
      'Владелец добавил контекст для агентов.',
      { id, role: input.role, chars: input.content.length },
      db,
    )
    return { id }
  })
}
export async function deleteContext(id: string) {
  z.uuid().parse(id)
  return transaction(async (db) => {
    await query('SELECT pg_advisory_xact_lock(735097)', [], db)
    const rows = await query('DELETE FROM agent_context WHERE id=$1 RETURNING role', [id], db)
    if (!rows.length) throw new Error('CONTEXT_NOT_FOUND')
    if (rows[0]!.role === 'manager' || rows[0]!.role === 'all') await refreshManagerInstructions(db)
    await audit(
      'agent_context_deleted',
      'Владелец удалил контекст из следующих запусков.',
      { id, role: rows[0]!.role },
      db,
    )
  })
}
export async function profilesView() {
  return withAgentProfiles(async () => ({
    master: masterPrompt(),
    switchAvailable:
      config().MODEL_PROVIDER === 'openai' && config().OPENAI_TRANSPORT === 'openrouter',
    defaultModel:
      config().MODEL_PROVIDER === 'openai' ? paidModelId(config()) : config().MODEL_PROVIDER,
    roles: modelRoles.map((r) => ({
      ...r,
      instruction: runtime.getStore()!.profiles.find((p) => p.role === r.id)?.instruction ?? '',
      model: roleModel(r.id),
      revision: runtime.getStore()!.profiles.find((p) => p.role === r.id)?.revision ?? 0,
      effectivePrompt: masterPrompt() + '\n' + roleInstruction(r.id),
    })),
    contexts: runtime.getStore()!.contexts,
  }))
}
