import { describe, expect, it } from 'vitest'
import { InvalidTransitionError, MessageNotFoundError, SessionError, SessionNotConnectedError, TransportNotConnectedError, listSessionGroups } from '@wsm/core'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'
import { createWorkerBridge, reviveError, WorkerUnavailableError, type FetchLike } from './client'

type Reply = { status?: number; body: unknown } | Error

function bridge(reply: (req: { target: string; method: string; args: unknown[] }) => Reply) {
  const calls: { url: string; headers: Record<string, string>; body: { target: string; method: string; args: unknown[] } }[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as { target: string; method: string; args: unknown[] }
    calls.push({ url, headers: init.headers, body })
    const r = reply(body)
    if (r instanceof Error) throw r
    return { status: r.status ?? 200, json: async () => r.body }
  }
  return { b: createWorkerBridge({ url: 'http://worker:9465/', token: 'itok', fetch }), calls }
}

describe('createWorkerBridge', () => {
  it('POST /internal/rpc com Bearer e {target, method, args}', async () => {
    const { b, calls } = bridge(() => ({ body: { result: [{ id: 'a' }] } }))
    expect(await b.sessions.list()).toEqual([{ id: 'a' }])
    await b.sessions.requestPairingCode('s1')
    await b.messages.enqueue({ sessionId: 's', phone: '+551', content: { text: 'x' } })
    expect(calls[0]).toMatchObject({ url: 'http://worker:9465/internal/rpc', headers: { authorization: 'Bearer itok' }, body: { target: 'sessions', method: 'list', args: [] } })
    expect(calls[1]!.body).toEqual({ target: 'sessions', method: 'requestPairingCode', args: ['s1', null] })
    expect(calls[2]!.body.target).toBe('messages')
  })

  it('recria os erros de domínio com as classes originais', async () => {
    const { b } = bridge(({ method }) => {
      if (method === 'get') return { body: { error: { name: 'SessionError', code: 'SESSION_NOT_FOUND', message: 'nf' } } }
      if (method === 'pause') return { body: { error: { name: 'InvalidTransitionError', code: 'INVALID_TRANSITION', from: 'NEW', to: 'pause', message: 'no' } } }
      return { body: { error: { name: 'MessageNotFoundError', messageId: 'm1', message: 'x' } } }
    })
    await expect(b.sessions.get('x')).rejects.toBeInstanceOf(SessionError)
    const e = await b.sessions.pause('x').catch((err: unknown) => err)
    expect(e).toBeInstanceOf(InvalidTransitionError)
    expect(e).toMatchObject({ from: 'NEW', to: 'pause', code: 'INVALID_TRANSITION' })
    await expect(b.messages.cancel('m1')).rejects.toBeInstanceOf(MessageNotFoundError)
    expect(reviveError({ name: 'TransportNotConnectedError', message: 'x' })).toBeInstanceOf(TransportNotConnectedError)
    expect(reviveError({ name: 'SessionNotConnectedError', sessionId: 's', message: 'x' })).toBeInstanceOf(SessionNotConnectedError)
    expect(reviveError({ name: 'Weird', code: 'Z', message: 'm' })).toMatchObject({ name: 'Weird', code: 'Z', message: 'm' })
  })

  it('worker fora do ar ou token inválido → WorkerUnavailableError', async () => {
    await expect(bridge(() => new Error('ECONNREFUSED')).b.sessions.list()).rejects.toBeInstanceOf(WorkerUnavailableError)
    await expect(bridge(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } })).b.sessions.list()).rejects.toBeInstanceOf(
      WorkerUnavailableError,
    )
    await expect(bridge(() => ({ status: 502, body: {} })).b.sessions.list()).rejects.toBeInstanceOf(WorkerUnavailableError)
  })

  it('transporte remoto: fetchGroups pela ponte; não conectado vira SESSION_NOT_CONNECTED nos grupos', async () => {
    const { b } = bridge(({ args }) =>
      args[0] === 'on' ? { body: { result: [{ id: 'g', name: 'G', participants: 1, announce: false }] } } : { body: { error: { name: 'TransportNotConnectedError', message: 'x' } } },
    )
    const store = { get: async (id: string) => ({ id, status: 'STABLE' as const }) }
    expect(await listSessionGroups({ store, sessionId: 'on', getTransport: b.sessions.getTransport })).toHaveLength(1)
    await expect(listSessionGroups({ store, sessionId: 'off', getTransport: b.sessions.getTransport })).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
    await expect(b.sessions.getTransport('x')!.sendMessage('a', { text: 'b' })).rejects.toThrow('not available')
  })

  it('as rotas da API funcionam sobre a ponte (mesmo mapeamento HTTP)', async () => {
    const { b } = bridge(({ method }) =>
      method === 'pause'
        ? { body: { error: { name: 'InvalidTransitionError', from: 'NEW', to: 'pause', message: 'no' } } }
        : { body: { error: { name: 'SessionError', code: 'SESSION_NOT_FOUND', message: 'nf' } } },
    )
    const { db } = fakeDb()
    const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: 't', sessions: b.sessions, messages: b.messages, health: b.health })
    const id = '11111111-1111-4111-8111-111111111111'
    const h = { authorization: 'Bearer t' }
    expect((await app.request(`/api/sessions/${id}/pause`, { method: 'POST', headers: h })).status).toBe(409)
    expect((await app.request(`/api/sessions/${id}`, { headers: h })).status).toBe(404)
    expect((await app.request(`/api/sessions/${id}/restart`, { method: 'POST', headers: h })).status).toBe(404)
  })
})
