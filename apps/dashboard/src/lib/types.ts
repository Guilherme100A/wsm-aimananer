// Formatos das respostas da API (espelham as views do @wsm/core; duplicados para não levar o core ao bundle).
export type SessionState = 'NEW' | 'WARMING' | 'STABLE' | 'DEGRADED' | 'PAUSED' | 'DISCONNECTED'
export type MessageStatus = 'queued' | 'processing' | 'sent' | 'delivered' | 'read' | 'failed' | 'retrying' | 'cancelled'
export type HealthLabel = 'Good' | 'Warning' | 'Critical'

export interface Session {
  id: string
  name: string
  phone: string
  status: SessionState
  state: SessionState
  proxyId: string | null
  note: string | null
  requiresRestart: boolean
  warmupStartedAt: string | null
  lastConnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SessionHealth {
  state: SessionState
  warmupPercent: number
  score: number
  label: HealthLabel
  sent: number
  received: number
  failed: number
  disconnects: number
  forbidden403: number
  lastEventAt: string | null
}

export interface QrInfo {
  qr: string | null
  generatedAt: string | null
}

export interface Message {
  id: string
  sessionId: string
  contactId: string | null
  phone: string
  content: unknown
  status: MessageStatus
  attempts: number
  lastError: string | null
  transportMessageId: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MessageEvent {
  id: number
  messageId: string
  from: MessageStatus | null
  to: MessageStatus
  detail: unknown
  createdAt: string
}

export interface Proxy {
  id: string
  name: string | null
  protocol: string
  host: string
  port: number
  username: string | null
  url: string
  available: boolean
  lastCheckAt: string | null
  lastError: string | null
  errorCount: number
  sessionId: string | null
}

export interface Contact {
  id: string
  name: string | null
  phone: string
  consent: boolean
  consent_at: string | null
  consent_source: string | null
  opt_out: boolean
  last_contact_at: string | null
  created_at: string
  updated_at: string
}

export interface ImportResult {
  imported: number
  rejected: Array<{ line: number; phone: string | null; reason: string; message: string }>
  contacts: Contact[]
}

export interface Group {
  id: string
  name: string
  participants: number
  status: string
  announce: boolean
  communityId: string | null
}

export type WebhookChannel = 'discord' | 'telegram' | 'email' | 'http'

export interface Webhook {
  id: string
  name: string
  channel: WebhookChannel
  url: string
  config: Record<string, unknown>
  events: string[]
  enabled: boolean
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export const ALERT_EVENTS = ['forbidden_403', 'disconnected', 'error_burst', 'proxy_unavailable', 'warmup_paused', 'health_degraded'] as const
