// Each suite gets a fresh local Anvil chain and its own Vitest process. Snapshot/revert,
// account nonces and mining settings must not escape one suite into another.
// Payments use the _test database from .env; Aave uses our local contract fixture.
// Nothing here touches a public network or real money.
import { execFileSync, spawnSync } from 'node:child_process'

const image = 'ghcr.io/foundry-rs/foundry:v1.3.5'
const port = process.env.ANVIL_TEST_PORT || '18546'
const url = `http://127.0.0.1:${port}`
const suites = [
  'tests/integration/crypto-anvil.test.ts',
  'tests/integration/execution-aave-anvil.test.ts',
]

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

for (const [index, suite] of suites.entries()) {
  const name = `farm-anvil-test-${process.pid}-${index}`
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
      ['--env-file=.env', 'node_modules/vitest/vitest.mjs', 'run', suite, '--maxWorkers=1'],
      {
        stdio: 'inherit',
        // Override both names, including .env, so the fixture cannot use a persistent
        // development node selected by an inherited AAVE_ANVIL_RPC_URL.
        env: { ...process.env, ANVIL_RPC_URL: url, AAVE_ANVIL_RPC_URL: url },
      },
    )
    if (result.status !== 0) process.exitCode = result.status ?? 1
  } finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  }
}
