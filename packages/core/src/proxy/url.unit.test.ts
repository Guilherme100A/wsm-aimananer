import { describe, expect, it } from 'vitest'
import { buildProxyUrl, maskProxyUrl, parseProxyUrl, ProxyUrlError } from './url'
import { isUniqueViolation } from './errors'

describe('parseProxyUrl', () => {
  it('extrai partes e decodifica credenciais', () => {
    expect(parseProxyUrl('http://us%40er:p%3Ass@10.0.0.1:8080')).toEqual({
      protocol: 'http',
      host: '10.0.0.1',
      port: 8080,
      username: 'us@er',
      password: 'p:ss',
    })
    expect(parseProxyUrl('socks5://proxy.local')).toMatchObject({ protocol: 'socks5', port: 1080, username: null, password: null })
    expect(parseProxyUrl('https://h')).toMatchObject({ port: 443 })
  })

  it.each(['ftp://h:21', 'not a url', 'http://h:80/path', 'http://h:80?x=1', 'socks4://h:1'])('rejeita %s', (u) => {
    expect(() => parseProxyUrl(u)).toThrow(ProxyUrlError)
  })
})

describe('buildProxyUrl / maskProxyUrl', () => {
  const parts = { protocol: 'http' as const, host: 'h', port: 3128, username: 'u', password: 's3cr:et' }

  it('reconstrói a URL (ida e volta)', () => {
    expect(parseProxyUrl(buildProxyUrl(parts))).toEqual(parts)
  })

  it('mascara a senha', () => {
    expect(buildProxyUrl(parts, { mask: true })).toBe('http://u:***@h:3128')
    expect(maskProxyUrl({ ...parts, hasPassword: true })).toBe('http://u:***@h:3128')
    expect(maskProxyUrl({ ...parts, hasPassword: false })).toBe('http://u@h:3128')
    expect(maskProxyUrl({ ...parts, username: null, hasPassword: false })).toBe('http://h:3128')
  })
})

describe('isUniqueViolation', () => {
  it('detecta 23505 direto ou em cause', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation(Object.assign(new Error('x'), { cause: { code: '23505', constraint: 'c' } }), 'c')).toBe(true)
    expect(isUniqueViolation({ code: '23503' })).toBe(false)
  })
})
