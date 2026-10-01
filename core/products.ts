import { query } from './db'

/** Version history is owner-only through the existing API session middleware. */
export async function productHistory(id: string, before?: number) {
  if (!(await query('SELECT id FROM products WHERE id=$1', [id])).length)
    throw new Error('PRODUCT_NOT_FOUND')
  const versions = await query(
    `SELECT v.version,v.spec,v.checks,v.is_demo,v.created_at,h.critique,
      (SELECT t.model FROM tool_calls t WHERE t.job_id=h.job_id AND t.template=h.template
       AND t.role='Архитектор' LIMIT 1) AS model
     FROM product_versions v JOIN hypotheses h ON h.id=v.hypothesis_id
     WHERE v.product_id=$1 AND ($2::int IS NULL OR v.version<$2)
     ORDER BY v.version DESC LIMIT 21`,
    [id, before ?? null],
  )
  return {
    versions: versions.slice(0, 20),
    nextBefore: versions.length > 20 ? versions[19]!.version : null,
  }
}
