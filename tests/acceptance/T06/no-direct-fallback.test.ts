import { bindProxy, createProxy, createSession, loadProxyCore, proxyUrl, sessionRow, useApp } from './shared'
import { describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { fakeAuthState } from '../helpers/transport'

describe('T06 — sessão com proxy nunca conecta direto', () => {
  const ctx = useApp()

  async function sessionWithProxy(status = 'STABLE') {
    const p = proxyUrl()
    const proxy = await createProxy(ctx, p.url)
    const s = createSession(ctx, { status })
    const res = await bindProxy(ctx, proxy.id, s)
    expect(res.status, res.text).toBe(200)
    return { p, proxy, s }
  }

  const markUnavailable = async (proxyId: string) => {
    const { createProxyChecker } = await loadProxyCore()
    const checker = createProxyChecker({
      db: ctx.db,
      intervalMs: 60_000,
      probe: async (proxy: { id: string }) => {
        if (proxy.id === proxyId) throw new Error('ECONNREFUSED')
      },
    })
    checker.on('proxy_unavailable', () => {})
    await checker.checkAll()
    checker.stop?.()
  }

  it('AC-T06-05 proxy disponível: a conexão usa o proxy (URL com senha em claro só para o transporte)', async () => {
    const { connectSession, resolveSessionProxy, FakeTransport } = await loadProxyCore()
    const { p, s } = await sessionWithProxy()

    const resolved = await resolveSessionProxy(ctx.db, s)
    const u = new URL(resolved.proxyUrl!)
    expect([u.hostname, u.port, decodeURIComponent(u.username), decodeURIComponent(u.password)]).toEqual([p.host, String(p.port), p.user, p.pass])

    const transport = new FakeTransport()
    await connectSession({ db: ctx.db, sessionId: s, transport, auth: fakeAuthState() })
    expect(transport.connectCalls).toHaveLength(1)
    expect(transport.lastConnect.sessionId).toBe(s)
    expect(new URL(transport.lastConnect.proxyUrl).hostname).toBe(p.host)
  })

  it('AC-T06-05 proxy indisponível: conexão falha, transport.connect não é chamado e a sessão fica DISCONNECTED', async () => {
    const { connectSession, FakeTransport } = await loadProxyCore()
    const { proxy, s } = await sessionWithProxy('STABLE')
    await markUnavailable(proxy.id)

    const transport = new FakeTransport()
    const err = await connectSession({ db: ctx.db, sessionId: s, transport, auth: fakeAuthState() }).then(
      () => undefined,
      (e: any) => e,
    )
    expect(err, 'connectSession deveria rejeitar com proxy indisponível').toBeDefined()
    expect(err.code).toBe('PROXY_UNAVAILABLE')
    expect(transport.connectCalls, 'conectou sem proxy (fallback direto)').toHaveLength(0)
    expect(sessionRow(ctx, s).status).toBe('DISCONNECTED')
  })

  it('AC-T06-05 resolveSessionProxy nunca devolve conexão direta para sessão com proxy indisponível', async () => {
    const { resolveSessionProxy } = await loadProxyCore()
    const { proxy, s } = await sessionWithProxy()
    await markUnavailable(proxy.id)
    await expect(resolveSessionProxy(ctx.db, s)).rejects.toMatchObject({ code: 'PROXY_UNAVAILABLE' })
  })

  it('AC-T06-05 falha ao decifrar a senha do proxy também impede a conexão (sem fallback) e deixa a sessão DISCONNECTED', async () => {
    const { connectSession, FakeTransport } = await loadProxyCore()
    const { proxy, s } = await sessionWithProxy('WARMING')
    // adultera o ciphertext: a decifragem AES-GCM precisa falhar
    sqlOk(ctx.tempDb.url, `UPDATE proxies SET password_ciphertext = decode(md5(random()::text), 'hex') WHERE id = ${lit(proxy.id)};`)

    const transport = new FakeTransport()
    await expect(connectSession({ db: ctx.db, sessionId: s, transport, auth: fakeAuthState() })).rejects.toBeDefined()
    expect(transport.connectCalls).toHaveLength(0)
    expect(sessionRow(ctx, s).status).toBe('DISCONNECTED')
  })

  it('AC-T06-05 sessão sem proxy configurado conecta sem proxyUrl (a regra só se aplica a quem tem proxy)', async () => {
    const { connectSession, resolveSessionProxy, FakeTransport } = await loadProxyCore()
    const s = createSession(ctx)
    expect((await resolveSessionProxy(ctx.db, s)).proxyUrl).toBeUndefined()
    const transport = new FakeTransport()
    await connectSession({ db: ctx.db, sessionId: s, transport, auth: fakeAuthState() })
    expect(transport.connectCalls).toHaveLength(1)
    expect(transport.lastConnect.proxyUrl).toBeUndefined()
  })
})
