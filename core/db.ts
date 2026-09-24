import pg from 'pg'
import { config } from './config'

export const pool = new pg.Pool({
  connectionString: config().DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 5000,
})
pool.on('error', () => {
  console.error('DB_POOL_ERROR')
})
export type Connection = Pick<pg.PoolClient, 'query'>

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  db: Connection = pool,
): Promise<T[]> {
  return (await db.query<T>(text, values)).rows
}

export async function transaction<T>(fn: (db: Connection) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function audit(
  kind: string,
  message: string,
  data: Record<string, unknown> = {},
  db: Connection = pool,
) {
  await query(
    'INSERT INTO audit_events(kind, message, data) VALUES ($1,$2,$3)',
    [kind, message, data],
    db,
  )
}
