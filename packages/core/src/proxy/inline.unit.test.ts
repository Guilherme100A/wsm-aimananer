import { describe, expect, it } from 'vitest'
import { normalizeInlineProxy, type InlineProxyInput } from './inline'
import { ProxyUrlError } from './url'

const ok = { protocol: 'socks5', host: '10.0.0.5', port: 1080 } as InlineProxyInput

describe('normalizeInlineProxy', () => {
  it.each<[InlineProxyInput, object]>([
    [ok, { protocol: 'socks5', host: '10.0.0.5', port: 1080, username: null, password: null }],
    [{ ...ok, host: '  proxy.example.com ' }, { host: 'proxy.example.com' }],
    [{ ...ok, protocol: 'http', username: 'u', password: 'p@ss:w/rd' }, { username: 'u', password: 'p@ss:w/rd' }],
    [{ ...ok, username: '', password: '' }, { username: null, password: null }],
    [{ ...ok, host: '[2001:db8::1]' }, { host: '[2001:db8::1]' }],
  ])('%o válido', (input, expected) => {
    expect(normalizeInlineProxy(input)).toMatchObject(expected)
  })

  it.each<[Partial<InlineProxyInput>, string]>([
    [{ protocol: 'ftp' as never }, 'proxy.protocol'],
    [{ host: '' }, 'proxy.host'],
    [{ host: '   ' }, 'proxy.host'],
    [{ host: 'a b' }, 'proxy.host'],
    [{ host: 'host/path' }, 'proxy.host'],
    [{ host: 'user@host' }, 'proxy.host'],
    [{ port: 0 }, 'proxy.port'],
    [{ port: 65536 }, 'proxy.port'],
    [{ port: 80.5 }, 'proxy.port'],
    [{ port: '8080' as never }, 'proxy.port'],
    [{ password: 'x' }, 'proxy.username'],
  ])('%o inválido → %s', (patch, field) => {
    try {
      normalizeInlineProxy({ ...ok, ...patch } as InlineProxyInput)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyUrlError)
      expect((err as { field?: string }).field).toBe(field)
    }
  })
})
