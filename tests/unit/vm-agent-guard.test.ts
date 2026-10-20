import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTargetCache,
  isBlockedHostname,
  isPrivateIp,
  targetAllowed,
} from '../../vm-agent/src/guard'
import { actionSchema } from '../../vm-agent/src/actions'

const resolver = async (hostname: string) => {
  const table: Record<string, string[]> = {
    'example.com': ['93.184.216.34'],
    'rebind.example': ['93.184.216.34', '10.0.0.5'],
    'v6.example': ['2606:4700::1111'],
    'metadata.example': ['169.254.169.254'],
    'mapped.example': ['::ffff:127.0.0.1'],
    'empty.example': [],
  }
  if (!(hostname in table)) throw new Error('ENOTFOUND')
  return table[hostname]!
}
beforeEach(() => clearTargetCache())

describe('VM browser network guard', () => {
  it('classifies private, loopback, link-local, carrier NAT and multicast addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.5',
      '172.31.255.255',
      '192.168.0.10',
      '169.254.169.254',
      '100.64.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
    ])
      expect([ip, isPrivateIp(ip)]).toEqual([ip, true])
    for (const ip of [
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
    ])
      expect([ip, isPrivateIp(ip)]).toEqual([ip, false])
  })
  it('blocks local names and single labels by name', () => {
    for (const host of [
      'localhost',
      'db',
      'api.localhost',
      'printer.local',
      'metadata',
      'x.internal',
    ])
      expect([host, isBlockedHostname(host)]).toEqual([host, true])
    expect(isBlockedHostname('example.com')).toBe(false)
  })
  it('allows only public http(s) targets whose every address is public', async () => {
    expect(await targetAllowed('https://example.com/path?q=1', resolver)).toBe(true)
    expect(await targetAllowed('https://v6.example/', resolver)).toBe(true)
    expect(await targetAllowed('http://8.8.8.8/', resolver)).toBe(true)
    for (const url of [
      'https://rebind.example/',
      'https://metadata.example/',
      'https://mapped.example/',
      'https://empty.example/',
      'https://unknown.example/',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:3210/',
      'http://[::1]:8080/',
      'http://10.0.0.1/',
      'file:///etc/passwd',
      'ftp://example.com/',
      'javascript:alert(1)',
      'https://user:pass@example.com/',
      'not a url',
    ])
      expect([url, await targetAllowed(url, resolver)]).toEqual([url, false])
  })
  it('caches resolved names for a minute', async () => {
    let calls = 0
    const counting = async (hostname: string) => {
      calls += 1
      return resolver(hostname)
    }
    await targetAllowed('https://example.com/', counting, 1000)
    await targetAllowed('https://example.com/other', counting, 2000)
    expect(calls).toBe(1)
    await targetAllowed('https://example.com/other', counting, 70_000)
    expect(calls).toBe(2)
  })
  it('validates actions with the same limits as the server', () => {
    expect(actionSchema.safeParse({ name: 'click', x: 1279, y: 799 }).success).toBe(true)
    expect(actionSchema.safeParse({ name: 'click', x: 1280, y: 0 }).success).toBe(false)
    expect(actionSchema.safeParse({ name: 'navigate', url: 'file:///x' }).success).toBe(false)
    expect(actionSchema.safeParse({ name: 'eval', code: '1' }).success).toBe(false)
    expect(actionSchema.safeParse({ name: 'wait', ms: 5001 }).success).toBe(false)
    // A line break in typed text would press Enter without the approval path of `key`.
    expect(actionSchema.safeParse({ name: 'type', text: 'гранты 2026' }).success).toBe(true)
    for (const text of ['login\n', 'a\rb', 'a\tb', 'x\u001b'])
      expect(actionSchema.safeParse({ name: 'type', text }).success).toBe(false)
    // Stored text is inserted, not typed: a line break stays a line break, other controls are out.
    expect(
      actionSchema.safeParse({ name: 'insert_text', text: 'Здравствуйте!\n\nГотов.' }).success,
    ).toBe(true)
    for (const text of ['a\rb', 'a\tb', 'x\u001b', '', 'x'.repeat(2001)])
      expect(actionSchema.safeParse({ name: 'insert_text', text }).success).toBe(false)
  })
  it('normalises decimal, octal, hex and short IPv4 hosts before the check', async () => {
    for (const url of [
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://127.1/',
      'http://0/',
      'http://[::ffff:7f00:1]/',
      'http://[0:0:0:0:0:ffff:127.0.0.1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[ff02::1]/',
      'http://[::]/',
      'ws://example.com/',
    ])
      expect([url, await targetAllowed(url, resolver)]).toEqual([url, false])
    expect(await targetAllowed('http://[2606:4700::1111]/', resolver)).toBe(true)
  })
})
