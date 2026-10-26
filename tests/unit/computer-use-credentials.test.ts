import { describe, expect, it } from 'vitest'
import {
  loginGoal,
  loginHostMatches,
  loginHosts,
  openCredential,
  sealCredential,
} from '../../core/computer-use/credentials'
import { platformGoals } from '../../core/computer-use/platforms'
import { validateGoal } from '../../core/computer-use/policy'
import { fillLoginSchema, parseToolCall, vmActionSchema } from '../../core/computer-use/schema'
import { computerUseTools } from '../../core/computer-use/tools'
import { actionSchema } from '../../vm-agent/src/actions'
import { loginHostAllowed } from '../../vm-agent/src/browser'

describe('stored platform logins', () => {
  it('encrypts each value with a fresh nonce and opens it only for the same platform', () => {
    const a = sealCredential('secret-password', 'fl.ru')
    const b = sealCredential('secret-password', 'fl.ru')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^v1:/)
    expect(a).not.toContain('secret-password')
    expect(openCredential(a, 'fl.ru')).toBe('secret-password')
    // The domain is associated data: a value moved to another platform's row does not open.
    expect(() => openCredential(a, 'kwork.ru')).toThrow('COMPUTER_USE_LOGIN_UNREADABLE')
    const tampered = `v1:${Buffer.from(Buffer.from(a.slice(3), 'base64').map((x, i) => (i === 30 ? x ^ 1 : x))).toString('base64')}`
    expect(() => openCredential(tampered, 'fl.ru')).toThrow('COMPUTER_USE_LOGIN_UNREADABLE')
    expect(() => openCredential('v0:abc', 'fl.ru')).toThrow('COMPUTER_USE_LOGIN_UNREADABLE')
  })

  it('fills only on https pages of the platform or of the owner login page host', () => {
    const hosts = loginHosts('freelance.habr.com', 'https://account.habr.com/login')
    expect(hosts).toEqual(['freelance.habr.com', 'account.habr.com'])
    expect(loginHosts('fl.ru', 'https://www.fl.ru/login/')).toEqual(['fl.ru'])
    for (const check of [loginHostMatches, loginHostAllowed]) {
      expect(check('https://www.fl.ru/login/', ['fl.ru'])).toBe(true)
      expect(check('https://fl.ru/', ['fl.ru'])).toBe(true)
      expect(check('http://www.fl.ru/login/', ['fl.ru'])).toBe(false)
      expect(check('https://fl.ru.evil.example/login', ['fl.ru'])).toBe(false)
      expect(check('https://evilfl.ru/login', ['fl.ru'])).toBe(false)
      expect(check('https://account.habr.com/login', hosts)).toBe(true)
      expect(check('https://habr.com/login', hosts)).toBe(false)
      expect(check('about:blank', ['fl.ru'])).toBe(false)
    }
  })

  it('gives the model log_in with a domain only; fill_login is a server-side VM action', () => {
    expect(parseToolCall('log_in', { platform_domain: 'FL.ru' })).toEqual({
      name: 'log_in',
      platform_domain: 'fl.ru',
    })
    expect(() => parseToolCall('log_in', { platform_domain: 'fl.ru', password: 'x' })).toThrow()
    expect(() =>
      parseToolCall('fill_login', { hosts: ['fl.ru'], username: 'a', password: 'b' }),
    ).toThrow('COMPUTER_USE_TOOL_CALL_INVALID')
    const names = computerUseTools.map((tool) => tool.name)
    expect(names).toContain('log_in')
    expect(names).not.toContain('fill_login')
    const fill = { name: 'fill_login', hosts: ['fl.ru'], username: 'me@mail.ru', password: 'p' }
    expect(vmActionSchema.parse(fill)).toEqual(fill)
    expect(actionSchema.parse(fill)).toEqual(fill)
    for (const bad of [
      { ...fill, password: 'a\nb' },
      { ...fill, hosts: [] },
      { ...fill, hosts: ['localhost'] },
      { ...fill, extra: 1 },
    ]) {
      expect(fillLoginSchema.safeParse(bad).success).toBe(false)
      expect(actionSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('tells platform goals to use log_in where a login is stored, and the goal passes policy', () => {
    const [jobs, inbox] = platformGoals(['fl.ru'], 5, ['fl.ru'])
    expect(jobs).toContain('log_in')
    expect(inbox).toContain('log_in')
    const [plain] = platformGoals(['kwork.ru'], 5, ['fl.ru'])
    expect(plain).toContain('вход уже выполнен')
    expect(plain).not.toContain('log_in')
    expect(validateGoal(loginGoal('fl.ru', 'https://www.fl.ru/login/'))).toContain('log_in')
    expect(loginGoal('kwork.ru', '')).toContain('https://kwork.ru/')
  })
})
