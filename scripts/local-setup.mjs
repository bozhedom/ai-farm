import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml']
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('LOCAL_SETUP_STEP_FAILED')
}
run('node', ['scripts/setup.mjs'])
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
// Select live providers only after the local model is available. Never touch secrets or payment mode.
let env = original
for (const [key, value] of Object.entries({
  MODEL_PROVIDER: 'ollama',
  SEARCH_PROVIDER: 'searxng',
})) {
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  env = pattern.test(env) ? env.replace(pattern, `${key}=${value}`) : env + `\n${key}=${value}\n`
}
writeFileSync('.env', env, { mode: 0o600 })
run('docker', [...compose, '--profile', 'app', 'up', '-d', '--build', 'web', 'worker', 'backup'])
console.log(
  'Локальная модель и поиск включены. Откройте APP_ORIGIN из .env и нажмите «Новое исследование».',
)
