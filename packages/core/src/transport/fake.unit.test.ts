import { describe, expect, it, vi } from 'vitest'
import { FakeTransport } from './fake'
import { TransportNotConnectedError, type AuthenticationState, type WaTransport } from './types'

const auth = { creds: {}, keys: {} } as unknown as AuthenticationState

describe('FakeTransport', () => {
  it('implementa WaTransport e registra connect', async () => {
    const t: WaTransport = new FakeTransport()
    await t.connect({ sessionId: 's1', auth, proxyUrl: 'socks5://p:1080' })
    expect((t as FakeTransport).lastConnect).toMatchObject({ sessionId: 's1', proxyUrl: 'socks5://p:1080' })
  })

  it('emitQr / emitPairingCode emitem os eventos', () => {
    const t = new FakeTransport()
    const qr = vi.fn()
    const code = vi.fn()
    t.on('qr', qr)
    t.on('pairing-code', code)
    t.emitQr('QR-1')
    t.emitPairingCode('ABCD1234')
    expect(qr).toHaveBeenCalledWith('QR-1')
    expect(code).toHaveBeenCalledWith('ABCD1234')
  })

  it('open() e close(reason, statusCode) emitem connection', async () => {
    const t = new FakeTransport()
    const conn = vi.fn()
    t.on('connection', conn)
    t.open()
    expect(t.connected).toBe(true)
    await t.close('forbidden', 403)
    expect(t.connected).toBe(false)
    expect(conn.mock.calls).toEqual([[{ state: 'open' }], [{ state: 'close', reason: 'forbidden', statusCode: 403 }]])
  })

  it('close() sem argumentos encerra localmente sem emitir evento', async () => {
    const t = new FakeTransport()
    const conn = vi.fn()
    t.open()
    t.on('connection', conn)
    await t.close()
    expect(t.closed).toBe(true)
    expect(t.connected).toBe(false)
    expect(conn).not.toHaveBeenCalled()
  })

  it('logout() emite close loggedOut', async () => {
    const t = new FakeTransport()
    const conn = vi.fn()
    t.on('connection', conn)
    t.open()
    await t.logout()
    expect(t.loggedOut).toBe(true)
    expect(conn).toHaveBeenLastCalledWith({ state: 'close', reason: 'loggedOut', statusCode: 401 })
  })

  it('receive(msg) completa defaults e emite message', () => {
    const t = new FakeTransport()
    const onMsg = vi.fn()
    t.on('message', onMsg)
    const m = t.receive({ from: '5511999999999@s.whatsapp.net', text: 'oi' })
    expect(m).toMatchObject({ from: '5511999999999@s.whatsapp.net', text: 'oi', fromMe: false, type: 'conversation' })
    expect(typeof m.id).toBe('string')
    expect(onMsg).toHaveBeenCalledWith(m)
  })

  it('receipt(id, status) emite receipt', () => {
    const t = new FakeTransport()
    const onReceipt = vi.fn()
    t.on('receipt', onReceipt)
    t.receipt('M1', 'read')
    expect(onReceipt).toHaveBeenCalledWith({ messageId: 'M1', status: 'read' })
  })

  it('sendMessage registra em sent[] com IDs únicos', async () => {
    const t = new FakeTransport()
    t.open()
    const a = await t.sendMessage('a@s.whatsapp.net', { text: '1' })
    const b = await t.sendMessage('b@s.whatsapp.net', { text: '2' })
    expect(a.messageId).not.toBe(b.messageId)
    expect(t.sent.map((s) => [s.messageId, s.to, s.content])).toEqual([
      [a.messageId, 'a@s.whatsapp.net', { text: '1' }],
      [b.messageId, 'b@s.whatsapp.net', { text: '2' }],
    ])
  })

  it('failNextSend(err) faz só o próximo envio falhar', async () => {
    const t = new FakeTransport()
    t.open()
    const err = new Error('boom')
    t.failNextSend(err)
    await expect(t.sendMessage('a@s.whatsapp.net', { text: 'x' })).rejects.toBe(err)
    await expect(t.sendMessage('a@s.whatsapp.net', { text: 'y' })).resolves.toHaveProperty('messageId')
    expect(t.sent).toHaveLength(1)
  })

  it('sendMessage e fetchGroups sem conexão rejeitam com TransportNotConnectedError', async () => {
    const t = new FakeTransport()
    await expect(t.sendMessage('a@s.whatsapp.net', { text: 'x' })).rejects.toBeInstanceOf(TransportNotConnectedError)
    await expect(t.fetchGroups()).rejects.toBeInstanceOf(TransportNotConnectedError)
    expect(t.sent).toHaveLength(0)
  })

  it('fetchGroups devolve os grupos configurados', async () => {
    const t = new FakeTransport()
    t.open()
    t.setGroups([{ id: 'g@g.us', name: 'G', participants: 3, announce: false }])
    await expect(t.fetchGroups()).resolves.toEqual([{ id: 'g@g.us', name: 'G', participants: 3, announce: false }])
  })

  it('erro em um listener não impede os demais; off() remove', () => {
    const t = new FakeTransport()
    const ok = vi.fn()
    const removed = vi.fn()
    t.on('qr', () => {
      throw new Error('listener quebrado')
    })
    t.on('qr', ok)
    t.on('qr', removed)
    t.off('qr', removed)
    t.emitQr('q')
    expect(ok).toHaveBeenCalledWith('q')
    expect(removed).not.toHaveBeenCalled()
    expect(t.listenerCount('qr')).toBe(2)
  })
})
