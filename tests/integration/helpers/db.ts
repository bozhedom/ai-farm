import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { query, transaction } from '../../../core/db'

async function assertTestDatabase() {
  const [db] = await query('SELECT current_database() AS name')
  if (!db?.name.endsWith('_test')) throw new Error('REFUSING_NON_TEST_DATABASE')
}

/**
 * Applies `db/*.sql` like `scripts/migrate.ts`: in name order, once each, recorded in
 * `migrations`. Older test databases without that table re-apply 001-013, which are
 * idempotent, and are recorded from then on.
 */
export async function applyMigrations() {
  await assertTestDatabase()
  await transaction(async (db) => {
    await query('SELECT pg_advisory_xact_lock(735091)', [], db)
    await query(
      'CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
      [],
      db,
    )
    for (const name of readdirSync('db')
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      if ((await query('SELECT name FROM migrations WHERE name=$1', [name], db)).length) continue
      await query(readFileSync(`db/${name}`, 'utf8'), [], db)
      await query('INSERT INTO migrations(name) VALUES ($1)', [name], db)
    }
  })
}

/** Empties every table except `migrations`, then seeds system state and four agents. */
export async function resetDatabase(
  approach = 'Только проверенные факты и ясная структура.',
  names = ['Альфа', 'Бета', 'Гамма', 'Дельта'],
) {
  await assertTestDatabase()
  const tables = await query(
    `SELECT quote_ident(table_name) AS name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'migrations'
     ORDER BY table_name`,
  )
  await query(`TRUNCATE ${tables.map((t) => t.name).join(',')} RESTART IDENTITY CASCADE`)
  await query('INSERT INTO system_state(id) VALUES(true)')
  for (const name of names)
    await query('INSERT INTO strategies(id,name,approach,generation) VALUES($1,$2,$3,1)', [
      randomUUID(),
      name,
      approach,
    ])
}
