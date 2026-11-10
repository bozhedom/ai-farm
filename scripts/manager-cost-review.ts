import { reviewManagerTruncation } from '../core/manager/cost-review'
import { pool } from '../core/db'
// Explicit operator action after inspecting the failed call, never part of the worker loop.
const id = process.argv[2]
try {
  if (!id) throw new Error('Usage: tsx scripts/manager-cost-review.ts CALL_UUID')
  console.log(JSON.stringify(await reviewManagerTruncation(id)))
} finally {
  await pool.end()
}
