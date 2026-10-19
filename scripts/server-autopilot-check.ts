import { config, paidModelId } from '../core/config'
import { pool, query } from '../core/db'
import { autonomyView, autopilotInput, autopilotPlan } from '../core/autopilot'
import { managerBudget, managerModelBlocker } from '../core/manager/runtime'
import { managerLimits } from '../core/manager/limits'
import { budgetSummary } from '../core/budget'

// Read-only status of every autonomous loop in plain Russian: what runs, what waits and why.
// It switches nothing on: lines marked «включит» are what the autopilot would do next.
const rub = (kopecks: number) => `${(kopecks / 100).toFixed(2).replace('.', ',')} ₽`
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`
const ago = (iso: string | null) => {
  if (!iso) return 'никогда'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  return s < 120
    ? `${s} с назад`
    : s < 7200
      ? `${Math.round(s / 60)} мин назад`
      : `${Math.round(s / 3600)} ч назад`
}
const loopState = {
  ok: 'работает',
  failing: 'ошибка',
  stale: 'давно не отвечал',
  stuck: 'завис',
  never: 'ещё не запускался',
}
const hints: Record<string, string> = {
  AUTONOMY_ENABLED_FALSE: 'в .env AUTONOMY_ENABLED=false',
  WORKSPACE_MODE_TRADING: 'в .env WORKSPACE_MODE=trading; для разведки нужен studio',
  TRADING_CREDENTIALS_REQUIRED: 'ключи <БИРЖА>_DEMO_API_KEY/SECRET[/PASSPHRASE] в .env',
  EXECUTION_CREDENTIALS_REQUIRED: 'ключи EXECUTION_* для направления, см. docs/29-execution.md',
  EXECUTION_WALLET_REQUIRED:
    'EXECUTION_DEFI_DEMO_CONFIG и ключ кошелька, см. docs/29-execution-aave.md',
  EXECUTION_ASSET_REGISTRY_REQUIRED: 'EXECUTION_ARBITRAGE_ASSETS, см. docs/29-execution.md',
  MANAGER_MODEL_TOO_EXPENSIVE: 'MANAGER_RESERVE_KOPECKS меньше оценки запроса',
  MANAGER_COST_REVIEW: 'неясный платный вызов: проверьте журнал вызовов в кабинете',
}

const out: string[] = []
const line = (text = '') => out.push(text)
try {
  const c = config()
  const [system] = await query(
    'SELECT mode,schedule_enabled,worker_heartbeat,provider_readiness FROM system_state WHERE id=true',
  )
  const view = await autonomyView()
  const heartbeat = system?.worker_heartbeat
    ? new Date(system.worker_heartbeat).toISOString()
    : null
  const alive = !!heartbeat && Date.now() - Date.parse(heartbeat) < 90_000

  line('АВТОНОМНАЯ РАБОТА ФЕРМЫ')
  line(
    `Ферма: ${system?.mode === 'running' ? 'работает' : system?.mode === 'paused' ? 'НА ПАУЗЕ (снимаете вы: «Продолжить» в кабинете)' : 'АВАРИЙНЫЙ СТОП (снимаете только вы)'}`,
  )
  line(
    `Обработчик (worker): ${alive ? 'на связи' : 'НЕТ СИГНАЛА'}, последний сигнал ${ago(heartbeat)}`,
  )
  line(
    `Автопилот: ${view.autopilotEnabled ? `включён, проверка каждые ${view.intervalMinutes} мин` : 'выключен (AUTOPILOT_ON_BOOT=false)'}; последняя проверка ${ago(view.checkedAt)}`,
  )

  line()
  line('МОДЕЛЬ')
  const provider =
    c.MODEL_PROVIDER === 'openai'
      ? `${paidModelId(c)} через ${c.OPENAI_TRANSPORT === 'openrouter' ? 'OpenRouter' : 'OpenAI'}`
      : c.MODEL_PROVIDER === 'demo'
        ? 'демо (без настоящей модели)'
        : c.MODEL_PROVIDER
  line(`Модель: ${provider}; поиск: ${c.SEARCH_PROVIDER}`)
  const ready = system?.provider_readiness
  line(
    `Готовность: модель ${ready?.model ? 'да' : 'НЕТ'}, поиск ${ready?.search ? 'да' : 'НЕТ'}${ready?.checkedAt ? ` (${ago(ready.checkedAt)})` : ''}`,
  )
  const budget = await budgetSummary()
  if (c.MODEL_PROVIDER === 'openai')
    line(
      `Долларовый предел: потрачено ${usd(budget.openaiSpentMicrousd)} из ${usd(c.OPENAI_TOTAL_BUDGET_MICROUSD)}${budget.openaiSpentMicrousd >= c.OPENAI_TOTAL_BUDGET_MICROUSD ? ' — ИСЧЕРПАН, вызовы остановлены' : ''}`,
    )
  line(
    `Сегодня: ${rub(budget.daySpent)} из ${rub(c.DAILY_BUDGET_KOPECKS)}, в резервах ${rub(budget.outstanding)}; месяц: ${rub(budget.monthSpent)} из ${rub(c.MONTHLY_BUDGET_KOPECKS)}`,
  )
  const p = view.pacing
  line(
    p.enabled
      ? `Распределение по часам: на этот час разведке ${rub(p.hourlyAllowanceKopecks)}, занято ${rub(p.usedThisHourKopecks)}; для менеджера отложено ${rub(p.managerFloorKopecks)}`
      : 'Распределение по часам выключено (PACING_ENABLED=false): задачи берут бюджет сразу.',
  )
  const limits = managerLimits()
  const mb = await managerBudget()
  const blocker = managerModelBlocker()
  line(
    `Менеджер: разборов сегодня ${mb.runs} из ${limits.maxDailyRuns} (раз в ${Math.round(limits.intervalMs / 60_000)} мин), потрачено ${rub(mb.spent)} из ${rub(limits.dailyKopecks)}, резерв на разбор ${rub(limits.reserveKopecks)}${blocker ? `; БЛОКЕР: ${hints[blocker] ?? blocker}` : ''}${mb.uncertain ? '; БЛОКЕР: неясный платный вызов' : ''}`,
  )
  const [manager] = await query('SELECT enabled,last_error FROM trading_manager WHERE id=true')
  if (manager?.last_error) line(`Последняя причина ожидания менеджера: ${manager.last_error}`)

  line()
  line('ЦИКЛЫ ОБРАБОТЧИКА')
  for (const loop of view.loops)
    line(
      `- ${loop.label}: ${loopState[loop.state]}${loop.state === 'failing' ? ` (${loop.error}, подряд ${loop.consecutiveFailures})` : ''}; успех ${ago(loop.lastOkAt)}`,
    )

  line()
  line('НАПРАВЛЕНИЯ (что сделает автопилот)')
  const plan = autopilotPlan(await autopilotInput())
  for (const d of plan) {
    const mark = d.action !== 'none' ? 'включит' : d.status === 'running' ? 'работает' : 'ждёт'
    const text =
      d.action === 'none'
        ? d.text
        : d.action === 'configure_execution'
          ? `${d.name}: выделит ${c.AUTOPILOT_EXECUTION_PAPER_USDT} виртуальных USDT и запустит`
          : `${d.name ?? d.key}`
    const hint =
      d.code && hints[d.code]
        ? ` [${hints[d.code]}]`
        : d.code && d.status !== 'running'
          ? ` [${d.code}]`
          : ''
    line(`- ${mark}: ${text}${hint}`)
  }
  const failed = view.decisions.filter((d) => d.status === 'failed')
  if (failed.length) {
    line()
    line('НЕ ПОЛУЧИЛОСЬ ПРИ ПОСЛЕДНЕЙ ПРОВЕРКЕ')
    for (const d of failed) line(`- ${d.text} [${d.code}]`)
  }
  const [jobs] = await query(
    "SELECT count(*) FILTER (WHERE status='queued')::int AS queued,count(*) FILTER (WHERE status='running')::int AS running,count(*) FILTER (WHERE error_code='FARM_PACING_WAIT' AND status='queued')::int AS paced FROM jobs",
  )
  line()
  line(
    `Очередь заданий: в очереди ${jobs?.queued ?? 0} (ждут своего часа ${jobs?.paced ?? 0}), выполняются ${jobs?.running ?? 0}`,
  )
  line('Остановить всё: «Пауза» или «Аварийный стоп» в кабинете. Автопилот их не снимает.')
} finally {
  await pool.end()
}
console.log(out.join('\n'))
