import { createServer, request, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearTargetCache, resolveTarget } from '../../vm-agent/src/guard'
import { parseConnectTarget, startProxy, type Proxy } from '../../vm-agent/src/proxy'

/**
 * The proxy is the enforcement point of the VM network guard: every browser connection goes
 * through it, and it connects only to the public address it resolved itself. The target here is
 * a loopback server that the dial hook substitutes for the public address.
 */
const table: Record<string, string[]> = {
  'public.example': ['93.184.216.34'],
  'dual.example': ['2606:4700::1111', '93.184.216.34'],
  'rebind.example': ['93.184.216.34', '10.0.0.5'],
  'metadata.example': ['169.254.169.254'],
}
const resolver = async (hostname: string) => {
  if (!(hostname in table)) throw new Error('ENOTFOUND')
  return table[hostname]!
}

let target: Server
let targetPort = 0
let proxy: Proxy
const dialed: string[] = []
const seen: { host?: string; url?: string }[] = []

beforeAll(async () => {
  target = createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`hello ${req.url}`)
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  targetPort = (target.address() as { port: number }).port
  proxy = await startProxy({
    resolver,
    dial: (address, port) => {
      dialed.push(`${address}:${port}`)
      return connect({ host: '127.0.0.1', port: targetPort })
    },
  })
})
beforeEach(() => {
  clearTargetCache()
  dialed.length = 0
  seen.length = 0
})
afterAll(async () => {
  await proxy.close()
  await new Promise<void>((resolve) => target.close(() => resolve()))
})

/** An absolute-form request through the proxy, as a browser sends plain http. */
function viaProxy(url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: proxy.port, method: 'GET', path: url },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    req.setHeader('Host', new URL(url).host)
    req.on('error', reject)
    req.end()
  })
}
/** A CONNECT tunnel: the status line, then whatever the tunnel answers to one request. */
function tunnel(hostPort: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: proxy.port })
    let data = ''
    let status = 0
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString()
      if (!status) {
        const line = /^HTTP\/1\.1 (\d{3})/.exec(data)
        if (!line) return
        status = Number(line[1])
        if (status !== 200) return socket.end()
        data = data.slice(data.indexOf('\r\n\r\n') + 4)
        socket.write('GET /inside HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n')
      }
    })
    socket.on('close', () => resolve({ status, body: data }))
    socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`)
  })
}

describe('VM browser proxy pins the checked address', () => {
  it('forwards plain http to the resolved public address with the original host name', async () => {
    const answer = await viaProxy('http://public.example/jobs?page=2')
    expect(answer).toEqual({ status: 200, body: 'hello /jobs?page=2' })
    expect(dialed).toEqual(['93.184.216.34:80'])
    expect(seen).toEqual([{ host: 'public.example', url: '/jobs?page=2' }])
  })
  it('tunnels CONNECT (https, WebSockets) to the resolved address only', async () => {
    const answer = await tunnel('dual.example:443')
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('hello /inside')
    expect(dialed).toEqual(['93.184.216.34:443'])
  })
  it('refuses private, loopback, metadata and rebinding targets without connecting', async () => {
    for (const url of [
      'http://rebind.example/',
      'http://metadata.example/',
      'http://unknown.example/',
      'http://127.0.0.1:8787/sessions',
      'http://localhost/',
      'http://[::1]/',
      'http://[::ffff:7f00:1]/',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/',
      'http://0.0.0.0/',
      'http://user:pass@public.example/',
      'https://public.example/',
    ])
      expect([url, (await viaProxy(url)).status]).toEqual([url, 403])
    for (const hostPort of [
      'rebind.example:443',
      '10.0.0.5:443',
      '[::1]:443',
      '127.0.0.1:8787',
      'localhost:443',
      'metadata:80',
    ])
      expect([hostPort, (await tunnel(hostPort)).status]).toEqual([hostPort, 403])
    expect((await tunnel('public.example')).status).toBe(400)
    expect(dialed).toEqual([])
    expect(seen).toEqual([])
  })
  it('keeps using the address it checked while the cached answer lives', async () => {
    let calls = 0
    const changing = async () => (calls++ === 0 ? ['93.184.216.34'] : ['10.0.0.5'])
    expect(await resolveTarget('rebind.example', changing, 1000)).toBe('93.184.216.34')
    expect(await resolveTarget('rebind.example', changing, 2000)).toBe('93.184.216.34')
    expect(await resolveTarget('rebind.example', changing, 70_000)).toBeNull()
    expect(await resolveTarget('dual.example', resolver)).toBe('93.184.216.34')
    expect(await resolveTarget('8.8.8.8', resolver)).toBe('8.8.8.8')
    expect(await resolveTarget('[2606:4700::1111]', resolver)).toBe('2606:4700::1111')
    expect(await resolveTarget('[::ffff:7f00:1]', resolver)).toBeNull()
  })
  it('parses CONNECT targets strictly', () => {
    expect(parseConnectTarget('example.com:443')).toEqual({ hostname: 'example.com', port: 443 })
    expect(parseConnectTarget('[2606:4700::1111]:443')).toEqual({
      hostname: '[2606:4700::1111]',
      port: 443,
    })
    for (const bad of [undefined, '', 'example.com', 'example.com:0', 'example.com:70000', 'a b:1'])
      expect(parseConnectTarget(bad)).toBeNull()
  })
})
