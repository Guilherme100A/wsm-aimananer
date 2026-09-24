// AC-T17-01: POST /api/auth/login {username, password} público; credenciais de ADMIN_USERNAME/ADMIN_PASSWORD
// (default admin/nimda); 401 com mesma mensagem; 429 após 5 falhas em 15 min por IP; auditado sem senha;
// warn no boot quando usa a senha padrão.
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'
import { auditRows, freshIp, HOUR, login, loginHttp, loginOk, serveHttp, useAuthApp, warnLines, withEnv } from './shared'

describe('T17 — login de administrador', () => {
  const ctx = useAuthApp()

  it('AC-T17-01 default admin/nimda: 200 { token, expiresAt, user: { username, role: admin } } sem Bearer', async () => {
    const { app } = await ctx.makeApp({ secret: 's'.repeat(32) })
    const res = await login(app, 'admin', 'nimda')
    expect(res.status, res.text).toBe(200)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.token.length).toBeGreaterThan(20)
    expect(Number.isNaN(Date.parse(res.body.expiresAt)), `expiresAt ISO: ${res.body.expiresAt}`).toBe(false)
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now())
    expect(res.body.user).toEqual({ username: 'admin', role: 'admin' })
    expect(res.text).not.toContain('nimda')
  })

  it('AC-T17-01 credenciais configuráveis por ADMIN_USERNAME e ADMIN_PASSWORD (env)', async () => {
    process.env.ADMIN_USERNAME = 'operador'
    process.env.ADMIN_PASSWORD = 'senha-forte-123'
    try {
      const { app } = await ctx.makeApp({ secret: 'x'.repeat(32) })
      expect((await login(app, 'operador', 'senha-forte-123')).status).toBe(200)
      expectApiError(await login(app, 'admin', 'nimda'), 'UNAUTHORIZED', 401)
      const me = (await login(app, 'operador', 'senha-forte-123')).body
      expect(me.user).toEqual({ username: 'operador', role: 'admin' })
    } finally {
      delete process.env.ADMIN_USERNAME
      delete process.env.ADMIN_PASSWORD
    }
  })

  it('AC-T17-01 usuário errado e senha errada → 401 UNAUTHORIZED com a mesma mensagem', async () => {
    const { app } = await ctx.makeApp({ secret: 's'.repeat(32) })
    const wrongUser = await login(app, 'root', 'nimda')
    const wrongPass = await login(app, 'admin', 'errada')
    const both = await login(app, 'ninguem', 'nada')
    for (const r of [wrongUser, wrongPass, both]) expectApiError(r, 'UNAUTHORIZED', 401)
    expect(wrongUser.body.error.message).toBe(wrongPass.body.error.message)
    expect(both.body.error.message).toBe(wrongPass.body.error.message)
    expect(wrongPass.text).not.toContain('nimda')
  })

  it('AC-T17-01 body inválido → 400 VALIDATION_ERROR; login não exige Bearer mas o resto de /api/* exige', async () => {
    const { app } = await ctx.makeApp({ secret: 's'.repeat(32) })
    expectApiError(await call(app, 'POST', '/api/auth/login', { body: { username: 'admin' } }), 'VALIDATION_ERROR', 400)
    expectApiError(await call(app, 'GET', '/api/sessions'), 'UNAUTHORIZED', 401)
  })

  it('AC-T17-01 5 falhas em 15 min pelo mesmo IP → 429 RATE_LIMIT (mesmo com a senha certa); outro IP não é afetado', async () => {
    const now = { t: Date.now() }
    const { app } = await ctx.makeApp({ secret: 's'.repeat(32), now: () => new Date(now.t) })
    const ip = freshIp()
    for (let i = 0; i < 5; i++) expectApiError(await login(app, 'admin', `errada-${i}`, ip), 'UNAUTHORIZED', 401)
    expectApiError(await login(app, 'admin', 'errada-6', ip), 'RATE_LIMIT', 429)
    expectApiError(await login(app, 'admin', 'nimda', ip), 'RATE_LIMIT', 429)
    expect((await login(app, 'admin', 'nimda', freshIp())).status, 'outro IP não deve ser bloqueado').toBe(200)

    now.t += 15 * 60_000 + 1_000
    expect((await login(app, 'admin', 'nimda', ip)).status, 'depois da janela de 15 min o IP volta a poder logar').toBe(200)
  })

  it('AC-T17-01 sem TRUST_PROXY (padrão), variar x-forwarded-for NÃO escapa do 429: vale o IP da conexão', async () => {
    for (const trust of [undefined, 'false']) {
      await withEnv({ TRUST_PROXY: trust }, async () => {
        ctx.advance(16 * 60_000) // janela nova: falhas de 127.0.0.1 de outras iterações/testes não contam
        const { app } = await ctx.makeApp({ secret: 's'.repeat(32), now: ctx.now })
        const srv = await serveHttp(app)
        try {
          for (let i = 0; i < 5; i++) {
            const r = await loginHttp(srv.url, 'admin', `errada-${i}`, freshIp())
            expect(r.status, `TRUST_PROXY=${trust ?? '(ausente)'} tentativa ${i + 1}: ${r.text}`).toBe(401)
          }
          const sixth = await loginHttp(srv.url, 'admin', 'errada-6', freshIp())
          expect(sixth.status, `TRUST_PROXY=${trust ?? '(ausente)'}: trocar x-forwarded-for escapou do rate limit: ${sixth.text}`).toBe(429)
          expect(sixth.body?.error?.code).toBe('RATE_LIMIT')
          const noHeader = await loginHttp(srv.url, 'admin', 'nimda')
          expect(noHeader.status, 'mesmo cliente sem o header continua bloqueado').toBe(429)
        } finally {
          await srv.close()
        }
      })
    }
  })

  it('AC-T17-01 com TRUST_PROXY=true, o IP é o valor MAIS À DIREITA de x-forwarded-for (escrito pelo proxy confiável)', async () => {
    await withEnv({ TRUST_PROXY: 'true' }, async () => {
      ctx.advance(16 * 60_000)
      const { app } = await ctx.makeApp({ secret: 's'.repeat(32), now: ctx.now })
      const srv = await serveHttp(app)
      try {
        const real = freshIp()
        const other = freshIp()
        // o cliente injeta lixo variável à esquerda; o proxy anexa o IP real à direita
        for (let i = 0; i < 5; i++) {
          const r = await loginHttp(srv.url, 'admin', `x-${i}`, `203.0.113.${i + 1}, ${real}`)
          expect(r.status, `tentativa ${i + 1}: ${r.text}`).toBe(401)
        }
        const sixth = await loginHttp(srv.url, 'admin', 'nimda', `203.0.113.99, ${real}`)
        expect(sixth.status, `lixo à esquerda escapou do rate limit: ${sixth.text}`).toBe(429)
        expect(sixth.body?.error?.code).toBe('RATE_LIMIT')
        expect((await loginHttp(srv.url, 'admin', 'nimda', real)).status, 'mesmo IP real sozinho continua bloqueado').toBe(429)
        expect((await loginHttp(srv.url, 'admin', 'nimda', other)).status, 'outro IP de cliente não é afetado').toBe(200)
        expect((await loginHttp(srv.url, 'admin', 'nimda', `${real}, ${other}`)).status, 'o IP bloqueado à esquerda não conta; vale o da direita').toBe(200)
      } finally {
        await srv.close()
      }
    })
  })

  it('AC-T17-01 4 falhas não bloqueiam; a janela é de 15 min', async () => {
    const now = { t: Date.now() }
    const { app } = await ctx.makeApp({ secret: 's'.repeat(32), now: () => new Date(now.t) })
    const ip = freshIp()
    for (let i = 0; i < 4; i++) await login(app, 'admin', 'x', ip)
    now.t += 16 * 60_000 // falhas antigas saem da janela
    for (let i = 0; i < 4; i++) await login(app, 'admin', 'x', ip)
    expect((await login(app, 'admin', 'nimda', ip)).status).toBe(200)
    expect(HOUR).toBeGreaterThan(0)
  })

  it('AC-T17-01 login auditado (sucesso e falha) sem registrar a senha', async () => {
    const { app } = await ctx.makeApp({ secret: 's'.repeat(32) })
    const before = auditRows(ctx, 'auth.login').length
    await loginOk(app)
    await login(app, 'admin', 'senha-errada-auditoria')
    const rows = auditRows(ctx, 'auth.login').slice(before)
    expect(rows.length, 'duas tentativas auditadas').toBe(2)
    const text = JSON.stringify(rows)
    expect(text).toContain('admin')
    expect(text, 'senha no audit_log').not.toContain('nimda')
    expect(text, 'senha errada no audit_log').not.toContain('senha-errada-auditoria')
    const successes = rows.map((r) => r.detail?.success)
    expect(successes).toEqual([true, false])
  })

  it('AC-T17-01 sem ADMIN_PASSWORD o boot loga warn de senha padrão; com senha configurada, não', async () => {
    const def = await ctx.makeApp({ secret: 's'.repeat(32) })
    expect(warnLines(def.logs, 'ADMIN_PASSWORD').length, `warn esperado:\n${def.logs.join('\n')}`).toBeGreaterThan(0)
    expect(def.logs.join('\n'), 'a senha padrão não deve aparecer no log').not.toContain('nimda')

    const configured = await ctx.makeApp({ secret: 's'.repeat(32), password: 'outra-senha' })
    expect(warnLines(configured.logs, 'ADMIN_PASSWORD')).toEqual([])

    process.env.ADMIN_PASSWORD = 'pelo-env'
    try {
      const env = await ctx.makeApp({ secret: 's'.repeat(32) })
      expect(warnLines(env.logs, 'ADMIN_PASSWORD')).toEqual([])
    } finally {
      delete process.env.ADMIN_PASSWORD
    }
  })
})
