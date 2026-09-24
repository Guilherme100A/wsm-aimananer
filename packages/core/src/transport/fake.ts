// FakeTransport: transporte em memória para testes (AC-T04-01). Nunca abre rede.
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

export interface FakeSentMessage {
  messageId: string
  to: string
  content: OutgoingContent
  at: Date
}

export type FakeIncomingInput = Partial<IncomingMessage> & { from: string }

export class FakeTransport extends TransportEmitter implements WaTransport {
  /** Envios bem-sucedidos, em ordem. */
  readonly sent: FakeSentMessage[] = []
  /** Opções de cada chamada a `connect`. */
  readonly connectCalls: ConnectOptions[] = []
  /** Grupos devolvidos por `fetchGroups`. */
  groups: GroupSummary[] = []

  connected = false
  loggedOut = false
  closed = false

  private readonly sendFailures: Error[] = []
  private seq = 0

  get lastConnect(): ConnectOptions | undefined {
    return this.connectCalls.at(-1)
  }

  async connect(opts: ConnectOptions): Promise<void> {
    this.connectCalls.push(opts)
    this.closed = false
    this.loggedOut = false
  }

  // ---- helpers de simulação -------------------------------------------------

  emitQr(qr = `fake-qr-${++this.seq}`): void {
    this.emit('qr', qr)
  }

  emitPairingCode(code = 'FAKE1234'): void {
    this.emit('pairing-code', code)
  }

  /** Simula conexão aberta. */
  open(): void {
    this.connected = true
    this.emit('connection', { state: 'open' })
  }

  /**
   * Com `reason`: simula queda da conexão vinda do WhatsApp (emite `connection` close).
   * Sem argumentos: é o `close()` da interface (encerramento local, sem evento).
   */
  async close(reason?: DisconnectKind, statusCode?: number): Promise<void> {
    this.connected = false
    if (reason === undefined) {
      this.closed = true
      return
    }
    if (reason === 'loggedOut') this.loggedOut = true
    this.emit('connection', statusCode === undefined ? { state: 'close', reason } : { state: 'close', reason, statusCode })
  }

  /** Simula mensagem recebida; campos ausentes recebem defaults. Devolve a mensagem emitida. */
  receive(msg: FakeIncomingInput): IncomingMessage {
    const full: IncomingMessage = {
      id: `FAKE-IN-${++this.seq}`,
      fromMe: false,
      timestamp: Date.now(),
      type: 'conversation',
      ...msg,
    }
    this.emit('message', full)
    return full
  }

  receipt(messageId: string, status: 'delivered' | 'read'): void {
    this.emit('receipt', { messageId, status })
  }

  /** O próximo `sendMessage` rejeita com `err` (uma vez por chamada). */
  failNextSend(err: Error = new Error('fake send failure')): void {
    this.sendFailures.push(err)
  }

  setGroups(groups: GroupSummary[]): void {
    this.groups = groups
  }

  // ---- WaTransport ------------------------------------------------------------

  async sendMessage(to: string, content: OutgoingContent): Promise<{ messageId: string }> {
    const failure = this.sendFailures.shift()
    if (failure) throw failure
    if (!this.connected) throw new TransportNotConnectedError()
    const messageId = `FAKE-OUT-${++this.seq}`
    this.sent.push({ messageId, to, content, at: new Date() })
    return { messageId }
  }

  async fetchGroups(): Promise<GroupSummary[]> {
    if (!this.connected) throw new TransportNotConnectedError()
    return this.groups.map((g) => ({ ...g }))
  }

  async logout(): Promise<void> {
    await this.close('loggedOut', 401)
  }
}
