import { describe, expect, it } from 'vitest'
import { createTestWallet, testAddress } from '../../scripts/lib/test-wallet'

describe('isolated test wallet utility', () => {
  it('derives the known Ethereum address for private scalar one using Keccak', () => {
    expect(testAddress('0x' + '0'.repeat(63) + '1')).toBe(
      '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    )
  })
  it('generates independent test identities', () => {
    const a = createTestWallet(),
      b = createTestWallet()
    expect(a.address).not.toBe(b.address)
    expect(testAddress(a.privateKey)).toBe(a.address)
    expect(a.chainId).toBe(11155111)
  })
})
