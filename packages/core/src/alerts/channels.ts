// T11 — entrega de um alerta num canal (AC-T11-02/03). Uma tentativa; retries ficam no dispatcher.
// URLs base configuráveis (webhook.url / config.baseUrl / opções) para os testes apontarem para mocks locais.
import nodemailer from 'nodemailer'
import { alertBody, alertSubject, formatAlertText, SIGNATURE_HEADER, signWebhookBody, type AlertEvent } from './events'
import type { ResolvedWebhook } from './webhooks'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface MailTransportLike {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>
  close?(): void
}

export interface MailTransportOptions {
  url: string
  auth?: { user: string; pass: string }
  timeoutMs: number
}

export interface ChannelOptions {
  fetch: FetchLike
  timeoutMs: number
  /** Base da Bot API do Telegram quando o webhook não define uma. */
  telegramBaseUrl: string
  /** SMTP padrão (SMTP_URL) quando o webhook de email não define URL. */
  smtpUrl?: string
  createMailTransport: (opts: MailTransportOptions) => MailTransportLike
}

export const DEFAULT_TELEGRAM_BASE_URL = 'https://api.telegram.org'
export const DEFAULT_EMAIL_FROM = 'alerts@wsm.local'

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'DeliveryError'
  }
}

export function defaultMailTransport(opts: MailTransportOptions): MailTransportLike {
  return nodemailer.createTransport({
    url: opts.url,
    ...(opts.auth ? { auth: opts.auth } : {}),
    connectionTimeout: opts.timeoutMs,
    greetingTimeout: opts.timeoutMs,
    socketTimeout: opts.timeoutMs,
  })
}

async function post(fetch: FetchLike, url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  // Consome o corpo para liberar a conexão.
  await res.text().catch(() => '')
  if (!res.ok) throw new DeliveryError(`HTTP ${res.status}`, res.status)
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined)
const trimSlash = (u: string) => u.replace(/\/+$/, '')

/** Envia `event` pelo canal do webhook. Lança em qualquer falha (rede, timeout, status não-2xx). */
export async function sendToChannel(webhook: ResolvedWebhook, event: AlertEvent, opts: ChannelOptions): Promise<void> {
  switch (webhook.channel) {
    case 'http': {
      const body = alertBody(event)
      const headers: Record<string, string> = {}
      if (webhook.secret) headers[SIGNATURE_HEADER] = signWebhookBody(body, webhook.secret)
      return post(opts.fetch, webhook.url, body, headers, opts.timeoutMs)
    }
    case 'discord':
      return post(opts.fetch, webhook.url, JSON.stringify({ content: formatAlertText(event) }), {}, opts.timeoutMs)
    case 'telegram': {
      if (!webhook.secret) throw new DeliveryError('telegram webhook without bot token')
      const base = trimSlash(str(webhook.config.baseUrl) ?? (webhook.url || opts.telegramBaseUrl))
      const body = JSON.stringify({ chat_id: webhook.config.chatId, text: formatAlertText(event) })
      return post(opts.fetch, `${base}/bot${webhook.secret}/sendMessage`, body, {}, opts.timeoutMs)
    }
    case 'email': {
      const url = webhook.url || opts.smtpUrl
      if (!url) throw new DeliveryError('email webhook without SMTP url (set url or SMTP_URL)')
      const to = str(webhook.config.to)
      if (!to) throw new DeliveryError('email webhook without config.to')
      const user = str(webhook.config.user)
      const transport = opts.createMailTransport({
        url,
        ...(user && webhook.secret ? { auth: { user, pass: webhook.secret } } : {}),
        timeoutMs: opts.timeoutMs,
      })
      try {
        await transport.sendMail({ from: str(webhook.config.from) ?? DEFAULT_EMAIL_FROM, to, subject: alertSubject(event), text: formatAlertText(event) })
      } finally {
        transport.close?.()
      }
      return
    }
  }
}
