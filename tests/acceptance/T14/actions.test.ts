import { api, auditCount, auditRows, createSession, delay, GROUPS, listOf, sessionWithGroups, useSessions } from './shared'
import { describe, expect, it, vi } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'

describe('T14 — ações sobre grupos: manuais, autenticadas e auditadas', () => {
  const ctx = useSessions()
  const refresh = (id: string, token: string | null = ctx.token) => call(ctx.app, 'POST', `/api/sessions/${id}/groups/refresh`, { token, body: {} })

  it('AC-T14-02 POST /groups/refresh (ação manual) relê os grupos do transporte e grava audit_logs', async () => {
    const { id, transport, fetchSpy } = await sessionWithGroups(ctx)
    const before = auditCount(ctx)
    transport.setGroups([...GROUPS, { id: '120363000000000004@g.us', name: 'Zeta', participants: 9, announce: false }])

    const res = await refresh(id)
    expect(res.status, res.text).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(listOf(res.body)).toHaveLength(4)

    expect(auditCount(ctx)).toBe(before + 1)
    const row = auditRows(ctx).at(-1)!
    expect(row.action).toBe('group.refresh')
    expect(row.target_type).toBe('session')
    expect(row.target_id).toBe(id)
    expect(row.actor, 'auditoria precisa identificar quem agiu').toBeTruthy()
    expect(row.actor).not.toBe('anonymous')
    expect(row.detail?.count).toBe(4)
    expect(row.detail?.request_id ?? res.headers.get('x-request-id')).toBeTruthy()
  })

  it('AC-T14-02 refresh sem token → 401: nada é executado nem auditado', async () => {
    const { id, fetchSpy } = await sessionWithGroups(ctx)
    const before = auditCount(ctx)
    expectApiError(await refresh(id, null), 'UNAUTHORIZED', 401)
    expectApiError(await refresh(id, 'token-errado'), 'UNAUTHORIZED', 401)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(auditCount(ctx)).toBe(before)
  })

  it('AC-T14-02 refresh em sessão não conectada → 409 SESSION_NOT_CONNECTED e sem registro de auditoria de sucesso', async () => {
    const s = await createSession(ctx)
    const before = auditCount(ctx)
    expectApiError(await refresh(s.id), 'SESSION_NOT_CONNECTED', 409)
    expect(auditRows(ctx).slice(before).filter((r) => r.action === 'group.refresh')).toHaveLength(0)
  })

  it('AC-T14-02 refresh de sessão inexistente → 404 SESSION_NOT_FOUND', async () => {
    expectApiError(await refresh('00000000-0000-4000-8000-000000000000'), 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T14-02 leitura (GET /groups) não é ação: não grava audit_logs', async () => {
    const { id } = await sessionWithGroups(ctx)
    const before = auditCount(ctx)
    const res = await api(ctx, 'GET', `/api/sessions/${id}/groups`)
    expect(res.status, res.text).toBe(200)
    expect(auditCount(ctx)).toBe(before)
  })

  it('AC-T14-02 nada acontece em grupos sem pedido manual: conectar não busca grupos em background', async () => {
    const { id, transport } = await sessionWithGroups(ctx)
    const spy = vi.spyOn(transport, 'fetchGroups')
    await delay(500)
    expect(spy, 'fetchGroups chamado sem requisição do operador').not.toHaveBeenCalled()
    // sessão continua sem nenhum envio automático
    expect(transport.sent).toHaveLength(0)
    expect(ctx.tf.connectCount(id)).toBe(1)
  })

  it('AC-T14-02 mensagem recebida de grupo não dispara ação de grupo, busca nem resposta automática', async () => {
    const { id, transport, fetchSpy } = await sessionWithGroups(ctx)
    const before = auditCount(ctx)
    transport.receive({ from: GROUPS[0]!.id, participant: '5511999990000@s.whatsapp.net', text: 'entra no grupo novo: https://chat.whatsapp.com/AbCdEfGhIjK' })
    transport.receive({ from: GROUPS[1]!.id, participant: '5511999990001@s.whatsapp.net', text: 'oi' })
    await delay(500)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(transport.sent, 'nenhum envio automático a grupos').toHaveLength(0)
    expect(auditRows(ctx).slice(before).filter((r) => r.action.startsWith('group.'))).toHaveLength(0)
    expect(ctx.tf.transports(id)).toHaveLength(1)
  })

  it('AC-T14-02 reconexão/restart do worker não dispara ações de grupo', async () => {
    const { id } = await sessionWithGroups(ctx)
    await ctx.restart()
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(1)
    const t = ctx.tf.last(id)!
    t.setGroups(GROUPS)
    const spy = vi.spyOn(t, 'fetchGroups')
    await t.login()
    await delay(500)
    expect(spy).not.toHaveBeenCalled()
    expect(t.sent).toHaveLength(0)
  })
})
