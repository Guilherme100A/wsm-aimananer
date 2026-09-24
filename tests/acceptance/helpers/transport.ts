// Helpers para testar a camada de transporte (T04) sem WhatsApp real e sem rede.
import { EventEmitter } from 'node:events'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import tls from 'node:tls'
import { vi } from 'vitest'

/** Carrega os exports públicos do transporte a partir do pacote @wsm/core. */
export async function loadTransport() {
  const core: Record<string, any> = await import('@wsm/core')
  const { FakeTransport, BaileysTransport } = core
  if (typeof FakeTransport !== 'function') throw new Error('@wsm/core não exporta FakeTransport')
  if (typeof BaileysTransport !== 'function') throw new Error('@wsm/core não exporta BaileysTransport')
  return { FakeTransport, BaileysTransport } as { FakeTransport: new (...a: any[]) => any; BaileysTransport: new (...a: any[]) => any }
}

/** AuthenticationState mínimo (o socket é falso, o conteúdo não é usado). */
export const fakeAuthState = () => ({
  creds: { me: undefined, registered: false } as Record<string, unknown>,
  keys: { get: async () => ({}), set: async () => {} },
})

/** Erro no formato Boom que o Baileys coloca em `lastDisconnect.error`. */
export function boomError(statusCode: number, message = 'Connection Failure') {
  return Object.assign(new Error(message), {
    isBoom: true,
    output: { statusCode, payload: { statusCode, error: message, message }, headers: {} },
    data: undefined,
  })
}

/**
 * Socket falso compatível com o que o Baileys devolve em `makeWASocket(config)`:
 * `ev.on/off/process`, `ws`, `sendMessage`, `logout`, `end`, `requestPairingCode`…
 */
export function createFakeBaileysSocket(config: any) {
  const emitter = new EventEmitter()
  const processors: Array<(events: Record<string, unknown>) => unknown> = []
  const ev = {
    on: (event: string, cb: (...a: any[]) => void) => void emitter.on(event, cb),
    off: (event: string, cb: (...a: any[]) => void) => void emitter.off(event, cb),
    removeAllListeners: (event?: string) => void emitter.removeAllListeners(event),
    process: (handler: (events: Record<string, unknown>) => unknown) => {
      processors.push(handler)
      return () => processors.splice(processors.indexOf(handler), 1)
    },
    emit: (event: string, data: unknown) => emitter.emit(event, data),
    buffer: () => {},
    flush: () => true,
    isBuffering: () => false,
    createBufferedFunction: (fn: any) => fn,
  }
  const known: Record<string, any> = {
    config,
    type: 'md',
    ev,
    ws: Object.assign(new EventEmitter(), { close: vi.fn(async () => {}), isOpen: false, isClosed: true }),
    authState: config?.auth,
    user: undefined,
    sendMessage: vi.fn(async () => ({ key: { id: `FAKE${Math.random().toString(36).slice(2)}`, fromMe: true } })),
    groupFetchAllParticipating: vi.fn(async () => ({})),
    requestPairingCode: vi.fn(async () => 'ABCD1234'),
    logout: vi.fn(async () => {}),
    end: vi.fn(() => {}),
    waitForConnectionUpdate: vi.fn(async () => {}),
  }
  const sock = new Proxy(known, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined
      // Qualquer outro método do socket vira um no-op assíncrono.
      target[prop] = vi.fn(async () => undefined)
      return target[prop]
    },
  })
  /** Dispara um evento do Baileys para `ev.on` e `ev.process`. */
  const emit = (event: string, data: unknown) => {
    emitter.emit(event, data)
    for (const p of [...processors]) void p({ [event]: data })
  }
  return { sock, emit }
}

export type FakeBaileys = ReturnType<typeof createFakeBaileysSocket>

/**
 * Factory falsa de `makeWASocket`. Guarda a config recebida e o socket devolvido.
 * `transportOptions()` são as opções de construtor do BaileysTransport para injetá-la.
 */
export function fakeSocketFactory() {
  const sockets: FakeBaileys[] = []
  const makeSocket = vi.fn((config: any) => {
    const s = createFakeBaileysSocket(config)
    sockets.push(s)
    return s.sock
  })
  return {
    makeSocket,
    sockets,
    get lastConfig() {
      return makeSocket.mock.calls.at(-1)?.[0]
    },
    /** Nome contratado: `makeSocket`; aliases aceitos para a mesma injeção. */
    transportOptions: (extra: Record<string, unknown> = {}) => ({
      makeSocket,
      makeWASocket: makeSocket,
      socketFactory: makeSocket,
      createSocket: makeSocket,
      ...extra,
    }),
  }
}

/** Espera até `predicate()` ser verdadeiro. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000, what = 'condição') {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout esperando ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * Servidor TCP local que só registra o primeiro pacote de cada conexão e a fecha.
 * Serve para provar que um agente roteia pelo proxy (CONNECT http, TLS ClientHello, SOCKS5).
 */
export async function startProxySniffer() {
  const firstChunks: Buffer[] = []
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      firstChunks.push(chunk)
      socket.destroy()
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    firstChunks,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * Faz uma requisição HTTPS usando `agent` para um IP de documentação (TEST-NET-1).
 * O destino nunca é contatado: o agente de proxy abre a conexão com o proxy local.
 */
export function requestThroughAgent(agent: unknown) {
  const req = https.request({ host: '192.0.2.1', port: 443, path: '/', method: 'GET', agent: agent as https.Agent, timeout: 3_000 })
  req.on('error', () => {})
  req.on('timeout', () => req.destroy())
  req.end()
  return req
}

/**
 * O sniffer derruba a conexão de propósito; agentes de proxy com TLS (https-proxy-agent) deixam
 * o erro do socket ao proxy sem listener. Enquanto ativo, sockets TLS criados ganham um listener
 * de erro no-op, evitando "Uncaught Exception" que não pertence ao produto.
 */
export function swallowProxySocketErrors() {
  const original = tls.connect
  ;(tls as any).connect = function (...args: any[]) {
    const socket = (original as any).apply(this, args) as tls.TLSSocket
    socket.on('error', () => {})
    return socket
  }
  syncBuiltinESMExports() // reflete o patch em quem importou tls como módulo ESM
  return {
    restore: () => {
      ;(tls as any).connect = original
      syncBuiltinESMExports()
    },
  }
}

const LOOPBACK =/^(127\.|::1$|localhost$|::ffff:127\.)/

/**
 * Bloqueia conexões TCP para fora do loopback durante o teste (garantia de "sem rede").
 * Devolve as tentativas bloqueadas e uma função para restaurar.
 */
export function blockExternalNetwork() {
  const blocked: string[] = []
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const first = args[0]
    const opts = Array.isArray(first) ? first[0] : first
    const host = typeof opts === 'object' && opts ? (opts.host ?? opts.path ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost'
    if (typeof opts === 'object' && opts?.path) return (original as any).apply(this, args) // pipe/IPC local
    if (!LOOPBACK.test(String(host))) {
      blocked.push(String(host))
      process.nextTick(() => this.destroy(new Error(`rede externa bloqueada no teste: ${host}`)))
      return this
    }
    return (original as any).apply(this, args)
  } as typeof original
  return {
    blocked,
    restore: () => {
      net.Socket.prototype.connect = original
    },
  }
}

/** Conta todas as conexões TCP abertas (qualquer destino) enquanto ativo. */
export function countSocketConnects() {
  const hosts: string[] = []
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const opts = Array.isArray(args[0]) ? args[0][0] : args[0]
    hosts.push(typeof opts === 'object' && opts ? String(opts.host ?? opts.path ?? '?') : String(args[1] ?? opts))
    return (original as any).apply(this, args)
  } as typeof original
  return {
    hosts,
    restore: () => {
      net.Socket.prototype.connect = original
    },
  }
}
