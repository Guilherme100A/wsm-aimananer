// BaileysTransport testado com uma factory de socket falsa (makeWASocket mock): sem rede, sem WhatsApp.
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uniqueId } from '../helpers/factories'
import {
  blockExternalNetwork,
  boomError,
  fakeAuthState,
  fakeSocketFactory,
  loadTransport,
  requestThroughAgent,
  startProxySniffer,
  swallowProxySocketErrors,
  waitUntil,
} from '../helpers/transport'

let BaileysTransport: new (...a: any[]) => any
let guard: ReturnType<typeof blockExternalNetwork>
const cleanups: Array<() => Promise<unknown> | unknown> = []

beforeEach(async () => {
  ;({ BaileysTransport } = await loadTransport())
  guard = blockExternalNetwork()
})

afterEach(async () => {
  for (const c of cleanups.splice(0)) await Promise.resolve().then(c).catch(() => {})
  guard.restore()
})

/** Cria o transporte com a factory falsa e dispara connect() sem esperar o "open". */
async function startTransport(opts: { proxyUrl?: string } = {}) {
  const factory = fakeSocketFactory()
  const transport = new BaileysTransport(factory.transportOptions())
  cleanups.push(() => transport.close())
  const pending: Promise<unknown> = Promise.resolve()
    .then(() => transport.connect({ sessionId: uniqueId('session'), auth: fakeAuthState(), ...opts }))
    .catch((e: unknown) => e)
  await waitUntil(() => factory.makeSocket.mock.calls.length > 0, 10_000, 'BaileysTransport chamar a factory de socket injetada')
  return { transport, factory, pending }
}

describe('T04 — BaileysTransport: mapeamento de DisconnectReason', () => {
  const cases: Array<[number, string, 'loggedOut' | 'forbidden' | 'transient']> = [
    [401, 'loggedOut', 'loggedOut'],
    [403, 'forbidden', 'forbidden'],
    [428, 'connectionClosed', 'transient'],
    [408, 'connectionLost/timedOut', 'transient'],
    [440, 'connectionReplaced', 'transient'],
    [500, 'badSession', 'transient'],
    [515, 'restartRequired', 'transient'],
    [411, 'multideviceMismatch', 'transient'],
    [503, 'unavailableService', 'transient'],
  ]

  it.each(cases)('AC-T04-02 statusCode %i (%s) → reason "%s"', async (statusCode, _name, expected) => {
    const { transport, factory } = await startTransport()
    const onConn = vi.fn()
    transport.on('connection', onConn)

    factory.sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: boomError(statusCode), date: new Date() },
    })

    await vi.waitFor(() => expect(onConn).toHaveBeenCalledWith(expect.objectContaining({ state: 'close', reason: expected })))
    const update = onConn.mock.calls.map((c) => c[0]).find((u) => u?.state === 'close')
    if (update.statusCode !== undefined) expect(update.statusCode).toBe(statusCode)
  })

  it('AC-T04-02 close sem erro/statusCode conhecido → reason "transient"', async () => {
    const { transport, factory } = await startTransport()
    const onConn = vi.fn()
    transport.on('connection', onConn)

    factory.sockets[0].emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('socket hang up'), date: new Date() } })

    await vi.waitFor(() => expect(onConn).toHaveBeenCalledWith(expect.objectContaining({ state: 'close', reason: 'transient' })))
  })

  it('AC-T04-02 connection "open" do Baileys → connection { state: "open" } sem reason', async () => {
    const { transport, factory } = await startTransport()
    const onConn = vi.fn()
    transport.on('connection', onConn)

    factory.sockets[0].emit('connection.update', { connection: 'open' })

    await vi.waitFor(() => expect(onConn).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' })))
    const open = onConn.mock.calls.map((c) => c[0]).find((u) => u?.state === 'open')
    expect(open.reason).toBeUndefined()
  })
})

describe('T04 — BaileysTransport: proxy', () => {
  const schemes: Array<['http' | 'https' | 'socks5', (chunk: Buffer) => boolean, string]> = [
    ['http', (c) => c.toString('latin1').startsWith('CONNECT 192.0.2.1:443'), 'requisição HTTP CONNECT'],
    ['https', (c) => c[0] === 0x16, 'TLS ClientHello para o proxy'],
    ['socks5', (c) => c[0] === 0x05, 'saudação SOCKS5'],
  ]

  it.each(schemes)('AC-T04-03 proxyUrl %s:// passa agente de proxy em agent e fetchAgent do socket', async (scheme, looksLikeProxyTraffic, what) => {
    const swallow = swallowProxySocketErrors()
    const sniffer = await startProxySniffer()
    cleanups.push(() => sniffer.close(), () => new Promise((r) => setTimeout(r, 100)), () => swallow.restore())
    const proxyUrl = `${scheme}://proxyuser:proxypass@127.0.0.1:${sniffer.port}`

    const { factory } = await startTransport({ proxyUrl })
    const config = factory.lastConfig
    expect(config, 'factory de socket chamada sem config').toBeTruthy()

    for (const key of ['agent', 'fetchAgent'] as const) {
      const agent = config[key]
      expect(agent, `${key} não foi passado ao socket`).toBeTruthy()
      expect(agent, `${key} não é um http.Agent`).toBeInstanceOf(http.Agent)

      // O agente precisa rotear pelo proxy informado: o proxy local recebe o tráfego.
      const before = sniffer.firstChunks.length
      const req = requestThroughAgent(agent)
      cleanups.push(() => req.destroy())
      await waitUntil(() => sniffer.firstChunks.length > before, 5_000, `${key} conectar no proxy ${scheme}`)
      const chunk = sniffer.firstChunks[before]
      expect(looksLikeProxyTraffic(chunk), `${key}: esperado ${what}, recebido ${JSON.stringify(chunk.subarray(0, 40).toString('latin1'))}`).toBe(true)
    }
  })

  it('AC-T04-03 sem proxyUrl nenhum agente é passado (agent e fetchAgent ausentes)', async () => {
    const { factory } = await startTransport()
    const config = factory.lastConfig
    expect(config, 'factory de socket chamada sem config').toBeTruthy()
    expect(config.agent).toBeUndefined()
    expect(config.fetchAgent).toBeUndefined()
  })

  it('AC-T04-03 BaileysTransport repassa o auth state ao socket', async () => {
    const { factory } = await startTransport()
    expect(factory.lastConfig?.auth).toBeTruthy()
  })
})
