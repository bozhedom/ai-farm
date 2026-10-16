import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'

// This launcher cannot enable real money or connect a remote database.
const url = new URL(process.env.DATABASE_URL || '')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('LOCAL_DATABASE_REQUIRED')
process.env.EXECUTION_LIVE_ENABLED = 'false'
process.env.EXECUTION_LIVE_ACCEPTED_TRACKS = ''
process.env.TRADING_LIVE_ENABLED = 'false'
process.env.HOST = '127.0.0.1'
process.env.PORT = process.env.EXECUTION_LOCAL_PORT || '3214'
if (!/^\d{4,5}$/.test(process.env.PORT)) throw new Error('LOCAL_PORT_INVALID')
process.env.APP_ORIGIN = `http://localhost:${process.env.PORT}`
process.env.SECURE_COOKIE = 'false'
const localFile = '.secrets/execution-aave-demo.json'
if (existsSync(localFile)) {
  const local = JSON.parse(await readFile(localFile, 'utf8'))
  if (local.config?.network !== 'local') throw new Error('LOCAL_AAVE_REQUIRED')
  process.env.EXECUTION_DEFI_DEMO_CONFIG = JSON.stringify(local.config)
  process.env.EXECUTION_DEFI_DEMO_PRIVATE_KEY = local.privateKey
}
await mkdir('output', { recursive: true })
async function command(args: string[]) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env })
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
  if (code !== 0) throw new Error('LOCAL_PREPARATION_FAILED')
}
await command(['--import', 'tsx', 'scripts/migrate.ts'])
if (!existsSync('.output/server/index.mjs')) throw new Error('RUN_NPM_BUILD_FIRST')
const server = spawn(process.execPath, ['.output/server/index.mjs'], {
  stdio: 'inherit',
  env: process.env,
})
const { executionTick } = await import('../core/execution/engine')
const { pool } = await import('../core/db')
const { EXECUTION_POLICY } = await import('../core/policy')
let stopping = false
const abort = new AbortController()
function stop() {
  stopping = true
  abort.abort()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.once('exit', () => stop())
await writeFile('output/execution-local.pid', String(process.pid), { mode: 0o600 })
console.log(`Local execution: ${process.env.APP_ORIGIN}/office/earnings?track=yield`)
try {
  while (!stopping) {
    try {
      await executionTick(undefined, () => stopping)
    } catch {
      console.error('LOCAL_EXECUTION_TICK_FAILED')
    }
    await pause(EXECUTION_POLICY.tickMs, undefined, { signal: abort.signal }).catch(() => {})
  }
} finally {
  server.kill('SIGTERM')
  await pool.end()
}
