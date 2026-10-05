import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function setupRun(failPull = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'farm-local-setup-'))
  directories.push(cwd)
  const bin = join(cwd, 'bin')
  mkdirSync(bin)
  const original = [
    'MODEL_PROVIDER=openai',
    'SEARCH_PROVIDER=yandex',
    'APP_ORIGIN=https://previous.example',
    ' export SECURE_COOKIE = true',
    'AUTONOMY_ENABLED=false',
    'OWNER_PASSWORD="test password that must remain unchanged"',
    'SESSION_SECRET=test-session-secret-that-must-remain-unchanged',
    'OPENAI_API_KEY=test-cloud-key-that-must-remain-local',
    'OPENAI_TOTAL_BUDGET_MICROUSD=1000000',
    'MONTHLY_BUDGET_KOPECKS=12000',
    'PAYMENT_MODE=sepolia',
    'DATABASE_URL=postgres://farm:test@127.0.0.1:55432/farm',
    'OLLAMA_MODEL=qwen3:4b',
    'OLLAMA_URL=http://old-model:11434',
    'SEARXNG_URL=http://old-search:8080',
    '',
  ].join('\n')
  writeFileSync(join(cwd, '.env'), original, { mode: 0o640 })
  const stub = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync('commands.jsonl', JSON.stringify({ command, args }) + '\\n');
if (process.env.FAIL_PULL === 'true' && args.includes('pull')) process.exit(1);
`
  for (const command of ['node', 'docker']) writeFileSync(join(bin, command), stub, { mode: 0o700 })
  const result = spawnSync(process.execPath, [resolve('scripts/local-setup.mjs')], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
      FAIL_PULL: String(failPull),
    },
  })
  const commands = readFileSync(join(cwd, 'commands.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { command: string; args: string[] })
  return { cwd, original, result, commands }
}

it('switches a previous cloud setup to local providers while retaining secrets, budgets and payment mode', () => {
  const { cwd, original, result, commands } = setupRun()
  expect(result.status).toBe(0)
  const before = parseEnv(original)
  const after = parseEnv(readFileSync(join(cwd, '.env'), 'utf8'))
  for (const key of [
    'OWNER_PASSWORD',
    'SESSION_SECRET',
    'OPENAI_API_KEY',
    'OPENAI_TOTAL_BUDGET_MICROUSD',
    'MONTHLY_BUDGET_KOPECKS',
    'PAYMENT_MODE',
    'DATABASE_URL',
    'OLLAMA_MODEL',
  ])
    expect(after[key]).toBe(before[key])
  expect(after).toMatchObject({
    MODEL_PROVIDER: 'ollama',
    SEARCH_PROVIDER: 'searxng',
    APP_ORIGIN: 'http://localhost:3210',
    SECURE_COOKIE: 'false',
    AUTONOMY_ENABLED: 'true',
    OLLAMA_URL: 'http://127.0.0.1:11434',
    SEARXNG_URL: 'http://127.0.0.1:8088',
  })
  expect(statSync(join(cwd, '.env')).mode & 0o777).toBe(0o600)
  const stop = commands.findIndex((command) => command.args.includes('stop'))
  const pull = commands.findIndex((command) => command.args.includes('pull'))
  expect(stop).toBeGreaterThan(-1)
  expect(stop).toBeLessThan(pull)
  expect(commands[stop]!.args).toContain('--timeout')
  expect(commands.at(-1)!.args).toEqual(
    expect.arrayContaining(['--wait', 'web', 'worker', 'backup', 'observer']),
  )
  expect(result.stdout).toContain('http://localhost:3210')
  expect(result.stdout).not.toContain(before.OPENAI_API_KEY)
  expect(result.stdout).not.toContain(before.OWNER_PASSWORD)
})

it('leaves the previous environment intact and does not restart cloud workers when the model download fails', () => {
  const { cwd, original, result, commands } = setupRun(true)
  expect(result.status).not.toBe(0)
  expect(readFileSync(join(cwd, '.env'), 'utf8')).toBe(original)
  expect(commands.some((command) => command.args.includes('stop'))).toBe(true)
  expect(commands.at(-1)!.args).toContain('pull')
  expect(commands.some((command) => command.args.includes('--build'))).toBe(false)
})
