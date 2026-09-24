import { pool, query } from '../core/db'
const [row] = await query(
  "SELECT worker_heartbeat>now()-interval '90 seconds' AS healthy FROM system_state WHERE id=true",
)
await pool.end()
process.exit(row?.healthy ? 0 : 1)
