// /api/messages (T08): consulta e cancelamento de mensagens da fila.
// O enfileiramento via HTTP (POST /api/sessions/:id/messages) é do pipeline do T09.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { MESSAGE_STATUSES } from '@wsm/db'
import {
  MessageNotFoundError,
  MessageStore,
  MessageTransitionError,
  toMessageEventView,
  toMessageView,
  type MessagesControl,
} from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

declare module '../types' {
  interface AppDeps {
    /** MessageQueue do worker (T08). Opcional: sem ela, as rotas operam direto no banco. */
    messages?: MessagesControl
  }
}

/** Implementação só com o banco: o cancelamento vale porque o processador ignora mensagens fora de queued/retrying. */
export function dbOnlyMessages(store: MessageStore): MessagesControl {
  return {
    get: async (id) => toMessageView(await store.get(id)),
    list: async (filter) => (await store.list(filter)).map(toMessageView),
    events: async (id) => {
      await store.get(id)
      return (await store.events(id)).map(toMessageEventView)
    },
    cancel: async (id) => toMessageView((await store.cancel(id)).row),
  }
}

export const listMessagesQuery = z.object({
  sessionId: z.uuid().optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

function toApiError(err: unknown): unknown {
  if (err instanceof MessageNotFoundError) return new ApiError('NOT_FOUND', err.message)
  if (err instanceof MessageTransitionError) return new ApiError('INVALID_TRANSITION', err.message, { from: err.from, to: err.to })
  return err
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

const id = (c: Context<AppEnv>) => c.req.param('id') ?? ''

export function messagesRoutes(deps: Pick<AppDeps, 'db' | 'messages'>) {
  const messages = deps.messages ?? dbOnlyMessages(new MessageStore(deps.db))

  return new Hono<AppEnv>()
    .get('/api/messages', validate('query', listMessagesQuery), async (c) => {
      const q = c.req.valid('query')
      return c.json({ items: await run(() => messages.list(q)) })
    })
    .get('/api/messages/:id', async (c) => c.json(await run(() => messages.get(id(c)))))
    .get('/api/messages/:id/events', async (c) => c.json({ items: await run(() => messages.events(id(c))) }))
    .post('/api/messages/:id/cancel', async (c) => {
      const message = await run(() => messages.cancel(id(c)))
      setAudit(c, { action: 'message.cancel', targetType: 'message', targetId: message.id, detail: { sessionId: message.sessionId } })
      return c.json(message)
    })
}
