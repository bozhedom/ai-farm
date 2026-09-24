import { createECDH } from 'node:crypto'
import { keccak_256 } from '@noble/hashes/sha3.js'

export function testAddress(privateKey: string) {
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error('INVALID_TEST_KEY')
  const key = createECDH('secp256k1')
  key.setPrivateKey(Buffer.from(privateKey.slice(2), 'hex'))
  const publicKey = key.getPublicKey(undefined, 'uncompressed').subarray(1)
  return '0x' + Buffer.from(keccak_256(publicKey)).subarray(-20).toString('hex')
}

export function createTestWallet() {
  const key = createECDH('secp256k1')
  key.generateKeys()
  const privateKey = '0x' + key.getPrivateKey().toString('hex').padStart(64, '0')
  return {
    purpose: 'Sepolia test only; never deposit real assets',
    chainId: 11155111,
    address: testAddress(privateKey),
    privateKey,
    createdAt: new Date().toISOString(),
  }
}
