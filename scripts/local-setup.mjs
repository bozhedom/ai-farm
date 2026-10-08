import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml']
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('LOCAL_SETUP_STEP_FAILED')
}
run('node', ['scripts/setup.mjs'])
// Stop only this local stack. Pending jobs, invoices and budgets remain in PostgreSQL.
// Give already running jobs time to finish before replacing the configured provider.
run('docker', [...compose, 'stop', '--timeout', '180', 'worker', 'web'])
run('docker', [...compose, 'up', '-d', 'ollama', 'search'])
const original = readFileSync('.env', 'utf8')
const settings = parseEnv(original)
run('docker', [
  ...compose,
  'exec',
  '-T',
  'ollama',
  'ollama',
  'pull',
  settings.OLLAMA_MODEL || 'qwen3:4b',
])
// Select free providers only after the model is available. Preserve secrets, payment mode and budgets.
// The server may allow automation, but an existing database pause or schedule switch is never reset.
let env = original
for (const [key, value] of Object.entries({
  MODEL_PROVIDER: 'ollama',
  SEARCH_PROVIDER: 'searxng',
  APP_ORIGIN: 'http://localhost:3210',
  SECURE_COOKIE: 'false',
  AUTONOMY_ENABLED: 'true',
  OLLAMA_URL: 'http://127.0.0.1:11434',
  SEARXNG_URL: 'http://127.0.0.1:8088',
  LOCAL_UID: String(process.getuid?.() ?? 1000),
  LOCAL_GID: String(process.getgid?.() ?? 1000),
})) {
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, 'gm')
  env = pattern.test(env) ? env.replace(pattern, `${key}=${value}`) : env + `\n${key}=${value}\n`
}
const temporary = `.env.local-setup.${process.pid}.tmp`
try {
  writeFileSync(temporary, env, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, '.env')
} finally {
  rmSync(temporary, { force: true })
}
run('docker', [
  ...compose,
  '--profile',
  'app',
  'up',
  '-d',
  '--build',
  '--wait',
  '--wait-timeout',
  '240',
  'web',
  'worker',
  'backup',
  'observer',
])
console.log(
  'Готово: витрина http://localhost:3210, кабинет http://localhost:3210/office. Пароль владельца находится в поле OWNER_PASSWORD файла .env.',
)
console.log(
  'Работают локальная модель, поиск, заказы, резервные копии и наблюдение. Платы за модельные и поисковые API нет.',
)
console.log(
  'Если раньше была включена пауза, нажмите «Продолжить работу». Если автозапуск выключен, нажмите «Включить автозапуск». История, принятые заказы и лимиты сохранены.',
)
