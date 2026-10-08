// Real crypto test: starts a throwaway anvil node in Docker (chain 11155111, a local imitation
// of Sepolia), runs tests/integration/crypto-anvil.test.ts against the _test database from .env
// and removes the container. Nothing here touches a public network or real money.
import { execFileSync, spawnSync } from 'node:child_process'

const image = 'ghcr.io/foundry-rs/foundry:v1.3.5'
const port = process.env.ANVIL_TEST_PORT || '18546'
const name = `farm-anvil-test-${process.pid}`
const url = `http://127.0.0.1:${port}`

async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if ((await response.json()).result === '0xaa36a7') return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('anvil did not start')
}

execFileSync('docker', [
  'run',
  '-d',
  '--rm',
  '--name',
  name,
  '-p',
  `127.0.0.1:${port}:8545`,
  '--entrypoint',
  'anvil',
  image,
  '--host',
  '0.0.0.0',
  '--chain-id',
  '11155111',
])
try {
  await ready()
  const result = spawnSync(
    process.execPath,
    [
      '--env-file=.env',
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/integration/crypto-anvil.test.ts',
      '--maxWorkers=1',
    ],
    { stdio: 'inherit', env: { ...process.env, ANVIL_RPC_URL: url } },
  )
  process.exitCode = result.status ?? 1
} finally {
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
