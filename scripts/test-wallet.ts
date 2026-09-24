import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { createTestWallet, testAddress } from './lib/test-wallet'

// Operator utility only. The application and model processes never load this file or its key.
const filename = '.secrets/sepolia-test-wallet.json'
mkdirSync('.secrets', { recursive: true, mode: 0o700 })
chmodSync('.secrets', 0o700)
if (!existsSync(filename))
  writeFileSync(filename, JSON.stringify(createTestWallet(), null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
chmodSync(filename, 0o600)
const wallet = JSON.parse(readFileSync(filename, 'utf8'))
if (wallet.chainId !== 11155111 || testAddress(wallet.privateKey) !== wallet.address)
  throw new Error('INVALID_TEST_WALLET')
let env = readFileSync('.env', 'utf8')
const original = parseEnv(env)
if (!original.SEPOLIA_RECEIVER)
  env = env.replace(/^SEPOLIA_RECEIVER=.*$/m, `SEPOLIA_RECEIVER=${wallet.address}`)
if (!original.SEPOLIA_RPC_URL)
  env = env.replace(
    /^SEPOLIA_RPC_URL=.*$/m,
    'SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com',
  )
writeFileSync('.env', env, { mode: 0o600 })
const settings = parseEnv(env)
console.log(
  `Тестовый адрес: ${wallet.address}. Ключ сохранён локально в ${filename} (0600), не в приложении.`,
)
console.log(
  `Платёжный режим сохранён: ${settings.PAYMENT_MODE}. Тестовые монеты ещё нужно получить из faucet.`,
)
if (process.argv.includes('--check-rpc')) {
  const endpoint = settings.SEPOLIA_RPC_URL!
  if (!endpoint.startsWith('https://')) throw new Error('HTTPS_RPC_REQUIRED')
  async function rpc(method: string, params: unknown[]) {
    const res = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) throw new Error('TEST_RPC_UNAVAILABLE')
    const data = (await res.json()) as { error?: unknown; result: string }
    if (data.error) throw new Error('TEST_RPC_ERROR')
    return data.result
  }
  if (BigInt(await rpc('eth_chainId', [])) !== 11155111n) throw new Error('WRONG_TEST_CHAIN')
  const balance = BigInt(await rpc('eth_getBalance', [wallet.address, 'latest']))
  console.log(`RPC подтвердил Sepolia (11155111). Баланс: ${balance} wei TEST ETH.`)
}
