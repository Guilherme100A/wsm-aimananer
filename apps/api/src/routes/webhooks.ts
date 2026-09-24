// /api/webhooks (T11, AC-T11-02): CRUD dos canais de alerta. O segredo é aceito na escrita, gravado cifrado
// e nunca devolvido (só `hasSecret`).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { ALERT_EVENTS, AlertDispatcher, WebhookError, WebhookService, resolveWebhook, type AlertEvent, type DeliveryResult } from '@wsm/core'
import { WEBHOOK_CHANNELS } from '@wsm/db'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

/** Entrega de teste (default: AlertDispatcher sobre deps.db). */
export interface WebhookTester {
  deliver(webhook: ReturnType<typeof resolveWebhook>, event: AlertEvent): Promise<DeliveryResult>
}

declare module '../types' {
  interface AppDeps {
    /** Entregador usado por POST /api/webhooks/:id/test (T11). Default: AlertDispatcher(deps.db). */
    alertDelivery?: WebhookTester
  }
}

const name = z.string().trim().min(1).max(200)
const channel = z.enum(WEBHOOK_CHANNELS)
const url = z.string().trim().max(2000)
const secret = z.string().min(1).max(4096)
const config = z.record(z.string(), z.unknown())
const events = z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length)

export const createWebhookSchema = z.object({
  name,
  channel,
  url,
  secret: secret.nullable().optional(),
  config: config.optional(),
  events: events.optional(),
  enabled: z.boolean().optional(),
})

export const updateWebhookSchema = z
  .object({
    name: name.optional(),
    channel: channel.optional(),
    url: url.optional(),
    secret: secret.nullable().optional(),
    config: config.optional(),
    events: events.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' })

const uuid = z.uuid()

function webhookId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('NOT_FOUND', `webhook ${id} not found`)
  return id
}

function toApiError(err: unknown): unknown {
  if (!(err instanceof WebhookError)) return err
  if (err.code === 'WEBHOOK_NOT_FOUND') return new ApiError('NOT_FOUND', err.message)
  return new ApiError('VALIDATION_ERROR', err.message, { issues: [{ path: err.path ?? '', message: err.message, code: 'custom' }] })
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

export function webhooksRoutes(deps: Pick<AppDeps, 'db' | 'alertDelivery'>) {
  const service = new WebhookService(deps.db)
  let tester = deps.alertDelivery
  const getTester = () => (tester ??= new AlertDispatcher({ db: deps.db, maxAttempts: 1 }))

  return new Hono<AppEnv>()
    .get('/api/webhooks', async (c) => c.json({ items: await run(() => service.list()) }))
    .post('/api/webhooks', validate('json', createWebhookSchema), async (c) => {
      const w = await run(() => service.create(c.req.valid('json')))
      setAudit(c, { action: 'webhook.create', targetType: 'webhook', targetId: w.id, detail: { channel: w.channel } })
      return c.json(w, 201)
    })
    .get('/api/webhooks/:id', async (c) => c.json(await run(() => service.get(webhookId(c)))))
    .patch('/api/webhooks/:id', validate('json', updateWebhookSchema), async (c) => {
      const id = webhookId(c)
      const body = c.req.valid('json')
      const w = await run(() => service.update(id, body))
      setAudit(c, { action: 'webhook.update', targetType: 'webhook', targetId: id, detail: { fields: Object.keys(body) } })
      return c.json(w)
    })
    .delete('/api/webhooks/:id', async (c) => {
      const id = webhookId(c)
      await run(() => service.remove(id))
      setAudit(c, { action: 'webhook.delete', targetType: 'webhook', targetId: id })
      return c.body(null, 204)
    })
    .post('/api/webhooks/:id/test', async (c) => {
      const id = webhookId(c)
      const row = await run(() => service.getRow(id))
      const event: AlertEvent = { type: 'health_degraded', sessionId: null, at: new Date(), detail: { test: true } }
      const result = await getTester().deliver(resolveWebhook(row), event)
      setAudit(c, { action: 'webhook.test', targetType: 'webhook', targetId: id, detail: { ok: result.ok } })
      return c.json({ ok: result.ok, attempts: result.attempts, ...(result.error ? { error: result.error } : {}) })
    })
}
