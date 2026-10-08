import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pool, query, transaction } from '../core/db'
import { ensureStrategyParams } from '../core/agents'

await transaction(async (db) => {
  await query('SELECT pg_advisory_xact_lock(735091)', [], db)
  await query(
    'CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
    [],
    db,
  )
  for (const name of readdirSync('db')
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    if ((await query('SELECT name FROM migrations WHERE name=$1', [name], db)).length) continue
    await query(readFileSync(`db/${name}`, 'utf8'), [], db)
    await query('INSERT INTO migrations(name) VALUES ($1)', [name], db)
    console.log(`Applied ${name}`)
  }
  if (!(await query('SELECT id FROM strategies LIMIT 1', [], db)).length) {
    for (const [name, approach] of [
      ['Альфа', 'Ясная структура, проверяемые характеристики и конкретная польза.'],
      ['Бета', 'Короткие формулировки, только подтверждённые факты.'],
      ['Гамма', 'Вопросы покупателя, ограничения и объяснение выбора.'],
      ['Дельта', 'Практические сценарии использования без выдуманных свойств.'],
    ]) {
      await query(
        'INSERT INTO strategies(id,name,approach,generation) VALUES ($1,$2,$3,1)',
        [randomUUID(), name, approach],
        db,
      )
    }
  }
  // Server-owned agent parameters (policy v3); existing approach text is kept.
  await ensureStrategyParams(db)
})
await pool.end()
