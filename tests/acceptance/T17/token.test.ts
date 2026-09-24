// AC-T17-02: token assinado (HMAC-SHA256 com AUTH_SECRET), expira em AUTH_SESSION_TTL_MS (12 h);
// sem AUTH_SECRET gera segredo por processo com warn; /api/* aceita token de login ou API_TOKEN;
// expirado/adulterado/revogado → 401; GET /api/auth/me; POST /api/auth/logout revoga.
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { authed, HOUR, loginOk, tamper, useAuthApp, warnLines } from './shared'

const SECRET = 'segredo-de-teste-com-32-bytes-ok!'

describe('T17 — token de login', () => {
  const ctx = useAuthApp()

  it('AC-T17-02 /api/* aceita o token de login e também o API_TOKEN', async () => {
    const { app } = await ctx.makeApp({ secret: SECRET })
    const token = await loginOk(app)
    expect((await authed(app, token, 'GET', '/api/sessions')).status).toBe(200)
    expect((await authed(app, ctx.apiToken, 'GET', '/api/sessions')).status, 'API_TOKEN continua valendo').toBe(200)
    expectApiError(await authed(app, 'token-qualquer', 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
  })

  it('AC-T17-02 GET /api/auth/me devolve o usuário do token', async () => {
    const { app } = await ctx.makeApp({ secret: SECRET })
    const token = await loginOk(app)
    const me = await authed(app, token, 'GET', '/api/auth/me')
    expect(me.status, me.text).toBe(200)
    expect(me.body.user).toEqual({ username: 'admin', role: 'admin' })
    expectApiError(await authed(app, tamper(token), 'GET', '/api/auth/me'), 'UNAUTHORIZED', 401)
  })

  it('AC-T17-02 token adulterado → 401', async () => {
    const { app } = await ctx.makeApp({ secret: SECRET })
    const token = await loginOk(app)
    expectApiError(await authed(app, tamper(token), 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
    expectApiError(await authed(app, `${token}x`, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
    expectApiError(await authed(app, token.slice(0, -2), 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
  })

  it('AC-T17-02 assinatura depende do segredo: mesmo AUTH_SECRET aceita, segredo diferente recusa', async () => {
    const a = await ctx.makeApp({ secret: SECRET })
    const token = await loginOk(a.app)
    const sameSecret = await ctx.makeApp({ secret: SECRET })
    expect((await authed(sameSecret.app, token, 'GET', '/api/sessions')).status, 'outro processo com o mesmo segredo').toBe(200)
    const other = await ctx.makeApp({ secret: `${SECRET}-diferente` })
    expectApiError(await authed(other.app, token, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)

    process.env.AUTH_SECRET = SECRET
    try {
      const envApp = await ctx.makeApp()
      expect((await authed(envApp.app, token, 'GET', '/api/sessions')).status, 'AUTH_SECRET do env').toBe(200)
    } finally {
      delete process.env.AUTH_SECRET
    }
  })

  it('AC-T17-02 sem AUTH_SECRET: segredo aleatório por processo (warn) e o token não vale após restart', async () => {
    const first = await ctx.makeApp()
    expect(warnLines(first.logs, 'AUTH_SECRET').length, `warn esperado:\n${first.logs.join('\n')}`).toBeGreaterThan(0)
    const token = await loginOk(first.app)
    expect((await authed(first.app, token, 'GET', '/api/sessions')).status).toBe(200)
    const restarted = await ctx.makeApp()
    expectApiError(await authed(restarted.app, token, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)

    const withSecret = await ctx.makeApp({ secret: SECRET })
    expect(warnLines(withSecret.logs, 'AUTH_SECRET')).toEqual([])
  })

  it('AC-T17-02 expira em 12 h por padrão (expiresAt coerente); depois disso → 401', async () => {
    const { app } = await ctx.makeApp({ secret: SECRET, now: ctx.now })
    const t0 = ctx.now().getTime()
    const res = await (await import('./shared')).login(app, 'admin', 'nimda')
    expect(res.status).toBe(200)
    const ttl = Date.parse(res.body.expiresAt) - t0
    expect(ttl).toBeGreaterThan(12 * HOUR - 60_000)
    expect(ttl).toBeLessThan(12 * HOUR + 60_000)
    const token = res.body.token
    ctx.advance(11 * HOUR)
    expect((await authed(app, token, 'GET', '/api/sessions')).status, 'ainda válido em 11 h').toBe(200)
    ctx.advance(HOUR + 60_000)
    expectApiError(await authed(app, token, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
  })

  it('AC-T17-02 TTL configurável (sessionTtlMs e AUTH_SESSION_TTL_MS)', async () => {
    const { app } = await ctx.makeApp({ secret: SECRET, now: ctx.now, sessionTtlMs: 60_000 })
    const token = await loginOk(app)
    ctx.advance(30_000)
    expect((await authed(app, token, 'GET', '/api/sessions')).status).toBe(200)
    ctx.advance(31_000)
    expectApiError(await authed(app, token, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)

    process.env.AUTH_SESSION_TTL_MS = '120000'
    try {
      const envApp = await ctx.makeApp({ secret: SECRET, now: ctx.now })
      const t2 = await loginOk(envApp.app)
      ctx.advance(100_000)
      expect((await authed(envApp.app, t2, 'GET', '/api/sessions')).status).toBe(200)
      ctx.advance(30_000)
      expectApiError(await authed(envApp.app, t2, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
    } finally {
      delete process.env.AUTH_SESSION_TTL_MS
    }
  })

  it('AC-T17-02 POST /api/auth/logout revoga só aquele token', async () => {
    const { app } = await ctx.makeApp({ secret: SECRET })
    const a = await loginOk(app)
    const b = await loginOk(app)
    const out = await authed(app, a, 'POST', '/api/auth/logout')
    expect([200, 204], out.text).toContain(out.status)
    expectApiError(await authed(app, a, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
    expectApiError(await authed(app, a, 'GET', '/api/auth/me'), 'UNAUTHORIZED', 401)
    expect((await authed(app, b, 'GET', '/api/sessions')).status, 'outro token segue válido').toBe(200)
    expect((await authed(app, ctx.apiToken, 'GET', '/api/sessions')).status).toBe(200)
  })
})
