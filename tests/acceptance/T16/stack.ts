// T16 — testes E2E CONTRA A STACK DO DOCKER COMPOSE (HTTP real na api e no controle interno do worker).
// Projeto compose isolado (`wsm-e2e`) com portas de host próprias: não toca no projeto padrão
// (`wa-session-manager`), cujo postgres/redis é usado pelo verify e por outras suítes.
// Contrato combinado com o Operário (Brasa):
//   - WA_TRANSPORT=fake + ANTIBAN_MODE=passthrough só por env de teste (default do produto: baileys + antiban real)
//   - portas de host parametrizadas: POSTGRES_HOST_PORT, REDIS_HOST_PORT, API_HOST_PORT, DASHBOARD_HOST_PORT,
//     WORKER_HEALTH_HOST_PORT, WORKER_INTERNAL_HOST_PORT
//   - API ↔ worker por HTTP interno (WORKER_INTERNAL_URL, Bearer INTERNAL_TOKEN)
//   - controle do FakeTransport (só com WA_TRANSPORT=fake) em http://localhost:<WORKER_INTERNAL_HOST_PORT>/internal/fake/sessions/:id/...
//     qr · open · close {reason,statusCode?} · receive {from,text} · receipt {messageId,status} · fail-next-send {statusCode?}
//     send-delay {ms} · GET state {exists,connected,connectCalls,bootId,sent[]} · GET sent-history {items[]} (durável, Redis)
import { randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { exec, tail, type ExecResult } from '../helpers/exec'

export const PROJECT = process.env.WSM_E2E_PROJECT ?? 'wsm-e2e'

export const PORTS = {
  postgres: 15432,
  redis: 16379,
  api: 13000,
  dashboard: 18080,
  workerHealth: 19464,
  workerInternal: 19465,
}

export const TOKENS = {
  api: `e2e-api-${randomBytes(12).toString('hex')}`,
  internal: `e2e-internal-${randomBytes(12).toString('hex')}`,
  credentialsKey: randomBytes(32).toString('base64'),
}

export const URLS = {
  api: `http://127.0.0.1:${PORTS.api}`,
  dashboard: `http://127.0.0.1:${PORTS.dashboard}`,
  workerHealth: `http://127.0.0.1:${PORTS.workerHealth}`,
  workerInternal: `http://127.0.0.1:${PORTS.workerInternal}`,
}

export const SERVICES = ['postgres', 'redis', 'api', 'worker', 'dashboard'] as const

/** Env do compose para a stack de teste. */
export function stackEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: PROJECT,
    WA_TRANSPORT: 'fake',
    ANTIBAN_MODE: 'passthrough',
    API_TOKEN: TOKENS.api,
    INTERNAL_TOKEN: TOKENS.internal,
    CREDENTIALS_KEY: TOKENS.credentialsKey,
    LOG_LEVEL: 'info',
    ALERT_DEDUP_MS: '1000',
    POSTGRES_HOST_PORT: String(PORTS.postgres),
    REDIS_HOST_PORT: String(PORTS.redis),
    API_HOST_PORT: String(PORTS.api),
    DASHBOARD_HOST_PORT: String(PORTS.dashboard),
    WORKER_HEALTH_HOST_PORT: String(PORTS.workerHealth),
    WORKER_INTERNAL_HOST_PORT: String(PORTS.workerInternal),
    ...extra,
  }
}

export function compose(args: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): ExecResult {
  return exec(`docker compose -p ${PROJECT} ${args}`, { timeoutMs: opts.timeoutMs ?? 600_000, env: stackEnv(opts.env) })
}

export function composeOk(args: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): ExecResult {
  const r = compose(args, opts)
  if (r.code !== 0) throw new Error(`docker compose ${args} falhou\n${tail(r, 60)}\n--- logs ---\n${logs()}`)
  return r
}

/** Últimas linhas de log dos serviços (para diagnósticos em falhas). */
export function logs(services = 'api worker', lines = 60): string {
  const r = compose(`logs --no-color --tail ${lines} ${services}`, { timeoutMs: 60_000 })
  return r.output.slice(-8_000)
}

export interface PsEntry {
  Service: string
  State: string
  Health: string
  Status?: string
}

export function ps(): PsEntry[] {
  const r = compose('ps -a --format json', { timeoutMs: 60_000 })
  const text = r.stdout.trim()
  if (!text) return []
  // compose v2+ pode devolver um array JSON ou um objeto por linha
  if (text.startsWith('[')) return JSON.parse(text)
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

export const down = () => compose('down -v --remove-orphans', { timeoutMs: 300_000 })

// ---- HTTP -------------------------------------------------------------------------------

export interface HttpRes<T = any> {
  status: number
  body: T
  text: string
  headers: Headers
}

export async function http<T = any>(base: string, method: string, path: string, opts: { token?: string | null; body?: unknown; timeoutMs?: number } = {}): Promise<HttpRes<T>> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  })
  const text = await res.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    /* não-JSON */
  }
  return { status: res.status, body, text, headers: res.headers }
}

/** Cliente da API pública. */
export const api = (method: string, path: string, body?: unknown, token: string | null = TOKENS.api) => http(URLS.api, method, path, { token, body })

/** Controle do FakeTransport no worker (token interno). */
export const fake = (method: string, sessionId: string, action: string, body?: unknown, token: string | null = TOKENS.internal) =>
  http(URLS.workerInternal, method, `/internal/fake/sessions/${sessionId}/${action}`, { token, body })

/** Espera por uma condição assíncrona (polling, sem sleep cego). */
export async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  let last: T | undefined
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (pred(last)) return last
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250))
  }
  throw new Error(`timeout esperando ${opts.what ?? 'condição'}; último valor: ${JSON.stringify(last)?.slice(0, 800)}${lastErr ? `; último erro: ${String(lastErr)}` : ''}`)
}

// ---- fluxos -------------------------------------------------------------------------------

export const randomPhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
export const jidOf = (phone: string) => `${phone.replace(/^\+/, '')}@s.whatsapp.net`

export async function sessionStatus(id: string): Promise<string | undefined> {
  const r = await api('GET', `/api/sessions/${id}`)
  return r.body?.status
}

export const waitSessionStatus = (id: string, status: string, timeoutMs = 30_000) =>
  until(() => sessionStatus(id), (s) => s === status, { timeoutMs, what: `sessão ${id} em ${status}` })

/** Fake do worker para a sessão existe (conexão iniciada). */
export const waitFakeReady = (id: string, timeoutMs = 30_000) =>
  until(() => fake('GET', id, 'state'), (r) => r.status === 200 && r.body?.exists !== false, { timeoutMs, what: `FakeTransport da sessão ${id}` })

/** Cria a sessão, pede QR, emite o QR no fake, confere o data URL e abre a conexão → WARMING. */
export async function connectSession(name = `e2e-${randomBytes(3).toString('hex')}`) {
  const created = await api('POST', '/api/sessions', { name, phone: randomPhone() })
  expect(created.status, `POST /api/sessions → ${created.text}`).toBe(201)
  expect(created.body.status).toBe('NEW')
  const id = created.body.id as string

  const qr = await api('POST', `/api/sessions/${id}/qr`)
  expect(qr.status, `POST /qr → ${qr.text}`).toBe(202)
  await waitFakeReady(id)
  const emitted = await fake('POST', id, 'qr', { qr: `2@e2e-${randomBytes(4).toString('hex')}` })
  expect(emitted.status, `fake qr → ${emitted.text}`).toBeLessThan(300)
  const got = await until(() => api('GET', `/api/sessions/${id}/qr`), (r) => typeof r.body?.qr === 'string', { what: 'QR data URL' })
  expect(got.body.qr).toMatch(/^data:image\/png;base64,/)

  const opened = await fake('POST', id, 'open')
  expect(opened.status, `fake open → ${opened.text}`).toBeLessThan(300)
  await waitSessionStatus(id, 'WARMING')
  return { id, session: created.body }
}

/** Contato consentido (T07). */
export async function createContact(opts: { consent?: boolean } = {}) {
  const phone = randomPhone()
  const consent = opts.consent ?? true
  const body: Record<string, unknown> = { phone, name: `e2e-${randomBytes(2).toString('hex')}`, consent }
  if (consent) Object.assign(body, { consent_at: new Date().toISOString(), consent_source: 'e2e' })
  const r = await api('POST', '/api/contacts', body)
  expect(r.status, `POST /api/contacts → ${r.text}`).toBe(201)
  return { id: r.body.id as string, phone }
}

export const sendText = (sessionId: string, phone: string, text: string) => api('POST', `/api/sessions/${sessionId}/messages`, { phone, content: { text } })

export async function messageStatus(id: string): Promise<string | undefined> {
  return (await api('GET', `/api/messages/${id}`)).body?.status
}

export const waitMessageStatus = (id: string, status: string | string[], timeoutMs = 60_000) => {
  const wanted = Array.isArray(status) ? status : [status]
  return until(() => api('GET', `/api/messages/${id}`), (r) => wanted.includes(r.body?.status), { timeoutMs, what: `mensagem ${id} em ${wanted.join('|')}` })
}

/** Histórico durável de envios do fake (sobrevive a restart do worker). */
export async function sentHistory(sessionId: string): Promise<Array<{ messageId: string; to: string; content: any; at?: string; bootId?: string }>> {
  const r = await fake('GET', sessionId, 'sent-history')
  expect(r.status, `GET sent-history → ${r.text}`).toBe(200)
  return r.body?.items ?? []
}
