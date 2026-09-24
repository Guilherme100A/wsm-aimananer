// T20 — createBridgeTargets + rota RPC sessions.addGroupParticipant (token interno).
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '@wsm/db'
import type { SessionManager } from '../sessions'
import { createBridgeTargets } from './bridge-targets'
import { createInternalApp } from './internal-server'

describe('createBridgeTargets', () => {
  it('sessions repassa ao manager e expõe addGroupParticipant pelo GroupParticipantService', async () => {
    const manager = { list: vi.fn(async () => [{ id: 'a' }]), isConnected: vi.fn(() => false), getTransport: vi.fn() } as unknown as SessionManager
    const targets = createBridgeTargets({ manager, queue: {} as never, health: { getHealth: vi.fn() }, db: {} as Database })
    expect(await targets.sessions.list()).toEqual([{ id: 'a' }])
    const add = vi.spyOn(targets.groupParticipants, 'add').mockResolvedValue({ groupId: 'g', targetSessionId: 't', jid: 'j', result: 'added', attempted: true, attemptId: 'x', clockAt: 0 })

    const app = createInternalApp({ token: 'itok', targets })
    const rpc = (headers: Record<string, string>) =>
      app.request('/internal/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ target: 'sessions', method: 'addGroupParticipant', args: ['a', 'g', 't'] }),
      })
    expect((await rpc({})).status).toBe(401)
    expect(add).not.toHaveBeenCalled()
    const res = await rpc({ authorization: 'Bearer itok' })
    expect(await res.json()).toEqual({ result: { groupId: 'g', targetSessionId: 't', jid: 'j', result: 'added', attempted: true, attemptId: 'x', clockAt: 0 } })
    expect(add).toHaveBeenCalledWith({ adminSessionId: 'a', groupId: 'g', targetSessionId: 't' })
  })
})
