import { z } from 'zod'

/** The JSON schema sent to a paid model with strict structured output. */
export function modelJsonSchema(schema: z.ZodType): Record<string, any> {
  const json = z.toJSONSchema(schema) as Record<string, any>
  delete json.$schema
  return json
}

/**
 * Strict structured output (OpenAI, OpenRouter) rejects with HTTP 400 any object whose
 * properties are not all listed in `required` or that allows additional properties. An optional
 * field must be required and nullable instead. Returns the JSON paths of offending objects.
 */
export function strictSchemaIssues(json: unknown, path = '$'): string[] {
  if (!json || typeof json !== 'object') return []
  if (Array.isArray(json))
    return json.flatMap((item, i) => strictSchemaIssues(item, `${path}[${i}]`))
  const node = json as Record<string, any>
  const issues: string[] = []
  if (node.type === 'object' || node.properties) {
    const keys = Object.keys(node.properties ?? {})
    const required: string[] = Array.isArray(node.required) ? node.required : []
    const missing = keys.filter((key) => !required.includes(key))
    if (missing.length) issues.push(`${path}: not required ${missing.join(', ')}`)
    if (node.additionalProperties !== false) issues.push(`${path}: additionalProperties`)
  }
  for (const [key, value] of Object.entries(node))
    if (value && typeof value === 'object')
      issues.push(...strictSchemaIssues(value, `${path}.${key}`))
  return issues
}

/** Refuses a schema the paid provider would reject, before any money is reserved for it. */
export function assertStrictModelSchema(schema: z.ZodType) {
  const issues = strictSchemaIssues(modelJsonSchema(schema))
  if (issues.length) throw new Error('MODEL_SCHEMA_NOT_STRICT')
}
