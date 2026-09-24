// BaileysTransport: adaptador do @whiskeysockets/baileys para WaTransport.
// O socket é criado por uma factory injetável, para testes sem rede (AC-T04-02/03).
import type { Agent } from 'node:https'
import type { UserFacingSocketConfig } from '@whiskeysockets/baileys'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { TransportEmitter } from './emitter'
import {
  TransportNotConnectedError,
  type ConnectOptions,
  type DisconnectKind,
  type GroupSummary,
  type IncomingMessage,
  type OutgoingContent,
  type WaTransport,
} from './types'

/** Códigos do `DisconnectReason` do Baileys usados no mapeamento. */
export const BAILEYS_DISCONNECT = { loggedOut: 401, forbidden: 403 } as const

/** Status de `proto.WebMessageInfo.Status` usados nos recibos. */
const MESSAGE_STATUS = { DELIVERY_ACK: 3, READ: 4, PLAYED: 5 } as const

/** AC-T04-02: loggedOut (401) → loggedOut, 403 → forbidden, o resto → transient. */
export function mapDisconnectReason(statusCode: number | undefined): DisconnectKind {
  if (statusCode === BAILEYS_DISCONNECT.loggedOut) return 'loggedOut'
  if (statusCode === BAILEYS_DISCONNECT.forbidden) return 'forbidden'
  return 'transient'
}

/** Extrai o statusCode de um erro Boom (`error.output.statusCode`) do Baileys. */
export function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const output = (error as { output?: { statusCode?: unknown } }).output
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined
}

export class UnsupportedProxyError extends Error {
  constructor(proxyUrl: string) {
    super(`protocolo de proxy não suportado: ${redactProxyUrl(proxyUrl)} (use http, https ou socks5)`)
    this.name = 'UnsupportedProxyError'
  }
}

/** Remove usuário/senha da URL do proxy para uso em mensagens e logs. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    if (url.username || url.password) {
      url.username = '***'
      url.password = ''
    }
    return url.toString()
  } catch {
    return '<proxy inválido>'
  }
}

/** AC-T04-03: cria o agente para http/https (CONNECT) ou socks5. */
export function createProxyAgent(proxyUrl: string): Agent {
  let protocol: string
  try {
    protocol = new URL(proxyUrl).protocol
  } catch {
    throw new UnsupportedProxyError(proxyUrl)
  }
  switch (protocol) {
    case 'http:':
    case 'https:':
      return new HttpsProxyAgent(proxyUrl)
    case 'socks5:':
    case 'socks5h:':
      return new SocksProxyAgent(proxyUrl)
    default:
      throw new UnsupportedProxyError(proxyUrl)
  }
}

type EventHandler = (payload: unknown) => void

/** Subconjunto do socket do Baileys usado pelo transporte (facilita mocks). */
export interface BaileysSocketLike {
  ev: { on(event: string, listener: EventHandler): void }
  sendMessage(jid: string, content: Record<string, unknown>): Promise<{ key?: { id?: string | null } } | undefined>
  groupFetchAllParticipating(): Promise<Record<string, BaileysGroupLike>>
  requestPairingCode(phoneNumber: string): Promise<string>
  logout(msg?: string): Promise<void>
  end(error: Error | undefined): void | Promise<void>
}

export interface BaileysGroupLike {
  id: string
  subject?: string
  size?: number
  participants?: unknown[]
  announce?: boolean
  linkedParent?: string
}

export type BaileysSocketConfig = UserFacingSocketConfig
export type BaileysSocketFactory = (config: BaileysSocketConfig) => BaileysSocketLike

export interface BaileysTransportOptions {
  /** Factory do socket; default: `makeWASocket` do Baileys (carregado sob demanda). */
  makeSocket?: BaileysSocketFactory
  /** Opções extras repassadas ao `makeWASocket` (ex.: logger, browser). */
  socketConfig?: Partial<Omit<BaileysSocketConfig, 'auth' | 'agent' | 'fetchAgent'>>
}

async function defaultSocketFactory(): Promise<BaileysSocketFactory> {
  const mod = await import('@whiskeysockets/baileys')
  return mod.makeWASocket as unknown as BaileysSocketFactory
}

interface RawMessage {
  key?: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null }
  message?: Record<string, unknown> | null
  messageTimestamp?: number | { toNumber(): number } | null
  pushName?: string | null
}

const IGNORED_CONTENT_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

/** Converte uma `WAMessage` do Baileys em `IncomingMessage`; devolve `undefined` se não houver conteúdo. */
export function toIncomingMessage(raw: RawMessage): IncomingMessage | undefined {
  const id = raw.key?.id
  const from = raw.key?.remoteJid
  const content = raw.message
  if (!id || !from || !content) return undefined
  const type = Object.keys(content).find((k) => !IGNORED_CONTENT_KEYS.has(k) && content[k] != null)
  if (!type) return undefined

  const body = content[type]
  let text: string | undefined
  if (typeof body === 'string') text = body
  else if (body && typeof body === 'object') {
    const b = body as { text?: unknown; caption?: unknown }
    if (typeof b.text === 'string') text = b.text
    else if (typeof b.caption === 'string') text = b.caption
  }

  const ts = raw.messageTimestamp
  const seconds = typeof ts === 'number' ? ts : ts ? ts.toNumber() : undefined

  const msg: IncomingMessage = {
    id,
    from,
    fromMe: raw.key?.fromMe === true,
    timestamp: seconds !== undefined ? seconds * 1000 : Date.now(),
    type,
  }
  if (raw.key?.participant) msg.participant = raw.key.participant
  if (raw.pushName) msg.pushName = raw.pushName
  if (text !== undefined) msg.text = text
  return msg
}

function toGroupSummary(g: BaileysGroupLike): GroupSummary {
  const summary: GroupSummary = {
    id: g.id,
    name: g.subject ?? '',
    participants: g.size ?? g.participants?.length ?? 0,
    announce: g.announce === true,
  }
  if (g.linkedParent) summary.communityId = g.linkedParent
  return summary
}

export class BaileysTransport extends TransportEmitter implements WaTransport {
  private sock: BaileysSocketLike | undefined
  private connected = false

  constructor(private readonly options: BaileysTransportOptions = {}) {
    super()
  }

  get isConnected(): boolean {
    return this.connected
  }

  async connect(opts: ConnectOptions): Promise<void> {
    if (this.sock) await this.close()

    const config: BaileysSocketConfig = { ...this.options.socketConfig, auth: opts.auth }
    if (opts.proxyUrl) {
      const agent = createProxyAgent(opts.proxyUrl)
      config.agent = agent
      config.fetchAgent = agent
    }

    const factory = this.options.makeSocket ?? (await defaultSocketFactory())
    const sock = factory(config)
    this.sock = sock
    let pairingRequested = false

    // Eventos de um socket substituído/encerrado são ignorados.
    const guard =
      <T>(fn: (payload: T) => void | Promise<void>): EventHandler =>
      (payload) => {
        if (this.sock !== sock) return
        void Promise.resolve(fn(payload as T)).catch((err) => this.onListenerError(err, 'connection'))
      }

    sock.ev.on(
      'connection.update',
      guard<{ connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }>(async (u) => {
        if (u.qr) {
          if (opts.pairingPhone && !opts.auth.creds.registered) {
            if (!pairingRequested) {
              pairingRequested = true
              const code = await sock.requestPairingCode(opts.pairingPhone.replace(/\D/g, ''))
              if (this.sock === sock) this.emit('pairing-code', code)
            }
          } else {
            this.emit('qr', u.qr)
          }
        }
        if (u.connection === 'open') {
          this.connected = true
          this.emit('connection', { state: 'open' })
        } else if (u.connection === 'close') {
          this.connected = false
          this.sock = undefined
          const statusCode = disconnectStatusCode(u.lastDisconnect?.error)
          const reason = mapDisconnectReason(statusCode)
          this.emit('connection', statusCode === undefined ? { state: 'close', reason } : { state: 'close', reason, statusCode })
        }
      }),
    )

    if (opts.saveCreds) {
      const save = opts.saveCreds
      sock.ev.on('creds.update', guard(() => save()))
    }

    sock.ev.on(
      'messages.upsert',
      guard<{ messages?: RawMessage[]; type?: string }>((u) => {
        if (u.type !== 'notify') return
        for (const raw of u.messages ?? []) {
          const msg = toIncomingMessage(raw)
          if (msg) this.emit('message', msg)
        }
      }),
    )

    sock.ev.on(
      'messages.update',
      guard<Array<{ key?: { id?: string | null; fromMe?: boolean | null }; update?: { status?: number | null } }>>(
        (updates) => {
          for (const { key, update } of updates) {
            if (!key?.id || !key.fromMe) continue
            const s = update?.status
            if (s === MESSAGE_STATUS.DELIVERY_ACK) this.emit('receipt', { messageId: key.id, status: 'delivered' })
            else if (s === MESSAGE_STATUS.READ || s === MESSAGE_STATUS.PLAYED)
              this.emit('receipt', { messageId: key.id, status: 'read' })
          }
        },
      ),
    )
  }

  private requireSocket(): BaileysSocketLike {
    if (!this.sock || !this.connected) throw new TransportNotConnectedError()
    return this.sock
  }

  async sendMessage(to: string, content: OutgoingContent): Promise<{ messageId: string }> {
    const sock = this.requireSocket()
    const result = await sock.sendMessage(to, content as Record<string, unknown>)
    const messageId = result?.key?.id
    if (!messageId) throw new Error('Baileys não devolveu o ID da mensagem enviada')
    return { messageId }
  }

  async fetchGroups(): Promise<GroupSummary[]> {
    const groups = await this.requireSocket().groupFetchAllParticipating()
    return Object.values(groups).map(toGroupSummary)
  }

  /** Desloga o dispositivo; o Baileys emite `connection` close com reason `loggedOut`. */
  async logout(): Promise<void> {
    const sock = this.sock
    if (!sock) throw new TransportNotConnectedError()
    await sock.logout()
  }

  /** Encerra o socket localmente, sem deslogar e sem emitir eventos. */
  async close(): Promise<void> {
    const sock = this.sock
    this.sock = undefined
    this.connected = false
    if (sock) await sock.end(undefined)
  }
}
