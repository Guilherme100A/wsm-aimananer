// T20 — ponte API → worker: sessions.addGroupParticipant e reconstrução do GroupAddError.
import { describe, expect, it } from 'vitest'
import { GroupAddError } from '@wsm/core'
import { createWorkerBridge, reviveError, type FetchLike } from './client'

describe('ponte — addGroupParticipant', () => {
  it('RPC sessions.addGroupParticipant com os três ids e o token interno', async () => {
    const calls: Array<{ headers: Record<string, string>; body: unknown }> = []
    const fetch: FetchLike = async (_url, init) => {
      calls.push({ headers: init.headers, body: JSON.parse(init.body) })
      return { status: 200, json: async () => ({ result: { groupId: 'g', targetSessionId: 't', jid: 'j', result: 'added', attempted: true } }) }
    }
    const b = createWorkerBridge({ url: 'http://w', token: 'itok', fetch })
    expect(await b.sessions.addGroupParticipant('a', 'g', 't')).toMatchObject({ result: 'added' })
    expect(calls[0]).toEqual({ headers: expect.objectContaining({ authorization: 'Bearer itok' }), body: { target: 'sessions', method: 'addGroupParticipant', args: ['a', 'g', 't'] } })
  })

  it('GroupAddError volta com code, status e details', () => {
    const e = reviveError({ name: 'GroupAddError', code: 'RATE_LIMIT', message: 'x', details: { result: 'rate_limited', attempted: false, jid: 'j', retryAfterMs: 5 } })
    expect(e).toBeInstanceOf(GroupAddError)
    expect(e).toMatchObject({ code: 'RATE_LIMIT', status: 429, details: { retryAfterMs: 5 } })
  })

  it('o transporte remoto não adiciona participantes (só pela rota)', async () => {
    const b = createWorkerBridge({ url: 'http://w', token: 'itok', fetch: async () => ({ status: 200, json: async () => ({}) }) })
    await expect(b.sessions.getTransport('x')!.addGroupParticipant('g', 'j')).rejects.toThrow('not available')
  })
})
