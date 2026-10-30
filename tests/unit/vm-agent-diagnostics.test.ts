import { describe, expect, it } from 'vitest'
import { browserFailure, browserHeadless } from '../../vm-agent/src/browser'

describe('VM browser mode and private diagnostics', () => {
  it('supports the display in Docker and rejects a misspelled mode', () => {
    expect(browserHeadless('false')).toBe(false)
    expect(browserHeadless('true')).toBe(true)
    expect(browserHeadless('')).toBe(true)
    expect(() => browserHeadless('flase')).toThrow('VM_AGENT_HEADLESS_INVALID')
  })

  it('reports failed resources without login values or response text', () => {
    const result = browserFailure(
      'https://user:secret@captcha.example/login/account-name?password=secret#token',
      'xhr',
      'net::ERR_CONNECTION_RESET',
    )
    expect(result).toEqual({
      host: 'captcha.example',
      kind: 'xhr',
      code: 'net::ERR_CONNECTION_RESET',
    })
    expect(browserFailure('https://captcha.example/check', 'fetch', 'HTTP_403')).toEqual({
      host: 'captcha.example',
      kind: 'fetch',
      code: 'HTTP_403',
    })
    expect(browserFailure('https://captcha.example/', 'secret=value', 'secret=value')).toEqual({
      host: 'captcha.example',
      kind: 'other',
      code: 'REQUEST_FAILED',
    })
    expect(browserFailure('data:text/plain,secret', 'document', 'HTTP_403')).toBeNull()
  })
})
