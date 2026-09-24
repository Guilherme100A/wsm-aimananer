import { describe, expect, it } from 'vitest'
import { insertRow, lit, sql, sqlState } from '../helpers/pg'
import { MESSAGE_STATUSES, SESSION_STATUSES, useMigratedDb } from './shared'

describe('T01 — sessions, proxies e status', () => {
  const ctx = useMigratedDb()

  it('AC-T01-02 um proxy só pode ser vinculado a uma sessão: segunda sessão com o mesmo proxy_id falha no banco', () => {
    const proxy = insertRow(ctx.db.url, 'proxies')
    expect(proxy.id, 'proxies deve ter coluna id').toBeTruthy()

    insertRow(ctx.db.url, 'sessions', { proxy_id: proxy.id! })
    expect(() => insertRow(ctx.db.url, 'sessions', { proxy_id: proxy.id! })).toThrow(/23505/)
  })

  it('AC-T01-02 proxy_id é único apenas quando não nulo: várias sessões sem proxy são aceitas', () => {
    for (let i = 0; i < 3; i++) insertRow(ctx.db.url, 'sessions', { proxy_id: null })
  })

  it('AC-T01-02 trocar o proxy de uma sessão para um já vinculado falha no banco', () => {
    const p1 = insertRow(ctx.db.url, 'proxies')
    const p2 = insertRow(ctx.db.url, 'proxies')
    insertRow(ctx.db.url, 'sessions', { proxy_id: p1.id! })
    const s2 = insertRow(ctx.db.url, 'sessions', { proxy_id: p2.id! })
    const r = sql(ctx.db.url, `UPDATE sessions SET proxy_id = ${lit(p1.id!)} WHERE id = ${lit(s2.id!)};`)
    expect(r.code, 'update para proxy já vinculado deveria falhar').not.toBe(0)
    expect(sqlState(r)).toBe('23505')
  })

  it('AC-T01-06 sessions.status aceita todos os estados da seção 3.2', () => {
    for (const status of SESSION_STATUSES) {
      const row = insertRow(ctx.db.url, 'sessions', { status })
      expect(row.status).toBe(status)
    }
  })

  it('AC-T01-06 sessions.status rejeita valores fora da seção 3.2', () => {
    const s = insertRow(ctx.db.url, 'sessions')
    for (const bad of ['BOGUS', 'CONNECTED', 'new', '']) {
      const r = sql(ctx.db.url, `UPDATE sessions SET status = ${lit(bad)} WHERE id = ${lit(s.id!)};`)
      expect(r.code, `status '${bad}' deveria ser rejeitado`).not.toBe(0)
      expect(['22P02', '23514'], r.stderr).toContain(sqlState(r))
    }
  })

  it('AC-T01-06 messages.status aceita todos os estados da seção 3.3', () => {
    for (const status of MESSAGE_STATUSES) {
      const row = insertRow(ctx.db.url, 'messages', { status })
      expect(row.status).toBe(status)
    }
  })

  it('AC-T01-06 messages.status rejeita valores fora da seção 3.3', () => {
    const m = insertRow(ctx.db.url, 'messages')
    for (const bad of ['bogus', 'QUEUED', 'pending', '']) {
      const r = sql(ctx.db.url, `UPDATE messages SET status = ${lit(bad)} WHERE id = ${lit(m.id!)};`)
      expect(r.code, `status '${bad}' deveria ser rejeitado`).not.toBe(0)
      expect(['22P02', '23514'], r.stderr).toContain(sqlState(r))
    }
  })
})
