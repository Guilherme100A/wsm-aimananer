import { api, createSession, delay, GROUPS, listOf, sessionWithGroups, setStatus, useSessions, waitStatus } from './shared'
import { describe, expect, it } from 'vitest'
import { FakeTransport } from '@wsm/core'
import * as core from '@wsm/core'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'

describe('T14 — listagem de grupos', () => {
  const ctx = useSessions()

  it('AC-T14-01 GET /api/sessions/:id/groups lista { id, name, participants, status } vindos de transport.fetchGroups()', async () => {
    const { id, fetchSpy } = await sessionWithGroups(ctx)
    const res = await api(ctx, 'GET', `/api/sessions/${id}/groups`)
    expect(res.status, res.text).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const items = listOf(res.body)
    expect(items).toHaveLength(GROUPS.length)
    const byId = new Map(items.map((g: any) => [g.id, g]))
    for (const g of GROUPS) {
      const item: any = byId.get(g.id)
      expect(item, `grupo ${g.id} ausente`).toBeDefined()
      expect(item).toMatchObject({ id: g.id, name: g.name, participants: g.participants })
      expect(typeof item.participants).toBe('number')
      expect(item.status).toBe(g.announce ? 'announce' : 'open')
    }
  })

  it('AC-T14-01 grupos ordenados por nome', async () => {
    const { id } = await sessionWithGroups(ctx)
    const res = await api(ctx, 'GET', `/api/sessions/${id}/groups`)
    expect(listOf(res.body).map((g: any) => g.name)).toEqual(['Avisos Clientes', 'Equipe', 'Suporte Loja'])
  })

  it('AC-T14-01 a lista reflete o transporte vivo (sem cache velho): mudou no WhatsApp, muda na próxima leitura', async () => {
    const { id, transport, fetchSpy } = await sessionWithGroups(ctx)
    expect(listOf((await api(ctx, 'GET', `/api/sessions/${id}/groups`)).body)).toHaveLength(3)
    transport.setGroups([{ id: '120363000000000777@g.us', name: 'Novo', participants: 2, announce: true }])
    const res = await api(ctx, 'GET', `/api/sessions/${id}/groups`)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(listOf(res.body)).toEqual([expect.objectContaining({ id: '120363000000000777@g.us', name: 'Novo', participants: 2, status: 'announce' })])
  })

  it('AC-T14-01 sessão sem grupos → 200 { items: [] }', async () => {
    const { id } = await sessionWithGroups(ctx, [])
    const res = await api(ctx, 'GET', `/api/sessions/${id}/groups`)
    expect(res.status, res.text).toBe(200)
    expect(listOf(res.body)).toEqual([])
  })

  it('AC-T14-01 sessão STABLE também lista grupos', async () => {
    const { id } = await sessionWithGroups(ctx)
    setStatus(ctx, id, 'STABLE')
    const res = await api(ctx, 'GET', `/api/sessions/${id}/groups`)
    expect(res.status, res.text).toBe(200)
    expect(listOf(res.body)).toHaveLength(3)
  })

  it('AC-T14-01 sessão NEW (nunca conectada) → 409 SESSION_NOT_CONNECTED', async () => {
    const s = await createSession(ctx)
    expectApiError(await api(ctx, 'GET', `/api/sessions/${s.id}/groups`), 'SESSION_NOT_CONNECTED', 409)
  })

  it('AC-T14-01 conexão iniciada mas ainda não aberta (aguardando QR) → 409 SESSION_NOT_CONNECTED', async () => {
    const s = await createSession(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)).status).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    const t = ctx.tf.last(s.id)!
    t.setGroups(GROUPS)
    expectApiError(await api(ctx, 'GET', `/api/sessions/${s.id}/groups`), 'SESSION_NOT_CONNECTED', 409)
  })

  it('AC-T14-01 sessão PAUSED ou DISCONNECTED → 409 SESSION_NOT_CONNECTED', async () => {
    const a = await sessionWithGroups(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${a.id}/pause`)).status).toBe(200)
    expectApiError(await api(ctx, 'GET', `/api/sessions/${a.id}/groups`), 'SESSION_NOT_CONNECTED', 409)

    const b = await sessionWithGroups(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${b.id}/logout`)).status).toBe(200)
    await waitStatus(ctx, b.id, 'DISCONNECTED')
    expectApiError(await api(ctx, 'GET', `/api/sessions/${b.id}/groups`), 'SESSION_NOT_CONNECTED', 409)
  })

  it('AC-T14-01 conexão caiu (transient) → 409 SESSION_NOT_CONNECTED enquanto não reabrir', async () => {
    const { id, transport } = await sessionWithGroups(ctx)
    await transport.close('transient', 408)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(2)
    expectApiError(await api(ctx, 'GET', `/api/sessions/${id}/groups`), 'SESSION_NOT_CONNECTED', 409)
    await transport.login()
    await delay(100)
    const res = await api(ctx, 'GET', `/api/sessions/${id}/groups`)
    expect(res.status, res.text).toBe(200)
  })

  it('AC-T14-01 sessão inexistente ou id inválido → 404 SESSION_NOT_FOUND', async () => {
    expectApiError(await api(ctx, 'GET', '/api/sessions/00000000-0000-4000-8000-000000000000/groups'), 'SESSION_NOT_FOUND', 404)
    expectApiError(await api(ctx, 'GET', '/api/sessions/nao-e-uuid/groups'), 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T14-01 sem token → 401 UNAUTHORIZED e fetchGroups não é chamado', async () => {
    const { id, fetchSpy } = await sessionWithGroups(ctx)
    expectApiError(await call(ctx.app, 'GET', `/api/sessions/${id}/groups`), 'UNAUTHORIZED', 401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('AC-T14-01 @wsm/core: listGroups(transport) e toGroupView(g) mapeiam o GroupSummary do transporte', async () => {
    const { listGroups, toGroupView } = core as any
    expect(typeof listGroups).toBe('function')
    expect(typeof toGroupView).toBe('function')
    expect(toGroupView({ id: 'x@g.us', name: 'X', participants: 3, announce: true })).toMatchObject({ id: 'x@g.us', name: 'X', participants: 3, status: 'announce' })
    expect(toGroupView({ id: 'y@g.us', name: 'Y', participants: 1, announce: false }).status).toBe('open')

    const t = new (FakeTransport as any)()
    t.setGroups(GROUPS)
    t.open()
    const views = await listGroups(t)
    expect(views.map((g: any) => g.id).sort()).toEqual(GROUPS.map((g) => g.id).sort())
    for (const v of views) expect(Object.keys(v)).toEqual(expect.arrayContaining(['id', 'name', 'participants', 'status']))
  })
})
