import { audit, pool, query, type Connection } from './db'
import type { CritiqueVerdict, IdeaStatus } from './contracts/office'

/**
 * Server rules for ideas: fingerprints, duplicates, deterministic rank and status. A model
 * proposes and criticises; it never ranks, merges or changes a status.
 */
const stopWords = new Set([
  'которые',
  'который',
  'которая',
  'которое',
  'этого',
  'этот',
  'этой',
  'через',
  'также',
  'более',
  'менее',
  'очень',
  'своих',
  'свои',
  'свой',
  'своей',
  'могут',
  'может',
  'нужно',
  'нужен',
  'нужна',
  'нужны',
  'только',
  'после',
  'перед',
  'между',
  'когда',
  'чтобы',
  'потому',
  'например',
  'всех',
  'всего',
  'ваших',
  'наших',
  'если',
  'без',
  'для',
  'from',
  'with',
  'that',
  'this',
])

export function ideaTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4 && !stopWords.has(token))
}

/** Sorted unique normalized tokens of the title and the audience. */
export function ideaFingerprint(title: string, audience: string) {
  return [...new Set(ideaTokens(`${title} ${audience}`))].sort().join(' ')
}

export function jaccard(a: string, b: string) {
  const left = new Set(a.split(' ').filter(Boolean))
  const right = new Set(b.split(' ').filter(Boolean))
  if (!left.size && !right.size) return 1
  let common = 0
  for (const token of left) if (right.has(token)) common++
  return common / (left.size + right.size - common)
}

export const duplicateThreshold = 0.6
export type IdeaFingerprintRow = { id: string; fingerprint: string; created_at?: Date | string }

/** Exact fingerprint first, then the closest Jaccard match of at least 0.6. Oldest wins ties. */
export function findDuplicate(fingerprint: string, candidates: IdeaFingerprintRow[]) {
  const ordered = [...candidates].sort(
    (a, b) =>
      new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime() ||
      a.id.localeCompare(b.id),
  )
  const exact = ordered.find((row) => row.fingerprint === fingerprint)
  if (exact) return exact.id
  let best: { id: string; score: number } | null = null
  for (const row of ordered) {
    const score = jaccard(fingerprint, row.fingerprint)
    if (score >= duplicateThreshold && (!best || score > best.score)) best = { id: row.id, score }
  }
  return best?.id ?? null
}

export type RankInput = {
  verdict: CritiqueVerdict
  domains: number
  farmExecutable: boolean
  startupCostRub: number
  demandSignals: number
}

/**
 * rank = 40*critic + 20*source quality + 15*farm can do it + 15*(1 - startup/100 000 ₽)
 *      + 10*min(1, demand signals/3). Integer arithmetic, result 0..100.
 */
export function rankScore(input: RankInput) {
  const critic = input.verdict === 'PASS' ? 2 : input.verdict === 'REVISE' ? 1 : 0
  const domains = Math.min(3, Math.max(0, Math.trunc(input.domains)))
  const signals = Math.min(3, Math.max(0, Math.trunc(input.demandSignals)))
  const cost = Math.min(100000, Math.max(0, Math.trunc(input.startupCostRub)))
  const total =
    20 * critic * 300000 +
    20 * domains * 100000 +
    (input.farmExecutable ? 15 * 300000 : 0) +
    15 * (100000 - cost) * 3 +
    10 * signals * 100000
  return Math.max(0, Math.min(100, Math.round(total / 300000)))
}

/** PASS and executable: accepted. PASS otherwise: needs a person. BLOCKED: rejected. */
export function decideStatus(verdict: CritiqueVerdict, farmExecutable: boolean): IdeaStatus {
  if (verdict === 'BLOCKED') return 'rejected'
  if (verdict === 'REVISE') return 'new'
  return farmExecutable ? 'accepted' : 'needs_human'
}

/** Ideas of the last 90 days used for duplicate checks and as the critic's context. */
export async function recentIdeas(db: Connection = pool) {
  return query<IdeaFingerprintRow & { title: string; verdict: string; topic_id: string }>(
    `SELECT id,fingerprint,created_at,title,critique->>'verdict' AS verdict,topic_id
     FROM ideas WHERE created_at > now() - interval '90 days' ORDER BY created_at DESC LIMIT 2000`,
    [],
    db,
  )
}

/**
 * Applies the manager's deterministic decisions to every idea still waiting for one. REVISE
 * stays new until the topic is scouted again. Returns the changed ideas for the report.
 */
export async function applyIdeaDecisions(db: Connection) {
  const rows = await query(
    `SELECT id,title,strategy_id,critique->>'verdict' AS verdict,farm_executable,
       research->>'executionNote' AS note
     FROM ideas WHERE status='new' AND ranked_at IS NULL ORDER BY created_at,id FOR UPDATE`,
    [],
    db,
  )
  const changed: { id: string; status: IdeaStatus }[] = []
  for (const row of rows) {
    const status = decideStatus(row.verdict as CritiqueVerdict, row.farm_executable)
    await query('UPDATE ideas SET status=$2,ranked_at=now() WHERE id=$1', [row.id, status], db)
    if (status === 'new') continue
    changed.push({ id: row.id, status })
    if (status === 'needs_human')
      await audit(
        'idea_needs_human',
        `Идея «${row.title}» требует человека. Оставили в рейтинге с планом запуска.`,
        { ideaId: row.id, agentId: row.strategy_id, title: row.title, note: row.note },
        db,
      )
  }
  return changed
}
