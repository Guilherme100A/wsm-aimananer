// T20 — addGroupParticipant no FakeTransport e no BaileysTransport (socket falso).
import { describe, expect, it, vi } from 'vitest'
import { BaileysTransport, isGroupAdmin, mapGroupErrorStatus, mapParticipantStatus, normalizeJid, type BaileysSocketLike } from './baileys'
import { FakeTransport } from './fake'
import { TransportNotConnectedError } from './types'

const JID = '5511988887777@s.whatsapp.net'

describe('FakeTransport.addGroupParticipant', () => {
  it('grupo inexistente, não admin, já membro e sucesso', async () => {
    const t = new FakeTransport()
    await expect(t.addGroupParticipant('g@g.us', JID)).rejects.toBeInstanceOf(TransportNotConnectedError)
    t.open()
    t.setGroups([
      { id: 'admin@g.us', name: 'A', participants: 1, announce: false, isAdmin: true, members: ['x@s.whatsapp.net'] },
      { id: 'member@g.us', name: 'M', participants: 3, announce: false, isAdmin: false },
    ])
    expect(await t.addGroupParticipant('nope@g.us', JID)).toEqual([{ jid: JID, status: 'group_not_found', code: 404 }])
    expect(await t.addGroupParticipant('member@g.us', JID)).toEqual([{ jid: JID, status: 'not_admin', code: 403 }])
    expect(await t.addGroupParticipant('admin@g.us', JID)).toEqual([{ jid: JID, status: 'added', code: 200 }])
    expect(await t.addGroupParticipant('admin@g.us', JID)).toEqual([{ jid: JID, status: 'already_member', code: 409 }])
    expect((await t.fetchGroups()).find((g) => g.id === 'admin@g.us')).toEqual({ id: 'admin@g.us', name: 'A', participants: 2, announce: false, isAdmin: true })
    expect(t.groupAdds).toHaveLength(4)
    t.failNextGroupAdd(new Error('boom'))
    await expect(t.addGroupParticipant('admin@g.us', JID)).rejects.toThrow('boom')
  })
})

function baileys(sock: Partial<BaileysSocketLike>) {
  const handlers = new Map<string, (p: unknown) => void>()
  const full = {
    ev: { on: (e: string, cb: (p: unknown) => void) => void handlers.set(e, cb) },
    sendMessage: vi.fn(),
    groupFetchAllParticipating: vi.fn(async () => ({})),
    requestPairingCode: vi.fn(),
    logout: vi.fn(),
    end: vi.fn(),
    ...sock,
  } as BaileysSocketLike
  const t = new BaileysTransport({ makeSocket: () => full })
  return {
    t,
    open: async () => {
      await t.connect({ sessionId: 's', auth: { creds: {}, keys: {} } as never })
      handlers.get('connection.update')?.({ connection: 'open' })
      await new Promise((r) => setImmediate(r))
    },
  }
}

describe('BaileysTransport — T20', () => {
  it('mapeia os códigos por participante e os erros do grupo', () => {
    expect([200, 409, 403, 404, 408, undefined].map(mapParticipantStatus)).toEqual(['added', 'already_member', 'not_allowed', 'group_not_found', 'failed', 'failed'])
    expect([404, 401, 403, 500].map(mapGroupErrorStatus)).toEqual(['group_not_found', 'not_admin', 'not_admin', 'failed'])
    expect(normalizeJid('5511:12@s.whatsapp.net')).toBe('5511@s.whatsapp.net')
  })

  it('groupParticipantsUpdate(groupId, [jid], "add") e normalização da resposta', async () => {
    const update = vi.fn(async () => [{ status: '409', jid: JID }])
    const { t, open } = baileys({ groupParticipantsUpdate: update })
    await open()
    expect(await t.addGroupParticipant('g@g.us', JID)).toEqual([{ jid: JID, status: 'already_member', code: 409 }])
    expect(update).toHaveBeenCalledWith('g@g.us', [JID], 'add')
  })

  it('erro do grupo (Boom 404/403) vira status; desconectado lança', async () => {
    const boom = (code: number) => Object.assign(new Error('x'), { output: { statusCode: code } })
    const update = vi.fn().mockRejectedValueOnce(boom(404)).mockRejectedValueOnce(boom(403)).mockRejectedValueOnce(new Error('weird'))
    const { t, open } = baileys({ groupParticipantsUpdate: update })
    await expect(t.addGroupParticipant('g@g.us', JID)).rejects.toBeInstanceOf(TransportNotConnectedError)
    await open()
    expect(await t.addGroupParticipant('g@g.us', JID)).toEqual([{ jid: JID, status: 'group_not_found', code: 404 }])
    expect(await t.addGroupParticipant('g@g.us', JID)).toEqual([{ jid: JID, status: 'not_admin', code: 403 }])
    expect(await t.addGroupParticipant('g@g.us', JID)).toEqual([{ jid: JID, status: 'failed' }])
  })

  it('isAdmin a partir dos participantes e da conta (id com dispositivo ou lid)', async () => {
    const own = new Set(['5511999990001@s.whatsapp.net', '123@lid'])
    expect(isGroupAdmin([{ id: '5511999990001@s.whatsapp.net', admin: 'admin' }], own)).toBe(true)
    expect(isGroupAdmin([{ id: '123@lid', admin: 'superadmin' }], own)).toBe(true)
    expect(isGroupAdmin([{ id: '5511999990001@s.whatsapp.net', admin: null }], own)).toBe(false)
    expect(isGroupAdmin([{ id: 'outro@s.whatsapp.net', admin: 'admin' }], own)).toBe(false)
    expect(isGroupAdmin(undefined, own)).toBe(false)

    const { t, open } = baileys({
      user: { id: '5511999990001:7@s.whatsapp.net' },
      groupFetchAllParticipating: vi.fn(async () => ({
        'a@g.us': { id: 'a@g.us', subject: 'A', participants: [{ id: '5511999990001@s.whatsapp.net', admin: 'admin' }] },
        'b@g.us': { id: 'b@g.us', subject: 'B', participants: [{ id: '5511999990001@s.whatsapp.net' }] },
      })),
    })
    await open()
    expect((await t.fetchGroups()).map((g) => [g.id, g.isAdmin])).toEqual([
      ['a@g.us', true],
      ['b@g.us', false],
    ])
  })
})
