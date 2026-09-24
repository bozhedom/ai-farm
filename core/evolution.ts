import { randomUUID } from 'node:crypto'
import { audit, query, transaction } from './db'

export type Score = {
  id: string
  visits: number
  delivered: number
  revenue: number
  refunds: number
  fees: number
  costs: number
  violations: number
}
export type Evaluation = {
  decision: 'HOLD' | 'ROTATE' | 'CLOSED'
  reason: string
  winners: string[]
  losers: string[]
}
export function assess(
  scores: Score[],
  ageDays: number,
  comparable: boolean,
  obligations = false,
): Evaluation {
  const hold = (reason: string): Evaluation => ({
    decision: ageDays >= 28 ? 'CLOSED' : 'HOLD',
    reason,
    winners: [],
    losers: [],
  })
  if (scores.length !== 4 || new Set(scores.map((s) => s.id)).size !== 4 || !comparable)
    return hold('Недостаточно сопоставимых участников и условий.')
  if (obligations) return hold('Есть незавершённые обязательства.')
  if (ageDays < 14) return hold('Окно наблюдения и созревания ещё не завершено.')
  if (
    scores.some((s) =>
      Object.entries(s).some(([k, v]) => k !== 'id' && (!Number.isSafeInteger(v) || Number(v) < 0)),
    )
  )
    return hold('Некорректные метрики.')
  if (scores.some((s) => s.visits < 100 || s.delivered < 10 || s.violations > 0))
    return hold('Нужно 100 посещений и 10 выданных покупок на стратегию без нарушений.')
  const ranked = scores
    .map((s) => ({ ...s, contribution: s.revenue - s.refunds - s.fees - s.costs }))
    .sort((a, b) => b.contribution / b.visits - a.contribution / a.visits)
  const second = ranked[1]!,
    third = ranked[2]!
  if (ranked[0]!.contribution <= 0 || second.contribution <= 0)
    return hold('У двух лидеров должен быть положительный вклад.')
  if (
    second.contribution / second.visits - third.contribution / third.visits <
    0.2 * (second.contribution / second.visits)
  )
    return hold('Разрыв между вторым и третьим меньше 20%.')
  return {
    decision: 'ROTATE',
    reason: 'Пороги сопоставимого эксперимента выполнены.',
    winners: ranked.slice(0, 2).map((s) => s.id),
    losers: ranked.slice(2).map((s) => s.id),
  }
}

export async function evaluateWeek(key: string) {
  await transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const age = Math.floor(
      (Date.now() - new Date(state!.generation_started_at).getTime()) / 86400000,
    )
    const decision = age >= 28 ? 'CLOSED' : 'HOLD'
    if (decision === 'CLOSED') {
      await query('UPDATE system_state SET research_enabled=false WHERE id=true', [], db)
    }
    const reason =
      age >= 28
        ? 'Эксперимент завершён без денежного победителя: за 28 дней нет реальных сопоставимых продаж.'
        : 'Тестовые платежи исключены из выручки. Данных для денежного отбора нет.'
    const rows = await query(
      'INSERT INTO evaluations(id,evaluation_key,generation,decision,reason,details) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(evaluation_key) DO NOTHING RETURNING id',
      [randomUUID(), key, state!.generation, decision, reason, { realRevenueKopecks: 0 }],
      db,
    )
    if (rows.length)
      await audit('evaluation', reason, { generation: state!.generation, decision }, db)
  })
}

export async function simulateEvolution(expectedGeneration: number) {
  return transaction(async (db) => {
    const [state] = await query('SELECT * FROM system_state WHERE id=true FOR UPDATE', [], db)
    const [old] = await query(
      'SELECT * FROM evaluations WHERE evaluation_key=$1',
      [`simulation:${expectedGeneration}`],
      db,
    )
    if (old) return old
    if (state?.mode !== 'running') throw new Error('SIMULATION_PAUSED')
    if (state.generation !== expectedGeneration) throw new Error('GENERATION_CHANGED')
    if (
      (
        await query(
          "SELECT id FROM orders WHERE status IN ('paid','running','manual_review') LIMIT 1",
          [],
          db,
        )
      ).length
    )
      throw new Error('OPEN_OBLIGATIONS')
    const strategies = await query(
      "SELECT * FROM strategies WHERE status='active' ORDER BY created_at,id",
      [],
      db,
    )
    if (strategies.length !== 4) throw new Error('INVALID_POPULATION')
    const scores: Score[] = strategies.map((s, i) => ({
      id: s.id,
      visits: 400,
      delivered: 20,
      revenue: [1000000, 900000, 700000, 800000][i]!,
      refunds: [50000, 0, 100000, 150000][i]!,
      fees: 0,
      costs: [165000, 141500, 144500, 208000][i]!,
      violations: 0,
    }))
    const result = assess(scores, 14, true)
    if (result.decision !== 'ROTATE') throw new Error('SIMULATION_INVALID')
    await query(
      "UPDATE strategies SET status='archived',archived_at=now() WHERE id=ANY($1::uuid[])",
      [result.losers],
      db,
    )
    const children = []
    for (const id of result.winners) {
      const parent = strategies.find((s) => s.id === id)!
      const child = {
        id: randomUUID(),
        parentId: id,
        name: `${parent.name.split(' · ')[0]} · ${state.generation + 1}`,
      }
      await query(
        'INSERT INTO strategies(id,name,approach,parent_id,generation) VALUES($1,$2,$3,$4,$5)',
        [child.id, child.name, parent.approach, id, state.generation + 1],
        db,
      )
      children.push(child)
    }
    await query(
      'UPDATE system_state SET generation=generation+1,generation_started_at=now(),research_enabled=true WHERE id=true',
      [],
      db,
    )
    const details = { ...result, scores, children, simulation: true }
    const [record] = await query(
      "INSERT INTO evaluations(id,evaluation_key,generation,decision,reason,details) VALUES($1,$2,$3,'SIMULATION',$4,$5) RETURNING *",
      [
        randomUUID(),
        `simulation:${expectedGeneration}`,
        expectedGeneration,
        'Демонстрационная замена 2 из 4. Тестовые цифры не внесены в финансовый журнал.',
        details,
      ],
      db,
    )
    await audit(
      'simulation',
      'Симуляция: две стратегии архивированы, созданы две копии лидеров.',
      { generation: expectedGeneration, children },
      db,
    )
    return record
  })
}
