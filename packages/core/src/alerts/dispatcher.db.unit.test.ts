// AlertDispatcher com Postgres local (banco descartável), servidor HTTP local e SMTP mínimo em net.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, webhooks, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { AlertDispatcher, type AlertDispatcherOptions, type DeliveryFailure } from './dispatcher'
import { signWebhookBody } from './events'
import { WebhookService } from './webhooks'

interface Hit {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

let tmp: TempDatabase
let db: Database
let http: Server
let base: string
let hits: Hit[]
/** Status devolvido por caminho (default 200). Lista = sequência por tentativa. */
let statusFor: Record<string, number[]>
let smtp: NetServer
let smtpUrl: string
let mails: string[]
const prevKey = process.env.CREDENTIALS_KEY

function startSmtp(): Promise<NetServer> {
  const server = createNetServer((sock) => {
    let data = false
    let buf = ''
    sock.write('220 mock ESMTP\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      if (data) {
        const end = buf.indexOf('\r\n.\r\n')
        if (end === -1) return
        mails.push(buf.slice(0, end))
        buf = buf.slice(end + 5)
        data = false
        sock.write('250 queued\r\n')
      }
      let i: number
      while (!data && (i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 mock\r\n')
        else if (cmd === 'DATA') {
          data = true
          sock.write('354 go\r\n')
        } else if (cmd === 'QUIT') {
          sock.end('221 bye\r\n')
        } else sock.write('250 ok\r\n')
      }
    })
    sock.on('error', () => {})
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_alerts' })
  db = createDb(tmp.url, { max: 4 })
  http = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body })
      const seq = statusFor[req.url ?? '']
      const status = seq && seq.length > 0 ? seq.shift()! : 200
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  smtp = await startSmtp()
  smtpUrl = `smtp://127.0.0.1:${(smtp.address() as AddressInfo).port}`
})

afterAll(async () => {
  http?.close()
  smtp?.close()
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

let clock: Date
let sleeps: number[]
beforeEach(async () => {
  await db.delete(webhooks)
  hits = []
  mails = []
  statusFor = {}
  clock = new Date('2026-05-01T10:00:00Z')
  sleeps = []
})

const quiet = { info() {}, warn() {}, error() {} }
const dispatcher = (extra: Partial<AlertDispatcherOptions> = {}) =>
  new AlertDispatcher({ db, logger: quiet, now: () => clock, sleep: async (ms) => void sleeps.push(ms), timeoutMs: 2000, ...extra })
const svc = () => new WebhookService(db)

describe('AlertDispatcher', () => {
  it('http genérico: body JSON + x-wsm-signature (HMAC-SHA256 do body)', async () => {
    const w = await svc().create({ name: 'h', channel: 'http', url: `${base}/hook`, secret: 's3cr3t' })
    const r = await dispatcher().dispatch({ type: 'forbidden_403', sessionId: 'sess-1', detail: { statusCode: 403 } })
    expect(r).toEqual({ deduped: false, deliveries: [{ webhookId: w.id, channel: 'http', ok: true, attempts: 1 }] })
    expect(hits).toHaveLength(1)
    const hit = hits[0]!
    expect(hit.headers['content-type']).toContain('application/json')
    expect(JSON.parse(hit.body)).toEqual({ event: 'forbidden_403', sessionId: 'sess-1', at: clock.toISOString(), detail: { statusCode: 403 } })
    expect(hit.headers['x-wsm-signature']).toBe(signWebhookBody(hit.body, 's3cr3t'))
  })

  it('discord e telegram (URL base configurável)', async () => {
    await svc().create({ name: 'd', channel: 'discord', url: `${base}/discord` })
    await svc().create({ name: 't', channel: 'telegram', url: base, secret: '123:TOKEN', config: { chatId: '42' } })
    const r = await dispatcher().dispatch({ type: 'disconnected', sessionId: 'sess-2' })
    expect(r.deliveries.every((d) => d.ok)).toBe(true)
    const discord = hits.find((h) => h.path === '/discord')!
    expect(JSON.parse(discord.body).content).toMatch(/disconnected[\s\S]*sess-2/)
    const tg = hits.find((h) => h.path === '/bot123:TOKEN/sendMessage')!
    expect(JSON.parse(tg.body)).toMatchObject({ chat_id: '42' })
    expect(JSON.parse(tg.body).text).toContain('sess-2')
  })

  it('email via SMTP (nodemailer) e fallback SMTP_URL', async () => {
    await svc().create({ name: 'e', channel: 'email', url: smtpUrl, config: { to: 'ops@example.com' } })
    await svc().create({ name: 'e2', channel: 'email', url: '', config: { to: 'oncall@example.com', from: 'x@example.com' } })
    const r = await dispatcher({ smtpUrl }).dispatch({ type: 'warmup_paused', sessionId: 'sess-3' })
    expect(r.deliveries.map((d) => d.ok)).toEqual([true, true])
    expect(mails).toHaveLength(2)
    expect(mails.join('\n')).toContain('Subject: [WSM] warmup_paused')
    expect(mails.join('\n')).toContain('sess-3')
    expect(mails.join('\n')).toContain('alerts@wsm.local')
  })

  it('dedup: mesmo (evento, sessão) por 10 min; outro evento ou sessão passa', async () => {
    await svc().create({ name: 'h', channel: 'http', url: `${base}/hook`, secret: 's' })
    const d = dispatcher()
    expect((await d.dispatch({ type: 'error_burst', sessionId: 'a' })).deduped).toBe(false)
    clock = new Date(clock.getTime() + 9 * 60_000)
    expect(await d.dispatch({ type: 'error_burst', sessionId: 'a' })).toEqual({ deduped: true, deliveries: [] })
    expect((await d.dispatch({ type: 'error_burst', sessionId: 'b' })).deduped).toBe(false)
    expect((await d.dispatch({ type: 'health_degraded', sessionId: 'a' })).deduped).toBe(false)
    clock = new Date(clock.getTime() + 60_000)
    expect((await d.dispatch({ type: 'error_burst', sessionId: 'a' })).deduped).toBe(false)
    expect(hits).toHaveLength(4)
  })

  it('dedup configurável', async () => {
    await svc().create({ name: 'h', channel: 'http', url: `${base}/hook`, secret: 's' })
    const d = dispatcher({ dedupMs: 1000 })
    await d.dispatch({ type: 'error_burst', sessionId: 'a' })
    clock = new Date(clock.getTime() + 1000)
    expect((await d.dispatch({ type: 'error_burst', sessionId: 'a' })).deduped).toBe(false)
  })

  it('retries: falha transitória é reenviada; esgotado → ok=false, log e delivery_failed, sem lançar', async () => {
    const ok = await svc().create({ name: 'ok', channel: 'http', url: `${base}/flaky`, secret: 's' })
    const bad = await svc().create({ name: 'bad', channel: 'http', url: `${base}/down`, secret: 's' })
    statusFor['/flaky'] = [500, 502]
    statusFor['/down'] = [500, 500, 500, 500]
    const logs: Array<{ level: string; obj: Record<string, unknown> }> = []
    const logger = {
      info() {},
      warn: (obj: object) => void logs.push({ level: 'warn', obj: obj as Record<string, unknown> }),
      error: (obj: object) => void logs.push({ level: 'error', obj: obj as Record<string, unknown> }),
    }
    const d = dispatcher({ logger, backoff: (n) => n * 10 })
    const failed: DeliveryFailure[] = []
    d.on('delivery_failed', (f) => failed.push(f))
    const r = await d.dispatch({ type: 'forbidden_403', sessionId: 'x' })
    const byId = Object.fromEntries(r.deliveries.map((x) => [x.webhookId, x]))
    expect(byId[ok.id]).toMatchObject({ ok: true, attempts: 3 })
    expect(byId[bad.id]).toMatchObject({ ok: false, attempts: 3, error: 'HTTP 500' })
    expect(hits.filter((h) => h.path === '/down')).toHaveLength(3)
    expect(failed).toEqual([{ webhookId: bad.id, channel: 'http', event: 'forbidden_403', sessionId: 'x', attempts: 3, error: 'HTTP 500' }])
    expect(sleeps.sort()).toEqual([10, 10, 20, 20])
    expect(logs.find((l) => l.level === 'error')?.obj).toMatchObject({ webhook_id: bad.id, event: 'forbidden_403' })
  })

  it('conexão recusada não lança e não vaza o token do telegram', async () => {
    await svc().create({ name: 't', channel: 'telegram', url: 'http://127.0.0.1:1', secret: '999:SECRET', config: { chatId: 1 } })
    const logs: string[] = []
    const logger = { info() {}, warn: (o: object) => void logs.push(JSON.stringify(o)), error: (o: object) => void logs.push(JSON.stringify(o)) }
    const r = await dispatcher({ logger, maxAttempts: 2 }).dispatch({ type: 'disconnected', sessionId: 'y' })
    expect(r.deliveries[0]).toMatchObject({ ok: false, attempts: 2 })
    expect(logs.length).toBe(2)
    expect(logs.join('\n')).not.toContain('SECRET')
    expect(r.deliveries[0]!.error ?? '').not.toContain('SECRET')
  })

  it('filtra por enabled e events; tipo desconhecido não entrega', async () => {
    await svc().create({ name: 'off', channel: 'discord', url: `${base}/off`, enabled: false })
    await svc().create({ name: 'only403', channel: 'discord', url: `${base}/only403`, events: ['forbidden_403'] })
    await svc().create({ name: 'all', channel: 'discord', url: `${base}/all` })
    const d = dispatcher()
    await d.dispatch({ type: 'disconnected', sessionId: 's' })
    await d.dispatch({ type: 'forbidden_403', sessionId: 's' })
    expect(await d.dispatch({ type: 'banana', sessionId: 's' })).toEqual({ deduped: false, deliveries: [] })
    expect(hits.map((h) => h.path).sort()).toEqual(['/all', '/all', '/only403'])
  })

  it('segredo gravado cifrado: nenhuma coluna tem o texto claro', async () => {
    await svc().create({ name: 't', channel: 'telegram', url: base, secret: 'bot-token-plain', config: { chatId: 1 } })
    const [row] = await db.select().from(webhooks)
    expect(JSON.stringify(row)).not.toContain('bot-token-plain')
    const view = await svc().get(row!.id)
    expect(view).toMatchObject({ hasSecret: true })
    expect(JSON.stringify(view)).not.toContain('enc:')
    expect(view).not.toHaveProperty('secret')
  })

  it('update parcial: secret null remove, ausente mantém; delete', async () => {
    const w = await svc().create({ name: 'd', channel: 'discord', url: `${base}/d`, secret: 'x' })
    expect((await svc().update(w.id, { name: 'd2' })).hasSecret).toBe(true)
    expect((await svc().update(w.id, { secret: null })).hasSecret).toBe(false)
    await expect(svc().update(w.id, { channel: 'http' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await svc().remove(w.id)
    await expect(svc().get(w.id)).rejects.toMatchObject({ code: 'WEBHOOK_NOT_FOUND' })
    await expect(svc().remove(w.id)).rejects.toMatchObject({ code: 'WEBHOOK_NOT_FOUND' })
  })
})
