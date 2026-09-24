// T11 — eventos alertáveis (AC-T11-01) e formatação das mensagens.
import { createHmac } from 'node:crypto'

export const ALERT_EVENTS = [
  'forbidden_403',
  'disconnected',
  'error_burst',
  'proxy_unavailable',
  'warmup_paused',
  'health_degraded',
] as const

export type AlertEventType = (typeof ALERT_EVENTS)[number]

export interface AlertEvent {
  type: AlertEventType
  sessionId: string | null
  at: Date
  detail?: Record<string, unknown>
}

export function isAlertEventType(value: unknown): value is AlertEventType {
  return typeof value === 'string' && (ALERT_EVENTS as readonly string[]).includes(value)
}

const DESCRIPTIONS: Record<AlertEventType, string> = {
  forbidden_403: 'WhatsApp respondeu 403 (forbidden): sessão pausada',
  disconnected: 'sessão desconectada',
  error_burst: 'pico de erros de envio/conexão',
  proxy_unavailable: 'proxy indisponível',
  warmup_paused: 'sessão pausada durante o warm-up',
  health_degraded: 'Health Score em alerta',
}

/** Corpo JSON do webhook HTTP genérico: exatamente `{ event, sessionId, at, detail }`. */
export function alertBody(event: AlertEvent): string {
  return JSON.stringify({ event: event.type, sessionId: event.sessionId, at: event.at.toISOString(), detail: event.detail ?? {} })
}

/** Texto curto (Discord, Telegram, email). */
export function formatAlertText(event: AlertEvent): string {
  const lines = [`[WSM] ${event.type}: ${DESCRIPTIONS[event.type]}`, `session: ${event.sessionId ?? '-'}`, `at: ${event.at.toISOString()}`]
  if (event.detail && Object.keys(event.detail).length > 0) lines.push(`detail: ${JSON.stringify(event.detail)}`)
  return lines.join('\n')
}

export function alertSubject(event: AlertEvent): string {
  return `[WSM] ${event.type}`
}

/** HMAC-SHA256 (hex minúsculo) do body cru com o segredo do webhook — header `x-wsm-signature` (AC-T11-03). */
export function signWebhookBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

/** Alias de `signWebhookBody`. */
export const signPayload = signWebhookBody

export const SIGNATURE_HEADER = 'x-wsm-signature'
