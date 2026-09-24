import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from './app'
import { ApiError } from './errors'
import { setAudit } from './middleware/audit'
import { captureLogger, fakeDb, fakeRedis } from './test-utils'
import { validate } from './validate'

const TOKEN = 'unit-token'
const auth = { authorization: `Bearer ${TOKEN}` }

function build(opts: { db?: Parameters<typeof fakeDb>[0]; redis?: Parameters<typeof fakeRedis>[0] } = {}) {
  const { db, audits } = fakeDb(opts.db)
  const { logger, lines } = captureLogger()
  const app = createApp({ db, redis: fakeRedis(opts.redis), logger, apiToken: TOKEN, healthTimeoutMs: 50 })
  // Rotas de teste registradas depois de createApp (como fazem os testes de aceitação).
  const schema = z.object({ name: z.string().min(1), port: z.number().int() })
  app.post('/api/items', validate('json', schema), (c) => c.json({ id: 'it-1', ...c.req.valid('json') }, 201))
  app.put('/api/items/:id', (c) => c.json({ ok: true }))
  app.delete('/api/items/:id/tags', (c) => {
    setAudit(c, { action: 'items.untag', targetType: 'item', targetId: c.req.param('id') })
    return c.body(null, 204)
  })
  app.post('/api/parse', async (c) => c.json(schema.parse(await c.req.json())))
  app.post('/api/fail', () => {
    throw new ApiError('PROXY_IN_USE', 'proxy busy')
  })
  app.post('/api/boom', () => {
    throw new Error('secret internals')
  })
  app.get('/api/ping', (c) => c.json({ pong: true }))
  return { app, audits, lines }
}

const json = (body: unknown, headers: Record<string, string> = auth) => ({
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('GET /health', () => {
  it('responde ok sem auth quando db e redis estão de pé', async () => {
    const { app } = build()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok', redis: 'ok' })
  })

  it('marca down em erro ou timeout sem pendurar', async () => {
    const { app } = build({ db: { hang: true }, redis: { up: false } })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'down', redis: 'down' })
  })
})

describe('auth /api/*', () => {
  it.each([
    ['sem header', {}],
    ['token errado', { authorization: 'Bearer nope' }],
    ['esquema errado', { authorization: `Basic ${TOKEN}` }],
  ])('401 UNAUTHORIZED: %s', async (_n, headers) => {
    const { app } = build()
    const res = await app.request('/api/ping', { headers })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(typeof body.error.message).toBe('string')
  })

  it('401 também para rota /api inexistente', async () => {
    const { app } = build()
    expect((await app.request('/api/nao-existe')).status).toBe(401)
  })

  it('aceita o token correto', async () => {
    const { app } = build()
    const res = await app.request('/api/ping', { headers: auth })
    expect(res.status).toBe(200)
  })
})

describe('erros e validação', () => {
  it('body inválido → 400 VALIDATION_ERROR com o campo em details', async () => {
    const { app } = build()
    const res = await app.request('/api/items', json({ name: '', port: 'x' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues.map((i) => i.path).sort()).toEqual(['name', 'port'])
  })

  it('ZodError lançado no handler → 400 VALIDATION_ERROR', async () => {
    const { app } = build()
    const res = await app.request('/api/parse', json({ name: 'a' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0]?.path).toBe('port')
  })

  it('JSON malformado → 400 VALIDATION_ERROR', async () => {
    for (const path of ['/api/items', '/api/parse']) {
      const { app } = build()
      const res = await app.request(path, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{nope',
      })
      expect(res.status, path).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('ApiError usa o status da tabela 3.4', async () => {
    const { app } = build()
    const res = await app.request('/api/fail', { method: 'POST', headers: auth })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'PROXY_IN_USE', message: 'proxy busy' } })
  })

  it('erro inesperado → 500 sem vazar a mensagem interna', async () => {
    const { app } = build()
    const res = await app.request('/api/boom', { method: 'POST', headers: auth })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('secret internals')
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR')
  })

  it('rota inexistente → 404 NOT_FOUND no formato padrão', async () => {
    const { app } = build()
    const res = await app.request('/nada')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })
})

describe('auditoria', () => {
  it('grava mutações bem-sucedidas com alvo derivado da URL ou do id da resposta', async () => {
    const { app, audits } = build()
    expect((await app.request('/api/items', json({ name: 'a', port: 1 }))).status).toBe(201)
    expect((await app.request('/api/items/abc', { method: 'PUT', headers: auth })).status).toBe(200)
    expect(audits).toHaveLength(2)
    expect(audits[0]).toMatchObject({ actor: 'api_token', action: 'POST /api/items', targetType: 'items', targetId: 'it-1' })
    expect(audits[1]).toMatchObject({ action: 'PUT /api/items/abc', targetType: 'items', targetId: 'abc' })
    expect(typeof audits[0]?.detail.request_id).toBe('string')
  })

  it('respeita setAudit da rota', async () => {
    const { app, audits } = build()
    expect((await app.request('/api/items/x9/tags', { method: 'DELETE', headers: auth })).status).toBe(204)
    expect(audits).toEqual([expect.objectContaining({ action: 'items.untag', targetType: 'item', targetId: 'x9' })])
  })

  it('não grava GET, falhas nem requisições sem auth', async () => {
    const { app, audits } = build()
    await app.request('/api/ping', { headers: auth })
    await app.request('/api/items', json({ name: '' }))
    await app.request('/api/fail', { method: 'POST', headers: auth })
    await app.request('/api/items', json({ name: 'a', port: 1 }, {}))
    expect(audits).toEqual([])
  })
})

describe('request id e logs', () => {
  it('devolve x-request-id e loga JSON com request_id', async () => {
    const { app, lines } = build()
    const res = await app.request('/health')
    const id = res.headers.get('x-request-id')
    expect(id).toBeTruthy()
    const line = lines.find((l) => l.msg === 'request completed')
    expect(line).toMatchObject({ request_id: id, method: 'GET', path: '/health', status: 200 })
  })

  it('propaga x-request-id recebido', async () => {
    const { app, lines } = build()
    const res = await app.request('/api/ping', { headers: { ...auth, 'x-request-id': 'abc-123' } })
    expect(res.headers.get('x-request-id')).toBe('abc-123')
    expect(lines.some((l) => l.request_id === 'abc-123')).toBe(true)
  })

  it('não loga o token', async () => {
    const { app, lines } = build()
    await app.request('/api/ping', { headers: auth })
    expect(JSON.stringify(lines)).not.toContain(TOKEN)
  })
})
