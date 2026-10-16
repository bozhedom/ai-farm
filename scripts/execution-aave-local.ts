import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { EXECUTION_POLICY as P } from '../core/policy'
import {
  createAaveAdapter,
  createAaveRpc,
  type AaveSettings,
} from '../core/execution/adapters/aave'

type LocalConfig = Pick<
  AaveSettings,
  'rpcUrl' | 'network' | 'chainId' | 'sender' | 'pool' | 'token' | 'aToken' | 'confirmations'
>
type LocalSetup = { config: LocalConfig; privateKey: Hex }
const fixtureAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function aToken() view returns (address)',
])

/** Deploys only to a verified local Anvil; neither reads nor modifies the application's .env. */
export async function setupLocalAave(
  rpcUrl = 'http://127.0.0.1:18550',
  destination = resolve('.secrets/execution-aave-demo.json'),
) {
  const rpc = createAaveRpc({ rpcUrl, network: 'local' })
  if (
    (await rpc('eth_chainId', [])) !== '0xaa36a7' ||
    !/^anvil\b/i.test(String(await rpc('web3_clientVersion', [])))
  )
    throw new Error('EXECUTION_AAVE_LOCAL_NODE_REQUIRED')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const lockPath = `${destination}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  const temporary = `${destination}.${process.pid}.tmp`
  function adapterFor(setup: LocalSetup) {
    return createAaveAdapter({
      ...setup.config,
      privateKey: setup.privateKey,
      decimals: 6,
      maxAmountAtoms: 1_000_000_000n,
      maxGas: BigInt(P.defiMaxGas),
      maxFeePerGasWei: BigInt(P.defiMaxFeePerGasWei),
      maxGasCostWei: BigInt(P.defiMaxGasCostWei),
    })
  }
  function summary(setup: LocalSetup, reused: boolean) {
    return {
      file: destination,
      rpcUrl,
      network: 'local-anvil-fixture',
      sender: setup.config.sender,
      pool: setup.config.pool.address,
      token: setup.config.token.address,
      aToken: setup.config.aToken.address,
      reused,
    }
  }
  try {
    let previous: string | null = null
    try {
      previous = await readFile(destination, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (previous !== null) {
      const existing = JSON.parse(previous) as LocalSetup
      if (
        existing.config.network !== 'local' ||
        existing.config.chainId !== 11155111 ||
        existing.config.rpcUrl !== rpcUrl
      )
        throw new Error('EXECUTION_AAVE_LOCAL_CONFIG_EXISTS')
      await adapterFor(existing).verifyDeployment()
      await chmod(destination, 0o600)
      return summary(existing, true)
    }
    // Public Anvil test mnemonic, account 7. Used only after the loopback/node checks above.
    const account = mnemonicToAccount(
      'test test test test test test test test test test test junk',
      { addressIndex: 7 },
    )
    const accounts = (await rpc('eth_accounts', [])) as string[]
    if (!accounts.some((address) => address.toLowerCase() === account.address.toLowerCase()))
      throw new Error('EXECUTION_AAVE_LOCAL_ACCOUNT_REQUIRED')
    const artifact = JSON.parse(
      await readFile(new URL('../tests/fixtures/aave/bytecode.json', import.meta.url), 'utf8'),
    )
    const source = await readFile(
      new URL('../tests/fixtures/aave/ExecutionFixture.sol', import.meta.url),
    )
    if (createHash('sha256').update(source).digest('hex') !== artifact.sourceSha256)
      throw new Error('EXECUTION_AAVE_FIXTURE_CHANGED')
    async function send(to: Address | undefined, data: Hex) {
      const txHash = await rpc('eth_sendTransaction', [
        { from: account.address, ...(to ? { to } : {}), data, gas: '0x4c4b40' },
      ])
      for (let i = 0; i < 100; i++) {
        const receipt = (await rpc('eth_getTransactionReceipt', [txHash])) as {
          status: string
          contractAddress?: Address
        } | null
        if (receipt) {
          if (receipt.status !== '0x1') throw new Error('EXECUTION_AAVE_FIXTURE_DEPLOY_FAILED')
          return receipt
        }
        await new Promise((done) => setTimeout(done, 50))
      }
      throw new Error('EXECUTION_AAVE_FIXTURE_PENDING')
    }
    const token = (await send(undefined, artifact.contracts.FixtureToken.bytecode)).contractAddress!
    const pool = (
      await send(
        undefined,
        encodeDeployData({
          abi: artifact.contracts.FixturePool.abi,
          bytecode: artifact.contracts.FixturePool.bytecode,
          args: [token],
        }),
      )
    ).contractAddress!
    const encoded = (await rpc('eth_call', [
      { to: pool, data: encodeFunctionData({ abi: fixtureAbi, functionName: 'aToken' }) },
      'latest',
    ])) as string
    const aToken = `0x${encoded.slice(-40)}` as Address
    const pin = async (address: Address) => ({
      address,
      codeHash: keccak256((await rpc('eth_getCode', [address, 'latest'])) as Hex),
    })
    await send(
      token,
      encodeFunctionData({
        abi: fixtureAbi,
        functionName: 'mint',
        args: [account.address, 1_000_000_000n],
      }),
    )
    const setup: LocalSetup = {
      config: {
        rpcUrl,
        network: 'local',
        chainId: 11155111,
        sender: account.address,
        pool: await pin(pool),
        token: await pin(token),
        aToken: await pin(aToken),
        confirmations: P.minConfirmations,
      },
      privateKey: toHex(account.getHdKey().privateKey!),
    }
    await adapterFor(setup).verifyDeployment()
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(setup, null, 2)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, destination)
    return summary(setup, false)
  } finally {
    await lock.close()
    await unlink(lockPath)
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await setupLocalAave(process.argv[2]), null, 2))
  } catch (error) {
    const message =
      error instanceof Error && /^EXECUTION_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'EXECUTION_AAVE_LOCAL_SETUP_FAILED'
    console.error(message)
    process.exitCode = 1
  }
}
