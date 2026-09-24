// T11 — AlertDispatcher: deduplicação (AC-T11-04), entrega em todos os webhooks assinantes e retries (AC-T11-05).
// `dispatch` nunca lança: falhas são logadas (sem segredos) e sinalizadas com o evento `delivery_failed`.
import { EventEmitter } from 'node:events'
import type { Database, WebhookChannel } from '@wsm/db'
import { defaultMailTransport, DEFAULT_TELEGRAM_BASE_URL, sendToChannel, type ChannelOptions, type FetchLike, type MailTransportLike, type MailTransportOptions } from './channels'
import { isAlertEventType, type AlertEvent, type AlertEventType } from './events'
import { WebhookService, type ResolvedWebhook } from './webhooks'

/** Logger mínimo (compatível com pino). */
export interface AlertLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface AlertInput {
  type: AlertEventType | string
  sessionId: string | null
  at?: Date
  detail?: Record<string, unknown>
}

export interface DeliveryResult {
  webhookId: string
  channel: WebhookChannel
  ok: boolean
  attempts: number
  error?: string
}

export interface DispatchResult {
  deduped: boolean
  deliveries: DeliveryResult[]
}

export interface DeliveryFailure {
  webhookId: string
  channel: WebhookChannel
  event: AlertEventType
  sessionId: string | null
  attempts: number
  error: string
}

export interface AlertDispatcherOptions {
  db: Database
  logger?: AlertLogger
  /** Relógio (injetável). */
  now?: () => Date
  /** Janela de deduplicação por (evento, sessão). Default: env ALERT_DEDUP_MS ou 10 min. */
  dedupMs?: number
  /** Tentativas por webhook, no total (1 envio + reenvios). Default 3. */
  maxAttempts?: number
  /** Espera antes da tentativa `attempt + 1` (attempt 1-based). Default 1000·2^(attempt-1). */
  backoff?: (attempt: number) => number
  sleep?: (ms: number) => Promise<void>
  /** Timeout de cada tentativa. Default 10s. */
  timeoutMs?: number
  fetch?: FetchLike
  /** Default https://api.telegram.org. */
  telegramBaseUrl?: string
  /** SMTP padrão para webhooks de email sem URL. Default env SMTP_URL. */
  smtpUrl?: string
  createMailTransport?: (opts: MailTransportOptions) => MailTransportLike
}

export const DEFAULT_ALERT_DEDUP_MS = 10 * 60 * 1000
export const DEFAULT_ALERT_MAX_ATTEMPTS = 3
export const DEFAULT_ALERT_TIMEOUT_MS = 10_000
export const defaultAlertBackoff = (attempt: number) => 1000 * 2 ** (attempt - 1)

const noopLogger: AlertLogger = { info() {}, warn() {}, error() {} }

export function dedupMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.ALERT_DEDUP_MS)
  return env.ALERT_DEDUP_MS && Number.isFinite(v) && v >= 0 ? v : DEFAULT_ALERT_DEDUP_MS
}

/** Chave de deduplicação: (evento, sessão); sem sessão, usa o proxy do detalhe. */
export function dedupKey(event: Pick<AlertEvent, 'type' | 'sessionId' | 'detail'>): string {
  const proxyId = event.detail?.proxyId
  const subject = event.sessionId ?? (typeof proxyId === 'string' ? `proxy:${proxyId}` : '-')
  return `${event.type}|${subject}`
}

export interface AlertDispatcherEvents {
  delivery_failed: [DeliveryFailure]
  dispatched: [{ event: AlertEvent; result: DispatchResult }]
}

export class AlertDispatcher extends EventEmitter<AlertDispatcherEvents> {
  readonly webhooks: WebhookService
  private readonly log: AlertLogger
  private readonly now: () => Date
  private readonly dedupMs: number
  private readonly maxAttempts: number
  private readonly backoff: (attempt: number) => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly channel: ChannelOptions
  private readonly lastSent = new Map<string, number>()

  constructor(opts: AlertDispatcherOptions) {
    super()
    this.webhooks = new WebhookService(opts.db)
    this.log = opts.logger ?? noopLogger
    this.now = opts.now ?? (() => new Date())
    this.dedupMs = opts.dedupMs ?? dedupMsFromEnv()
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_ALERT_MAX_ATTEMPTS)
    this.backoff = opts.backoff ?? defaultAlertBackoff
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    const smtpUrl = opts.smtpUrl ?? process.env.SMTP_URL
    this.channel = {
      fetch: opts.fetch ?? (globalThis.fetch as unknown as FetchLike),
      timeoutMs: opts.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS,
      telegramBaseUrl: opts.telegramBaseUrl ?? DEFAULT_TELEGRAM_BASE_URL,
      createMailTransport: opts.createMailTransport ?? defaultMailTransport,
      ...(smtpUrl ? { smtpUrl } : {}),
    }
  }

  /**
   * Entrega o alerta a todos os webhooks habilitados que o assinam. Resolve depois de todas as tentativas.
   * Nunca lança. Tipo fora de ALERT_EVENTS → nada é entregue.
   */
  async dispatch(input: AlertInput): Promise<DispatchResult> {
    try {
      if (!isAlertEventType(input.type)) {
        this.log.warn({ event: input.type }, 'ignoring unknown alert event')
        return { deduped: false, deliveries: [] }
      }
      const event: AlertEvent = { type: input.type, sessionId: input.sessionId ?? null, at: input.at ?? this.now() }
      if (input.detail) event.detail = input.detail
      const key = dedupKey(event)
      const nowMs = this.now().getTime()
      const last = this.lastSent.get(key)
      if (last !== undefined && nowMs - last < this.dedupMs) {
        this.log.info({ event: event.type, session_id: event.sessionId }, 'alert deduplicated')
        return { deduped: true, deliveries: [] }
      }
      this.lastSent.set(key, nowMs)
      this.pruneDedup(nowMs)
      const targets = await this.webhooks.listForEvent(event.type)
      const deliveries = await Promise.all(targets.map((w) => this.deliver(w, event)))
      const result = { deduped: false, deliveries }
      this.emit('dispatched', { event, result })
      return result
    } catch (err) {
      this.log.error({ event: input.type, session_id: input.sessionId, err: errMessage(err) }, 'alert dispatch failed')
      return { deduped: false, deliveries: [] }
    }
  }

  /** Entrega a um webhook com retries (sem dedup). Usado também pelo teste de webhook da API. */
  async deliver(webhook: ResolvedWebhook, event: AlertEvent): Promise<DeliveryResult> {
    let error = ''
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await sendToChannel(webhook, event, this.channel)
        this.log.info({ webhook_id: webhook.id, channel: webhook.channel, event: event.type, session_id: event.sessionId, attempt }, 'alert delivered')
        return { webhookId: webhook.id, channel: webhook.channel, ok: true, attempts: attempt }
      } catch (err) {
        error = sanitize(errMessage(err), webhook.secret)
        const last = attempt === this.maxAttempts
        const ctx = { webhook_id: webhook.id, channel: webhook.channel, event: event.type, session_id: event.sessionId, attempt, error }
        if (last) this.log.error(ctx, 'alert delivery failed; giving up')
        else {
          this.log.warn(ctx, 'alert delivery failed; retrying')
          try {
            await this.sleep(this.backoff(attempt))
          } catch {
            // sleep nunca deve impedir o próximo retry
          }
        }
      }
    }
    const failure: DeliveryFailure = {
      webhookId: webhook.id,
      channel: webhook.channel,
      event: event.type,
      sessionId: event.sessionId,
      attempts: this.maxAttempts,
      error,
    }
    try {
      this.emit('delivery_failed', failure)
    } catch (err) {
      this.log.error({ webhook_id: webhook.id, err: errMessage(err) }, 'delivery_failed listener threw')
    }
    return { webhookId: webhook.id, channel: webhook.channel, ok: false, attempts: this.maxAttempts, error }
  }

  /** Esquece a deduplicação (ex.: testes). */
  resetDedup(): void {
    this.lastSent.clear()
  }

  private pruneDedup(nowMs: number): void {
    if (this.lastSent.size < 1000) return
    for (const [k, at] of this.lastSent) if (nowMs - at >= this.dedupMs) this.lastSent.delete(k)
  }
}

export function createAlertDispatcher(opts: AlertDispatcherOptions): AlertDispatcher {
  return new AlertDispatcher(opts)
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message
  }
  return String(err)
}

/** Remove o segredo (token do bot, senha) de mensagens de erro antes de logar/devolver. */
function sanitize(message: string, secret: string | null): string {
  return secret ? message.split(secret).join('***') : message
}
