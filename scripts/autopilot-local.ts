import { pool } from '../core/db'
import { runAutopilot } from '../core/autopilot'

// Local autopilot: one pass of the server autopilot (core/autopilot.ts) on this computer. It
// turns on the farm schedule, Paper trading on the four exchanges and the trading manager
// through the same server functions as the office buttons. It never clears a pause or emergency
// stop, never restarts a paused or stopped portfolio, never touches Demo/Live, money limits or
// capital, and refuses a database outside this computer. On a server use AUTOPILOT_ON_BOOT=true.
const url = new URL(process.env.DATABASE_URL || '')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('LOCAL_DATABASE_REQUIRED')

try {
  const decisions = await runAutopilot({ demo: false, execution: false })
  console.log(
    [
      ...decisions.map((d) => d.text),
      'Дальше работу ведёт worker: держите `npm run worker` запущенным.',
    ].join('\n'),
  )
} finally {
  await pool.end()
}
