import { api, connectedSession, createSession, credentialCount, healthTypes, sessionRow, useSessions, waitStatus } from './shared'
import { describe, expect, it } from 'vitest'
import { usePostgresAuthState } from '@wsm/core'
import { lit, sqlOk } from '../helpers/pg'

describe('T05 — conexão aberta', () => {
  const ctx = useSessions()

  it('AC-T05-03 ao abrir a conexão: estado WARMING e health_event connected gravado', async () => {
    const { id } = await connectedSession(ctx)
    expect(sessionRow(ctx, id)!.status).toBe('WARMING')
    await expect.poll(() => healthTypes(ctx, id), { timeout: 5_000 }).toContain('connected')

    const get = await api(ctx, 'GET', `/api/sessions/${id}`)
    expect(get.body.status).toBe('WARMING')
  })

  it('AC-T05-03 credenciais persistidas cifradas (auth state do T02, sem texto puro)', async () => {
    const { id, transport } = await connectedSession(ctx)
    const auth = transport.lastConnect.auth
    // o auth state vem do usePostgresAuthState (creds do Baileys inicializadas)
    expect(auth?.creds?.noiseKey?.public, 'connect deveria receber o AuthenticationState do Postgres').toBeTruthy()
    expect(typeof transport.lastConnect.saveCreds, 'saveCreds precisa ir em ConnectOptions').toBe('function')

    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)

    // nada legível no banco: nenhuma coluna de credencial contém JSON/nomes de chaves do Baileys
    const leaked = sqlOk(
      ctx.tempDb.url,
      `SELECT count(*) FROM session_credentials WHERE session_id = ${lit(id)}
         AND (encode(ciphertext, 'escape') ILIKE '%noiseKey%' OR encode(ciphertext, 'escape') ILIKE '%registrationId%');`,
    )[0]![0]
    expect(Number(leaked), 'credenciais em texto puro no banco').toBe(0)
    const pub = Buffer.from(auth.creds.noiseKey.public).toString('hex')
    const plain = sqlOk(ctx.tempDb.url, `SELECT count(*) FROM session_credentials WHERE position(decode(${lit(pub)}, 'hex') in ciphertext) > 0;`)[0]![0]
    expect(Number(plain), 'chave pública do noiseKey aparece sem cifra').toBe(0)

    // e o que foi salvo decifra para as mesmas credenciais que o transporte recebeu
    const reloaded = await (usePostgresAuthState as any)(ctx.db, id)
    expect(Buffer.from(reloaded.state.creds.noiseKey.public).equals(Buffer.from(auth.creds.noiseKey.public))).toBe(true)
  })

  it('AC-T05-03 monitoramento iniciado: o hook onConnected é chamado com o sessionId ao abrir', async () => {
    const s = await createSession(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)).status).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    expect(ctx.connected, 'monitoramento não pode começar antes do open').not.toContain(s.id)
    await ctx.tf.last(s.id)!.login()
    await waitStatus(ctx, s.id, 'WARMING')
    await expect.poll(() => ctx.connected.includes(s.id), { timeout: 5_000 }).toBe(true)
  })

  it("AC-T05-03 o SessionManager emite o evento 'connected' {sessionId} ao abrir", async () => {
    const seen: string[] = []
    ctx.manager.on('connected', (e: any) => seen.push(typeof e === 'string' ? e : e?.sessionId))
    const { id } = await connectedSession(ctx)
    await expect.poll(() => seen.includes(id), { timeout: 5_000 }).toBe(true)
  })

  it('AC-T05-03 sem open não há WARMING, credenciais de login nem health_event connected', async () => {
    const s = await createSession(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)).status).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    ctx.tf.last(s.id)!.emitQr()
    await new Promise((r) => setTimeout(r, 200))
    expect(sessionRow(ctx, s.id)!.status).toBe('NEW')
    expect(healthTypes(ctx, s.id)).not.toContain('connected')
    expect(ctx.connected).not.toContain(s.id)
  })
})
