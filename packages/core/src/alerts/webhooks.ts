// T11 — CRUD da tabela `webhooks` (AC-T11-02). O segredo é gravado cifrado e nunca sai na visão pública.
import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { WEBHOOK_CHANNELS, webhooks, type Database, type WebhookChannel } from '@wsm/db'
import { isAlertEventType, type AlertEventType } from './events'
import { decryptWebhookSecret, encryptWebhookSecret } from './secret'

export type WebhookRow = typeof webhooks.$inferSelect
export { WEBHOOK_CHANNELS, type WebhookChannel }

/** Visão pública: sem o segredo (só `hasSecret`); senha em URL mascarada. */
export interface WebhookView {
  id: string
  name: string
  channel: WebhookChannel
  url: string
  config: Record<string, unknown>
  events: AlertEventType[]
  enabled: boolean
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

/** Webhook pronto para entrega (segredo decifrado; só usar em memória). */
export interface ResolvedWebhook {
  id: string
  name: string
  channel: WebhookChannel
  url: string
  config: Record<string, unknown>
  events: AlertEventType[]
  enabled: boolean
  secret: string | null
}

export interface CreateWebhookInput {
  name: string
  channel: WebhookChannel
  url: string
  secret?: string | null
  config?: Record<string, unknown>
  events?: string[]
  enabled?: boolean
}

export type UpdateWebhookInput = Partial<CreateWebhookInput>

export type WebhookErrorCode = 'WEBHOOK_NOT_FOUND' | 'VALIDATION_ERROR'

export class WebhookError extends Error {
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message)
    this.name = 'WebhookError'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Mascara a senha de uma URL (`smtp://user:***@host`). URLs inválidas voltam como estão. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url)
    if (!u.password) return url
    u.password = '***'
    return u.toString()
  } catch {
    return url
  }
}

export function toWebhookView(row: WebhookRow): WebhookView {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    url: maskUrl(row.url),
    config: (row.config ?? {}) as Record<string, unknown>,
    events: row.events.filter(isAlertEventType),
    enabled: row.enabled,
    hasSecret: row.secret != null && row.secret !== '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function resolveWebhook(row: WebhookRow): ResolvedWebhook {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    url: row.url,
    config: (row.config ?? {}) as Record<string, unknown>,
    events: row.events.filter(isAlertEventType),
    enabled: row.enabled,
    secret: row.secret ? decryptWebhookSecret(row.id, row.secret) : null,
  }
}

/** Regras por canal: http e telegram exigem segredo; telegram exige config.chatId; email exige config.to. */
export function validateWebhook(w: { channel: WebhookChannel; url: string; config: Record<string, unknown>; hasSecret: boolean; events: string[] }): void {
  if (!(WEBHOOK_CHANNELS as readonly string[]).includes(w.channel)) throw new WebhookError('VALIDATION_ERROR', `invalid channel ${w.channel}`, 'channel')
  for (const e of w.events) if (!isAlertEventType(e)) throw new WebhookError('VALIDATION_ERROR', `unknown alert event ${e}`, 'events')
  if (w.channel !== 'email' || w.url !== '') {
    let u: URL
    try {
      u = new URL(w.url)
    } catch {
      throw new WebhookError('VALIDATION_ERROR', 'url must be a valid URL', 'url')
    }
    const allowed = w.channel === 'email' ? ['smtp:', 'smtps:'] : ['http:', 'https:']
    if (!allowed.includes(u.protocol)) throw new WebhookError('VALIDATION_ERROR', `url protocol must be ${allowed.join(' or ')}`, 'url')
  }
  if ((w.channel === 'http' || w.channel === 'telegram') && !w.hasSecret) {
    throw new WebhookError('VALIDATION_ERROR', `secret is required for channel ${w.channel}`, 'secret')
  }
  if (w.channel === 'telegram' && !isNonEmpty(w.config.chatId)) throw new WebhookError('VALIDATION_ERROR', 'config.chatId is required for telegram', 'config.chatId')
  if (w.channel === 'email' && !isNonEmpty(w.config.to)) throw new WebhookError('VALIDATION_ERROR', 'config.to is required for email', 'config.to')
}

const isNonEmpty = (v: unknown) => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number'

export class WebhookService {
  constructor(readonly db: Database) {}

  async list(): Promise<WebhookView[]> {
    return (await this.db.select().from(webhooks).orderBy(desc(webhooks.createdAt))).map(toWebhookView)
  }

  async find(id: string): Promise<WebhookRow | undefined> {
    if (!UUID_RE.test(id)) return undefined
    const [row] = await this.db.select().from(webhooks).where(eq(webhooks.id, id))
    return row
  }

  async getRow(id: string): Promise<WebhookRow> {
    const row = await this.find(id)
    if (!row) throw new WebhookError('WEBHOOK_NOT_FOUND', `webhook ${id} not found`)
    return row
  }

  async get(id: string): Promise<WebhookView> {
    return toWebhookView(await this.getRow(id))
  }

  /** Webhooks habilitados que assinam `event` (lista vazia = todos), com segredo decifrado. */
  async listForEvent(event: AlertEventType): Promise<ResolvedWebhook[]> {
    const rows = await this.db.select().from(webhooks).where(eq(webhooks.enabled, true)).orderBy(webhooks.createdAt)
    return rows.filter((r) => r.events.length === 0 || r.events.includes(event)).map(resolveWebhook)
  }

  async create(input: CreateWebhookInput): Promise<WebhookView> {
    const config = input.config ?? {}
    const events = input.events ?? []
    const secret = input.secret ?? null
    validateWebhook({ channel: input.channel, url: input.url, config, events, hasSecret: !!secret })
    const id = randomUUID()
    const [row] = await this.db
      .insert(webhooks)
      .values({
        id,
        name: input.name,
        channel: input.channel,
        url: input.url,
        secret: secret ? encryptWebhookSecret(id, secret) : null,
        config,
        events,
        enabled: input.enabled ?? true,
      })
      .returning()
    return toWebhookView(row!)
  }

  /** Atualização parcial. `secret: null` remove o segredo; ausente mantém. */
  async update(id: string, input: UpdateWebhookInput): Promise<WebhookView> {
    const current = await this.getRow(id)
    const next = {
      channel: input.channel ?? current.channel,
      url: input.url ?? current.url,
      config: input.config ?? ((current.config ?? {}) as Record<string, unknown>),
      events: input.events ?? current.events,
    }
    const secretCol = input.secret === undefined ? current.secret : input.secret ? encryptWebhookSecret(id, input.secret) : null
    validateWebhook({ ...next, hasSecret: !!secretCol })
    const [row] = await this.db
      .update(webhooks)
      .set({
        ...next,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        secret: secretCol,
        updatedAt: new Date(),
      })
      .where(eq(webhooks.id, id))
      .returning()
    if (!row) throw new WebhookError('WEBHOOK_NOT_FOUND', `webhook ${id} not found`)
    return toWebhookView(row)
  }

  async remove(id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw new WebhookError('WEBHOOK_NOT_FOUND', `webhook ${id} not found`)
    const deleted = await this.db.delete(webhooks).where(eq(webhooks.id, id)).returning({ id: webhooks.id })
    if (deleted.length === 0) throw new WebhookError('WEBHOOK_NOT_FOUND', `webhook ${id} not found`)
  }
}
