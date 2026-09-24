import { AsyncLocalStorage } from 'node:async_hooks'
import { audit, query } from './db'

export const activityContext = new AsyncLocalStorage<{ jobId: string }>()
export type CallActivity = {
  template?: string
  taskLabel: string
  provider: string
  model?: string
}

/** Counts generated characters, never exposes unvalidated text or private reasoning. */
export async function reportProgress(key: string, characters: number) {
  await query(
    "UPDATE tool_calls SET progress_chars=$2,heartbeat_at=now() WHERE call_key=$1 AND status='pending'",
    [key, characters],
  )
}

export async function reportValidation(key: string, issues: unknown[], retry: boolean) {
  await audit(
    'model_schema_validation',
    retry
      ? 'Локальная модель исправляет формат ответа. Разрешена одна повторная попытка.'
      : 'Повторный ответ локальной модели не прошёл проверку формата.',
    { callKey: key, issues, retry },
  )
  if (retry)
    await query(
      "UPDATE tool_calls SET task_label='Исправляет формат ответа по замечаниям валидатора (попытка 2 из 2)',progress_chars=0,heartbeat_at=now() WHERE call_key=$1 AND status='pending'",
      [key],
    )
}

export function resultSummary(value: unknown): string {
  if (Array.isArray(value)) return `Найдено источников: ${value.length}`
  if (!value || typeof value !== 'object') return ''
  const v = value as Record<string, unknown>
  if (typeof v.reason === 'string') return `${v.verdict}: ${v.reason}`.slice(0, 700)
  for (const field of ['title', 'name', 'text'])
    if (typeof v[field] === 'string') return v[field].slice(0, 700)
  return ''
}
