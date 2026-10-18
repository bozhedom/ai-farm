import { config } from '../core/config'
import { pool, query } from '../core/db'
import { setSchedule } from '../core/autonomy'
import { startTrading, safeTradingError } from '../core/trading/engine'
import { ensurePortfolios, portfolio, scope } from '../core/trading/store'
import { exchanges } from '../core/trading/types'
import { controlManager, managerModelBlocker, managerProvider } from '../core/manager/runtime'

// Local autopilot: turns on the autonomous loops through the same server functions as the
// office buttons. Paper trading only. It never clears a pause or emergency stop, never touches
// Demo/Live, money limits or capital, and refuses a database outside this computer.
const url = new URL(process.env.DATABASE_URL || '')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('LOCAL_DATABASE_REQUIRED')

const report: string[] = []
try {
  const [state] = await query('SELECT mode FROM system_state WHERE id=true')
  if (state?.mode !== 'running')
    report.push(
      `Ферма: ${state?.mode === 'paused' ? 'на паузе' : 'остановлена'}. Автопилот это не снимает: решение владельца в кабинете.`,
    )
  else report.push('Ферма: работает.')

  if (!config().AUTONOMY_ENABLED)
    report.push('Расписание: выключено в .env (AUTONOMY_ENABLED=false), не меняю.')
  else {
    await setSchedule(true)
    report.push('Расписание разведки, отчётов и отбора: включено.')
  }

  await ensurePortfolios()
  for (const exchange of exchanges) {
    const s = scope(exchange, 'paper')
    const before = await portfolio(s)
    if (before.status === 'running') {
      report.push(`Тренировка ${exchange}: уже работает.`)
      continue
    }
    try {
      await startTrading(s, '')
      report.push(`Тренировка ${exchange}: запущена.`)
    } catch (error) {
      report.push(`Тренировка ${exchange}: не запущена (${safeTradingError(error)}).`)
    }
  }

  const provider = managerProvider()
  const blocker = managerModelBlocker()
  try {
    await controlManager('enable')
    report.push(
      `Менеджер торговли: включён, модель ${provider.model}${provider.demo ? ' (демо-сценарий, без настоящей модели)' : ''}.${blocker ? ` Разборы ждут: ${blocker}.` : ''}`,
    )
  } catch (error) {
    report.push(`Менеджер торговли: не включён (${(error as Error).message}).`)
  }
  report.push('Дальше работу ведёт worker: держите `npm run worker` запущенным.')
} finally {
  await pool.end()
}
console.log(report.join('\n'))
