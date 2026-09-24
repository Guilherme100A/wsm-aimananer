import './env'
import { describe, expect, it, vi } from 'vitest'
import * as core from '@wsm/core'
import { fakeAuthState, fakeSocketFactory, waitUntil } from '../helpers/transport'

const C = core as Record<string, any>
const GID = '120363000000000123@g.us'
const JID = '5511988887777@s.whatsapp.net'

function fakeWith(groups: any[]) {
  const t = new C.FakeTransport()
  t.setGroups(groups)
  t.open()
  return t
}

const group = (over: Record<string, unknown> = {}) => ({ id: GID, name: 'G', participants: 3, announce: false, isAdmin: true, members: [], ...over })

describe('T20 — WaTransport.addGroupParticipant', () => {
  it('AC-T20-01 FakeTransport: sucesso → [{ jid, status: "added" }], inclui o membro, soma 1 em participants e registra a chamada', async () => {
    const t = fakeWith([group()])
    const r = await t.addGroupParticipant(GID, JID)
    expect(r).toEqual([expect.objectContaining({ jid: JID, status: 'added' })])
    expect(t.groupAdds).toEqual([{ groupId: GID, jid: JID }])
    const [g] = await t.fetchGroups()
    expect(g.participants).toBe(4)
    expect(g.isAdmin).toBe(true)
  })

  it('AC-T20-01 FakeTransport: participante já no grupo → status "already_member"', async () => {
    const t = fakeWith([group({ participants: 4, members: [JID] })])
    expect((await t.addGroupParticipant(GID, JID))[0]).toMatchObject({ jid: JID, status: 'already_member' })
    expect((await t.fetchGroups())[0].participants).toBe(4)
  })

  it('AC-T20-01 FakeTransport: sessão não é admin → status "not_admin" (não lança) e o grupo não muda', async () => {
    const t = fakeWith([group({ isAdmin: false })])
    expect((await t.addGroupParticipant(GID, JID))[0]).toMatchObject({ jid: JID, status: 'not_admin' })
    expect((await t.fetchGroups())[0].participants).toBe(3)
  })

  it('AC-T20-01 FakeTransport: grupo inexistente → status "group_not_found" (não lança)', async () => {
    const t = fakeWith([])
    expect((await t.addGroupParticipant(GID, JID))[0]).toMatchObject({ jid: JID, status: 'group_not_found' })
  })

  it('AC-T20-01 FakeTransport: sem conexão aberta → TransportNotConnectedError; failNextGroupAdd simula falha uma vez', async () => {
    const off = new C.FakeTransport()
    off.setGroups([group()])
    await expect(off.addGroupParticipant(GID, JID)).rejects.toBeInstanceOf(C.TransportNotConnectedError)

    const t = fakeWith([group()])
    t.failNextGroupAdd(new Error('rate-overlimit'))
    const first = await t.addGroupParticipant(GID, JID).then(
      (r: any) => r[0]?.status,
      () => 'thrown',
    )
    expect(['failed', 'thrown']).toContain(first)
    expect((await t.addGroupParticipant(GID, JID))[0].status).toBe('added')
  })

  it('AC-T20-01 BaileysTransport usa groupParticipantsUpdate(groupId, [jid], "add") e normaliza o status por participante', async () => {
    const factory = fakeSocketFactory()
    const transport = new C.BaileysTransport(factory.transportOptions())
    try {
      void transport.connect({ sessionId: 'sess-t20', auth: fakeAuthState() }).catch(() => {})
      await waitUntil(() => factory.sockets.length > 0, 10_000, 'socket criado')
      const { sock, emit } = factory.sockets[0]!
      emit('connection.update', { connection: 'open' })
      await new Promise((r) => setTimeout(r, 50))

      const cases: Array<[string, string]> = [
        ['200', 'added'],
        ['409', 'already_member'],
        ['403', 'not_allowed'],
        ['500', 'failed'],
      ]
      for (const [code, status] of cases) {
        sock.groupParticipantsUpdate = vi.fn(async (_g: string, jids: string[]) => jids.map((jid) => ({ status: code, jid, content: {} })))
        const r = await transport.addGroupParticipant(GID, JID)
        expect(sock.groupParticipantsUpdate).toHaveBeenCalledWith(GID, [JID], 'add')
        expect(r, `código ${code}`).toEqual([expect.objectContaining({ jid: JID, status })])
      }

      // erros do grupo inteiro no Baileys viram status, não exceção
      sock.groupParticipantsUpdate = vi.fn(async () => {
        throw Object.assign(new Error('item-not-found'), { data: 404, output: { statusCode: 404 } })
      })
      expect((await transport.addGroupParticipant(GID, JID))[0].status).toBe('group_not_found')
      sock.groupParticipantsUpdate = vi.fn(async () => {
        throw Object.assign(new Error('forbidden'), { data: 403, output: { statusCode: 403 } })
      })
      expect((await transport.addGroupParticipant(GID, JID))[0].status).toBe('not_admin')
    } finally {
      await transport.close().catch(() => {})
    }
  })

  it('AC-T20-01 a interface adiciona UM jid por chamada (sem variante em lote)', () => {
    const t = fakeWith([group()])
    expect(t.addGroupParticipant.length, 'assinatura (groupId, jid)').toBe(2)
    const methods = new Set<string>()
    for (let p = t; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) methods.add(k)
    expect([...methods].filter((m) => /(bulk|batch|many|all).*participant|participants$/i.test(m) && m !== 'participants')).toEqual([])
  })
})
