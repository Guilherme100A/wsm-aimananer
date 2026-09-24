import { api, connectedSession, createSession, delay, sessionRow, statusOf, useSessions, waitStatus } from './shared'
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { lit, sqlOk } from '../helpers/pg'

describe('T05 — pause/resume/restart/logout', () => {
  const ctx = useSessions()
  const action = (id: string, a: string) => api(ctx, 'POST', `/api/sessions/${id}/${a}`)

  /** Transição inválida: 409 INVALID_TRANSITION e o estado não muda. */
  async function expectInvalid(id: string, a: string) {
    const before = statusOf(ctx, id)
    const res = await action(id, a)
    expectApiError(res, 'INVALID_TRANSITION', 409)
    await delay(50)
    expect(statusOf(ctx, id), `${a} inválido alterou o estado`).toBe(before)
  }

  it('AC-T05-06 pause: WARMING → PAUSED (200 com a sessão)', async () => {
    const { id } = await connectedSession(ctx)
    const res = await action(id, 'pause')
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ id, status: 'PAUSED' })
    expect(statusOf(ctx, id)).toBe('PAUSED')
  })

  it('AC-T05-06 resume: PAUSED → WARMING (somente resume manual)', async () => {
    const { id } = await connectedSession(ctx)
    expect((await action(id, 'pause')).status).toBe(200)
    const res = await action(id, 'resume')
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ id, status: 'WARMING' })
    expect(statusOf(ctx, id)).toBe('WARMING')
  })

  it('AC-T05-06 logout: WARMING → DISCONNECTED, chama logout no transporte e não reconecta', async () => {
    const { id, transport } = await connectedSession(ctx)
    const res = await action(id, 'logout')
    expect(res.status, res.text).toBe(200)
    expect(res.body.status).toBe('DISCONNECTED')
    await waitStatus(ctx, id, 'DISCONNECTED')
    expect(transport.logoutCalls, 'logout deveria deslogar no WhatsApp (transport.logout)').toBe(1)
    await delay(300)
    expect(ctx.tf.connectCount(id)).toBe(1)
  })

  it('AC-T05-06 logout de sessão PAUSED → DISCONNECTED (* → DISCONNECTED)', async () => {
    const { id } = await connectedSession(ctx)
    expect((await action(id, 'pause')).status).toBe(200)
    const res = await action(id, 'logout')
    expect(res.status, res.text).toBe(200)
    await waitStatus(ctx, id, 'DISCONNECTED')
  })

  it('AC-T05-06 restart: fecha e reconecta mantendo o estado; zera requires_restart', async () => {
    const { id, transport } = await connectedSession(ctx)
    sqlOk(ctx.tempDb.url, `UPDATE sessions SET requires_restart = true WHERE id = ${lit(id)};`)
    const res = await action(id, 'restart')
    expect(res.status, res.text).toBe(200)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000, message: 'restart não reconectou' }).toBe(2)
    expect(transport.closed || ctx.tf.last(id) !== transport, 'restart deveria fechar a conexão anterior').toBe(true)
    expect(statusOf(ctx, id)).toBe('WARMING')
    await expect.poll(() => sessionRow(ctx, id)!.requires_restart, { timeout: 5_000 }).toBe(false)
    await ctx.tf.last(id)!.login()
    await delay(100)
    expect(statusOf(ctx, id)).toBe('WARMING')
  })

  it('AC-T05-06 restart de sessão PAUSED reconecta e continua PAUSED', async () => {
    const { id } = await connectedSession(ctx)
    expect((await action(id, 'pause')).status).toBe(200)
    const res = await action(id, 'restart')
    expect(res.status, res.text).toBe(200)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(2)
    await ctx.tf.last(id)!.login()
    await delay(100)
    expect(statusOf(ctx, id)).toBe('PAUSED')
  })

  it('AC-T05-06 pause em NEW → 409 INVALID_TRANSITION', async () => {
    const s = await createSession(ctx)
    await expectInvalid(s.id, 'pause')
  })

  it('AC-T05-06 pause em PAUSED → 409 INVALID_TRANSITION', async () => {
    const { id } = await connectedSession(ctx)
    expect((await action(id, 'pause')).status).toBe(200)
    await expectInvalid(id, 'pause')
  })

  it('AC-T05-06 resume fora de PAUSED (NEW, WARMING, DISCONNECTED) → 409 INVALID_TRANSITION', async () => {
    const s = await createSession(ctx)
    await expectInvalid(s.id, 'resume')
    const { id } = await connectedSession(ctx)
    await expectInvalid(id, 'resume')
    expect((await action(id, 'logout')).status).toBe(200)
    await waitStatus(ctx, id, 'DISCONNECTED')
    await expectInvalid(id, 'resume')
  })

  it('AC-T05-06 em DISCONNECTED: pause, logout e restart → 409 INVALID_TRANSITION', async () => {
    const { id } = await connectedSession(ctx)
    expect((await action(id, 'logout')).status).toBe(200)
    await waitStatus(ctx, id, 'DISCONNECTED')
    await expectInvalid(id, 'pause')
    await expectInvalid(id, 'logout')
    await expectInvalid(id, 'restart')
    await delay(200)
    expect(ctx.tf.connectCount(id), 'restart inválido não pode reconectar').toBe(1)
  })

  it('AC-T05-06 sessão inexistente → 404 SESSION_NOT_FOUND em todas as ações', async () => {
    const id = '00000000-0000-4000-8000-000000000000'
    for (const a of ['pause', 'resume', 'restart', 'logout']) expectApiError(await action(id, a), 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T05-06 PAUSED não sai sozinho: nova abertura de conexão não retoma a sessão', async () => {
    const { id, transport } = await connectedSession(ctx)
    expect((await action(id, 'pause')).status).toBe(200)
    await transport.close('transient', 408)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(2)
    await ctx.tf.last(id)!.login()
    await delay(150)
    expect(statusOf(ctx, id), 'somente resume manual tira a sessão de PAUSED').toBe('PAUSED')
  })
})
