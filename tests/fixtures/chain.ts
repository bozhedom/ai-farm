import type { Rpc } from '../../core/payments'

type Tx = { hash: string; to: string | null; value: bigint; input?: string; status?: '0x1' | '0x0' }
type Block = { number: bigint; hash: string; timestamp: number; txs: Tx[] }

const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16)
const pad = (n: bigint | number, char: string) => '0x' + BigInt(n).toString(16).padStart(64, char)

/**
 * A small in-memory Sepolia for scanner and reconciliation tests: blocks with full transactions,
 * receipts and canonical headers, answered through the same JSON-RPC methods the server uses.
 */
export function mockChain(start = 100n) {
  const blocks: Block[] = []
  let next = start
  let counter = 0
  const calls: string[] = []
  const chain = {
    calls,
    chainId: '0xaa36a7',
    /** Overrides for single methods, e.g. a node outage or a malformed answer. */
    fail: {} as Record<string, () => unknown>,
    txHash() {
      counter++
      return pad(counter, '0').replace(/^0x0/, '0xd')
    },
    mine(txs: Tx[] = [], timestamp = Math.floor(Date.now() / 1000)) {
      const block = { number: next, hash: pad(next, 'e'), timestamp, txs }
      blocks.push(block)
      next++
      return block
    },
    get latest() {
      return next - 1n
    },
    transfer(to: string, value: bigint, extra: Partial<Tx> = {}) {
      const tx: Tx = { hash: chain.txHash(), to, value, input: '0x', status: '0x1', ...extra }
      chain.mine([tx])
      return tx.hash
    },
    rpc: (async (method: string, params: any[]) => {
      calls.push(method)
      if (chain.fail[method]) return chain.fail[method]!()
      const find = (hash: string) => {
        for (const block of blocks) {
          const tx = block.txs.find((t) => t.hash === hash.toLowerCase())
          if (tx) return { block, tx }
        }
        return null
      }
      const txJson = (block: Block, tx: Tx) => ({
        hash: tx.hash,
        to: tx.to,
        value: hex(tx.value),
        input: tx.input ?? '0x',
        blockHash: block.hash,
        blockNumber: hex(block.number),
        chainId: chain.chainId,
      })
      switch (method) {
        case 'eth_chainId':
          return chain.chainId
        case 'eth_blockNumber':
          return hex(chain.latest)
        case 'eth_getBlockByNumber': {
          const n = BigInt(params[0])
          // History before the first mined block exists on a real chain: empty, long ago.
          const block =
            blocks.find((b) => b.number === n) ||
            (n >= 0n && n < start
              ? { number: n, hash: pad(n, 'e'), timestamp: 1700000000, txs: [] }
              : null)
          if (!block) return null
          return {
            hash: block.hash,
            number: hex(block.number),
            timestamp: hex(block.timestamp),
            transactions: params[1]
              ? block.txs.map((tx) => txJson(block, tx))
              : block.txs.map((t) => t.hash),
          }
        }
        case 'eth_getTransactionByHash': {
          const found = find(params[0])
          return found ? txJson(found.block, found.tx) : null
        }
        case 'eth_getTransactionReceipt': {
          const found = find(params[0])
          return found
            ? {
                transactionHash: found.tx.hash,
                to: found.tx.to,
                status: found.tx.status ?? '0x1',
                blockHash: found.block.hash,
                blockNumber: hex(found.block.number),
              }
            : null
        }
        default:
          throw new Error('RPC_UNAVAILABLE')
      }
    }) as Rpc,
  }
  return chain
}
