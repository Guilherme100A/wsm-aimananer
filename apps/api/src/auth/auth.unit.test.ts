import { describe, expect, it, vi } from 'vitest'
import { AuthService, DEFAULT_SESSION_TTL_MS, resolveAuthConfig } from './service'
import { isLoginToken, signToken, verifySignature } from './token'

const T0 = new Date('2026-01-01T00:00:00Z')

function service(over: ConstructorParameters<typeof AuthService>[0] = {}, env: Record<string, string | undefined> = {}) {
  let now = T0
  const s = new AuthService({ secret: 'test-secret-123456', now: () => now, ...over }, env)
  return { s, advance: (ms: number) => (now = new Date(now.getTime() + ms)) }
}

describe('token (HMAC-SHA256)', () => {
  it('assina e verifica; qualquer caractere adulterado invalida', () => {
    const token = signToken('k', { sub: 'admin', role: 'admin', iat: 1, exp: 2 })
    expect(isLoginToken(token)).toBe(true)
    expect(verifySignature('k', token)).toMatchObject({ sub: 'admin', role: 'admin', exp: 2 })
    expect(verifySignature('other', token)).toBeUndefined()
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '.') continue
      const alt = token[i] === 'A' ? 'B' : 'A'
      const tampered = token.slice(0, i) + alt + token.slice(i + 1)
      expect(verifySignature('k', tampered), `char ${i}`).toBeUndefined()
    }
    expect(verifySignature('k', 'wsm1.x')).toBeUndefined()
    expect(verifySignature('k', 'plain-api-token')).toBeUndefined()
    expect(isLoginToken('plain-api-token')).toBe(false)
  })
})

describe('AuthService', () => {
  it('login certo devolve token com expiração; verify aceita até expirar', () => {
    const { s, advance } = service({ sessionTtlMs: 1000 })
    const r = s.login('admin', 'nimda', '1.1.1.1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.user).toEqual({ username: 'admin', role: 'admin' })
    expect(r.result.expiresAt).toBe(new Date(T0.getTime() + 1000).toISOString())
    expect(s.verify(r.result.token)).toMatchObject({ sub: 'admin' })
    advance(999)
    expect(s.verify(r.result.token)).toBeDefined()
    advance(1)
    expect(s.verify(r.result.token)).toBeUndefined()
  })

  it('usuário ou senha errados → mesma falha', () => {
    const { s } = service()
    expect(s.login('admin', 'x', 'ip')).toEqual({ ok: false, reason: 'invalid_credentials' })
    expect(s.login('root', 'nimda', 'ip')).toEqual({ ok: false, reason: 'invalid_credentials' })
    expect(s.login('ADMIN', 'nimda', 'ip')).toEqual({ ok: false, reason: 'invalid_credentials' })
  })

  it('5 falhas em 15 min pelo mesmo IP → 6ª tentativa bloqueada (mesmo certa); outro IP livre; janela expira', () => {
    const { s, advance } = service()
    for (let i = 0; i < 5; i++) expect(s.login('admin', 'bad', '9.9.9.9')).toEqual({ ok: false, reason: 'invalid_credentials' })
    expect(s.login('admin', 'nimda', '9.9.9.9')).toEqual({ ok: false, reason: 'rate_limited' })
    expect(s.login('admin', 'nimda', '8.8.8.8').ok).toBe(true)
    advance(15 * 60 * 1000)
    expect(s.login('admin', 'nimda', '9.9.9.9').ok).toBe(true)
  })

  it('revoke invalida só aquele token', () => {
    const { s } = service()
    const a = s.login('admin', 'nimda', 'ip')
    const b = s.login('admin', 'nimda', 'ip')
    if (!a.ok || !b.ok) throw new Error('login')
    expect(s.revoke(a.result.token)).toBe(true)
    expect(s.verify(a.result.token)).toBeUndefined()
    expect(s.verify(b.result.token)).toBeDefined()
    expect(s.revoke('lixo')).toBe(false)
  })

  it('outro serviço com o mesmo segredo aceita o token; com outro segredo, não', () => {
    const { s } = service()
    const r = s.login('admin', 'nimda', 'ip')
    if (!r.ok) throw new Error('login')
    expect(new AuthService({ secret: 'test-secret-123456', now: () => T0 }).verify(r.result.token)).toBeDefined()
    expect(new AuthService({ secret: 'another-secret-999', now: () => T0 }).verify(r.result.token)).toBeUndefined()
  })
})

describe('configuração', () => {
  it('precedência deps > env > default', () => {
    expect(resolveAuthConfig({}, {})).toMatchObject({
      username: 'admin',
      password: 'nimda',
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
      defaultPassword: true,
      generatedSecret: true,
    })
    const env = { ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'p', AUTH_SECRET: 's', AUTH_SESSION_TTL_MS: '60000' }
    expect(resolveAuthConfig({}, env)).toMatchObject({ username: 'ops', password: 'p', secret: 's', sessionTtlMs: 60000, defaultPassword: false, generatedSecret: false })
    expect(resolveAuthConfig({ username: 'u', password: 'q', secret: 'z', sessionTtlMs: 5 }, env)).toMatchObject({ username: 'u', password: 'q', secret: 'z', sessionTtlMs: 5 })
    expect(resolveAuthConfig({}, { ADMIN_PASSWORD: '', AUTH_SESSION_TTL_MS: 'x' })).toMatchObject({ defaultPassword: true, sessionTtlMs: DEFAULT_SESSION_TTL_MS })
    // TRUST_PROXY: default false; env liga; deps.auth tem precedência
    expect(resolveAuthConfig({}, {}).trustProxy).toBe(false)
    expect(resolveAuthConfig({}, { TRUST_PROXY: 'true' }).trustProxy).toBe(true)
    expect(resolveAuthConfig({}, { TRUST_PROXY: 'false' }).trustProxy).toBe(false)
    expect(resolveAuthConfig({ trustProxy: false }, { TRUST_PROXY: 'true' }).trustProxy).toBe(false)
    // segredo gerado é aleatório por processo
    expect(resolveAuthConfig({}, {}).secret).not.toBe(resolveAuthConfig({}, {}).secret)
  })

  it('warns só quando senha/segredo vêm do default', () => {
    const warn = vi.fn()
    new AuthService({}, {}, { warn })
    expect(warn.mock.calls.map((c) => c[1])).toEqual([expect.stringContaining('ADMIN_PASSWORD'), expect.stringContaining('AUTH_SECRET')])
    warn.mockClear()
    new AuthService({}, { ADMIN_PASSWORD: 'x', AUTH_SECRET: 'y' }, { warn })
    new AuthService({ password: 'x', secret: 'y' }, {}, { warn })
    expect(warn).not.toHaveBeenCalled()
  })
})
