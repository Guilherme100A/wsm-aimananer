import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeJid, fakePhone, uniqueId } from '../helpers/factories'
import { fakeAuthState, loadTransport } from '../helpers/transport'

let FakeTransport: new (...a: any[]) => any

beforeEach(async () => {
  ;({ FakeTransport } = await loadTransport())
})

/** Transporte falso já conectado e aberto, pronto para enviar. */
async function openTransport() {
  const t = new FakeTransport()
  await t.connect({ sessionId: uniqueId('session'), auth: fakeAuthState() })
  t.open()
  return t
}

describe('T04 — FakeTransport', () => {
  it('AC-T04-01 FakeTransport expõe os helpers de simulação e sent[]', () => {
    const t = new FakeTransport()
    for (const helper of ['emitQr', 'emitPairingCode', 'open', 'close', 'receive', 'receipt', 'failNextSend']) {
      expect(typeof t[helper], `helper ${helper} ausente`).toBe('function')
    }
    expect(Array.isArray(t.sent)).toBe(true)
    expect(t.sent).toHaveLength(0)
  })

  it('AC-T04-01 FakeTransport implementa a interface WaTransport', async () => {
    const t = new FakeTransport()
    for (const m of ['connect', 'on', 'sendMessage', 'fetchGroups', 'logout', 'close']) {
      expect(typeof t[m], `método ${m} ausente`).toBe('function')
    }
    await expect(t.connect({ sessionId: uniqueId('session'), auth: fakeAuthState() })).resolves.toBeUndefined()
    t.open()
    await expect(t.fetchGroups()).resolves.toSatisfy(Array.isArray)
    await expect(t.logout()).resolves.toBeUndefined()
  })

  it('AC-T04-01 emitQr(qr) entrega o QR aos listeners de "qr"', async () => {
    const t = new FakeTransport()
    const onQr = vi.fn()
    t.on('qr', onQr)
    await t.connect({ sessionId: uniqueId('session'), auth: fakeAuthState() })
    t.emitQr('2@fake-qr-payload')
    await vi.waitFor(() => expect(onQr).toHaveBeenCalledWith('2@fake-qr-payload'))
  })

  it('AC-T04-01 emitPairingCode(code) entrega o código aos listeners de "pairing-code"', async () => {
    const t = new FakeTransport()
    const onCode = vi.fn()
    t.on('pairing-code', onCode)
    await t.connect({ sessionId: uniqueId('session'), auth: fakeAuthState(), pairingPhone: fakePhone() })
    t.emitPairingCode('WXYZ9876')
    await vi.waitFor(() => expect(onCode).toHaveBeenCalledWith('WXYZ9876'))
  })

  it('AC-T04-01 open() emite connection { state: "open" }', async () => {
    const t = new FakeTransport()
    const onConn = vi.fn()
    t.on('connection', onConn)
    await t.connect({ sessionId: uniqueId('session'), auth: fakeAuthState() })
    t.open()
    await vi.waitFor(() => expect(onConn).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' })))
  })

  it.each([
    ['loggedOut', 401],
    ['forbidden', 403],
    ['transient', 428],
  ] as const)('AC-T04-01 close("%s", %i) emite connection { state: "close", reason, statusCode }', async (reason, statusCode) => {
    const t = await openTransport()
    const onConn = vi.fn()
    t.on('connection', onConn)
    t.close(reason, statusCode)
    await vi.waitFor(() => expect(onConn).toHaveBeenCalledWith(expect.objectContaining({ state: 'close', reason, statusCode })))
  })

  it('AC-T04-01 close(reason) sem statusCode emite connection { state: "close", reason }', async () => {
    const t = await openTransport()
    const onConn = vi.fn()
    t.on('connection', onConn)
    t.close('transient')
    await vi.waitFor(() => expect(onConn).toHaveBeenCalledWith(expect.objectContaining({ state: 'close', reason: 'transient' })))
  })

  it('AC-T04-01 receive(msg) entrega a mensagem aos listeners de "message"', async () => {
    const t = await openTransport()
    const onMsg = vi.fn()
    t.on('message', onMsg)
    const msg = { id: uniqueId('in'), from: fakeJid(), text: 'olá, teste de recebimento', timestamp: Date.now() }
    t.receive(msg)
    await vi.waitFor(() => expect(onMsg).toHaveBeenCalledWith(expect.objectContaining(msg)))
  })

  it('AC-T04-01 sendMessage registra o envio em sent[] e devolve messageId', async () => {
    const t = await openTransport()
    const to = fakeJid()
    const content = { text: `teste ${uniqueId('msg')}` }
    const res = await t.sendMessage(to, content)
    expect(typeof res?.messageId).toBe('string')
    expect(res.messageId.length).toBeGreaterThan(0)
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toMatchObject({ to, content })

    const res2 = await t.sendMessage(to, { text: 'segunda' })
    expect(res2.messageId).not.toBe(res.messageId)
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1]).toMatchObject({ to, content: { text: 'segunda' } })
  })

  it('AC-T04-01 receipt(id, status) emite "receipt" com delivered e read', async () => {
    const t = await openTransport()
    const onReceipt = vi.fn()
    t.on('receipt', onReceipt)
    const { messageId } = await t.sendMessage(fakeJid(), { text: 'confirmação' })
    t.receipt(messageId, 'delivered')
    t.receipt(messageId, 'read')
    await vi.waitFor(() => {
      expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ messageId, status: 'delivered' }))
      expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ messageId, status: 'read' }))
    })
  })

  it('AC-T04-01 failNextSend(err) faz só o próximo sendMessage rejeitar com esse erro', async () => {
    const t = await openTransport()
    const err = new Error('falha simulada de envio')
    t.failNextSend(err)

    const failedTo = fakeJid()
    await expect(t.sendMessage(failedTo, { text: 'vai falhar' })).rejects.toBe(err)

    const okTo = fakeJid()
    await expect(t.sendMessage(okTo, { text: 'vai passar' })).resolves.toMatchObject({ messageId: expect.any(String) })
    const okEntries = t.sent.filter((s: any) => s.to === okTo)
    expect(okEntries).toHaveLength(1)
    expect(okEntries[0]).toMatchObject({ to: okTo, content: { text: 'vai passar' } })
  })

  it('AC-T04-01 instâncias de FakeTransport são independentes', async () => {
    const a = await openTransport()
    const b = await openTransport()
    await a.sendMessage(fakeJid(), { text: 'só em a' })
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
  })
})
