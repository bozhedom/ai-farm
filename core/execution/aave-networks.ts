/** Official Aave V3 identity hints. Code hashes are never invented; the owner pins them in CONFIG. */
export const AAVE_NETWORKS = Object.freeze({
  local: Object.freeze({
    id: 'local' as const,
    network: 'local' as const,
    chainId: 11155111,
    /** Fixture addresses come from the local Anvil script, never from this table. */
  }),
  sepolia: Object.freeze({
    id: 'sepolia' as const,
    network: 'testnet' as const,
    chainId: 11155111,
    /** Owner must copy current official Sepolia addresses and code hashes into CONFIG. */
  }),
  mainnet: Object.freeze({
    id: 'mainnet' as const,
    network: 'live' as const,
    chainId: 1,
    // Official Aave V3 Ethereum addresses from the Aave address book. Verify before Live.
    pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    aToken: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
  }),
})

export type AaveNetworkId = keyof typeof AAVE_NETWORKS

export function aaveNetworkFor(id: AaveNetworkId) {
  return AAVE_NETWORKS[id]
}

export function assertAaveConfigNetwork(
  mode: 'paper' | 'demo' | 'live',
  selected: AaveNetworkId,
  config: { network: string; chainId: number; pool?: { address?: string }; token?: { address?: string }; aToken?: { address?: string } },
) {
  const expected = AAVE_NETWORKS[selected]
  if (!expected) throw new Error('EXECUTION_DEFI_NETWORK_INVALID')
  if (mode === 'demo' && selected === 'mainnet') throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  if (mode === 'live' && selected !== 'mainnet') throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  if (config.network !== expected.network) throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  if (config.chainId !== expected.chainId) throw new Error('EXECUTION_DEFI_NETWORK_MISMATCH')
  if (selected === 'mainnet') {
    const mainnet = AAVE_NETWORKS.mainnet
    const pool = config.pool?.address?.toLowerCase()
    const token = config.token?.address?.toLowerCase()
    const aToken = config.aToken?.address?.toLowerCase()
    if (pool && pool !== mainnet.pool.toLowerCase()) throw new Error('EXECUTION_DEFI_ADDRESS_MISMATCH')
    if (token && token !== mainnet.token.toLowerCase()) throw new Error('EXECUTION_DEFI_ADDRESS_MISMATCH')
    if (aToken && aToken !== mainnet.aToken.toLowerCase()) throw new Error('EXECUTION_DEFI_ADDRESS_MISMATCH')
  }
}
