import { api, connectedSession, delay, healthTypes, statusOf, useSessions, waitStatus } from './shared'
import { describe, expect, it } from 'vitest'

describe('T05 — quedas de conexão', () => {
  const ctx = useSessions()

  it('AC-T05-05 close(loggedOut) → DISCONNECTED, sem reconexão', async () => {
    const { id, transport } = await connectedSession(ctx)
    const sleepsBefore = ctx.sleeps.length
    await transport.close('loggedOut', 401)
    await waitStatus(ctx, id, 'DISCONNECTED')
    await delay(300)
    expect(ctx.tf.connectCount(id), 'loggedOut não pode reconectar').toBe(1)
    expect(ctx.tf.transports(id)).toHaveLength(1)
    expect(ctx.sleeps.length, 'loggedOut não pode agendar backoff').toBe(sleepsBefore)
    expect(statusOf(ctx, id)).toBe('DISCONNECTED')
  })

  it('AC-T05-05 depois de loggedOut, um restart do worker também não reconecta a sessão', async () => {
    const { id, transport } = await connectedSession(ctx)
    await transport.close('loggedOut', 401)
    await waitStatus(ctx, id, 'DISCONNECTED')
    await ctx.restart()
    await delay(300)
    expect(ctx.tf.connectCount(id)).toBe(0)
    expect(statusOf(ctx, id)).toBe('DISCONNECTED')
  })

  it('AC-T05-05 close(forbidden) → PAUSED com health_event forbidden_403, sem reconexão', async () => {
    const { id, transport } = await connectedSession(ctx)
    const sleepsBefore = ctx.sleeps.length
    await transport.close('forbidden', 403)
    await waitStatus(ctx, id, 'PAUSED')
    await expect.poll(() => healthTypes(ctx, id), { timeout: 5_000 }).toContain('forbidden_403')
    await delay(300)
    expect(ctx.tf.connectCount(id), 'forbidden não pode reconectar').toBe(1)
    expect(ctx.sleeps.length).toBe(sleepsBefore)
    expect(statusOf(ctx, id)).toBe('PAUSED')
  })

  it('AC-T05-05 close(transient) → reconecta após backoff e, ao abrir, volta ao estado anterior', async () => {
    const { id, transport } = await connectedSession(ctx)
    const sleepsBefore = ctx.sleeps.length
    await transport.close('transient', 428)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000, message: 'não reconectou após queda transient' }).toBe(2)
    expect(ctx.sleeps.length, 'reconexão deveria passar pelo sleep/backoff injetado').toBe(sleepsBefore + 1)
    expect(ctx.sleeps.at(-1)!).toBeGreaterThan(0)
    expect(statusOf(ctx, id), 'queda transient não é logout').not.toBe('DISCONNECTED')

    await ctx.tf.last(id)!.login()
    await delay(150)
    expect(statusOf(ctx, id)).toBe('WARMING')
  })

  it('AC-T05-05 close(transient) repetido: backoff exponencial, máx. 5 tentativas e depois DISCONNECTED', async () => {
    const { id } = await connectedSession(ctx)
    const sleepsBefore = ctx.sleeps.length

    // queda inicial + 5 tentativas de reconexão que caem de novo antes de abrir
    for (let attempt = 1; attempt <= 5; attempt++) {
      await ctx.tf.last(id)!.close('transient', 408)
      await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000, message: `tentativa ${attempt} não ocorreu` }).toBe(1 + attempt)
    }
    await ctx.tf.last(id)!.close('transient', 408)
    await waitStatus(ctx, id, 'DISCONNECTED')
    await delay(300)
    expect(ctx.tf.connectCount(id), 'passou de 5 tentativas de reconexão').toBe(6)

    const delays = ctx.sleeps.slice(sleepsBefore)
    expect(delays, `delays de backoff: ${JSON.stringify(delays)}`).toHaveLength(5)
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]! / delays[i - 1]!, `backoff não é exponencial: ${JSON.stringify(delays)}`).toBeGreaterThanOrEqual(1.5)
    }
    expect(delays[4]! / delays[0]!).toBeGreaterThanOrEqual(8)
  })

  it('AC-T05-05 reconexão bem-sucedida zera o contador: nova queda recomeça do primeiro delay', async () => {
    const { id } = await connectedSession(ctx)
    const base = ctx.sleeps.length

    await ctx.tf.last(id)!.close('transient', 408)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(2)
    await ctx.tf.last(id)!.close('transient', 408)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(3)
    await ctx.tf.last(id)!.login()
    await waitStatus(ctx, id, 'WARMING')

    await ctx.tf.last(id)!.close('transient', 408)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(4)
    const [first, second, afterReset] = ctx.sleeps.slice(base)
    expect(second!).toBeGreaterThan(first!)
    expect(afterReset, 'após abrir com sucesso, o backoff deveria recomeçar').toBe(first)

    // e ainda tem direito a 5 tentativas completas
    for (let attempt = 2; attempt <= 5; attempt++) {
      await ctx.tf.last(id)!.close('transient', 408)
      await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(3 + attempt)
    }
    expect(statusOf(ctx, id)).not.toBe('DISCONNECTED')
    await ctx.tf.last(id)!.close('transient', 408)
    await waitStatus(ctx, id, 'DISCONNECTED')
    expect(ctx.tf.connectCount(id)).toBe(8)
  })

  it('AC-T05-05 sessão DISCONNECTED por falha de reconexão não reconecta no restart', async () => {
    const { id } = await connectedSession(ctx)
    for (let attempt = 1; attempt <= 5; attempt++) {
      await ctx.tf.last(id)!.close('transient')
      await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(1 + attempt)
    }
    await ctx.tf.last(id)!.close('transient')
    await waitStatus(ctx, id, 'DISCONNECTED')
    await ctx.restart()
    await delay(300)
    expect(ctx.tf.connectCount(id)).toBe(0)
  })

  it('AC-T05-05 a API reflete o estado após cada tipo de queda', async () => {
    const a = await connectedSession(ctx)
    const b = await connectedSession(ctx)
    await a.transport.close('loggedOut', 401)
    await b.transport.close('forbidden', 403)
    await waitStatus(ctx, a.id, 'DISCONNECTED')
    await waitStatus(ctx, b.id, 'PAUSED')
    expect((await api(ctx, 'GET', `/api/sessions/${a.id}`)).body.status).toBe('DISCONNECTED')
    expect((await api(ctx, 'GET', `/api/sessions/${b.id}`)).body.status).toBe('PAUSED')
  })
})
