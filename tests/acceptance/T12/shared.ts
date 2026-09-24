// Harness do T12: API (createApp + SessionManager com FakeTransport, banco descartável) e o build do
// dashboard servidos por um servidor Node na MESMA origem (/api, /metrics e /health → app.fetch; o resto →
// apps/dashboard/dist com fallback para index.html). Browser: chromium headless do Playwright.
// Contrato combinado com o Operário (T12):
//   rotas hash (#/login, #/, #/sessions, #/sessions/new, #/sessions/<id>, #/proxies, #/contacts, #/groups, #/alerts);
//   token em sessionStorage 'wsm.token'; data-testids login-*, nav-*, card-* (filho card-value), session-row/
//   session-state/session-link, add-session, new-*, gen-qr/gen-pairing, qr-image/pairing-code/auth-connected/
//   session-open/auth-error, session-card/detail-*, btn-pause|btn-resume/btn-restart/btn-logs/logs-panel, chart-*,
//   page-*, csv-*, groups-session/group-row, webhook-*; estado vazio = 'Sem dados'.
import '../T05/env'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { captureLogger, call, closeQuietly, createRedis, importFrom } from '../helpers/app'
import { exec, rootPath, tail } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'
import { createTransportFactory, type TransportFactory } from '../T05/shared'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
export const DIST = rootPath('apps/dashboard/dist')
const SRC = rootPath('apps/dashboard/src')

// ---- build -------------------------------------------------------------------------

export const buildDashboard = () => exec('pnpm --filter @wsm/dashboard build', { timeoutMs: 600_000 })

function newestMtime(dir: string): number {
  let max = 0
  if (!existsSync(dir)) return max
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    max = Math.max(max, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return max
}

/** Builda o dashboard se o dist/ não existir ou estiver mais velho que src/ ou index.html. */
export function ensureBuild() {
  const index = join(DIST, 'index.html')
  const srcTime = Math.max(newestMtime(SRC), statSync(rootPath('apps/dashboard/index.html')).mtimeMs)
  if (existsSync(index) && statSync(index).mtimeMs >= srcTime) return
  const r = buildDashboard()
  if (r.code !== 0) throw new Error(`build do dashboard falhou\n${tail(r, 60)}`)
}

// ---- servidor na mesma origem ---------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

export async function serve(app: any) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (/^\/(api|metrics|health)(\/|$)/.test(url.pathname)) {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
        const method = req.method ?? 'GET'
        const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks)
        const r: Response = await app.fetch(new Request(`http://127.0.0.1${url.pathname}${url.search}`, { method, headers, body }))
        const out = Buffer.from(await r.arrayBuffer())
        const h: Record<string, string> = {}
        r.headers.forEach((v, k) => (h[k] = v))
        res.writeHead(r.status, h)
        res.end(out)
        return
      }
      let file = normalize(join(DIST, decodeURIComponent(url.pathname)))
      if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(readFileSync(file))
    } catch (e) {
      res.writeHead(500)
      res.end(String(e))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      }),
  }
}

// ---- Playwright -----------------------------------------------------------------------------

async function loadPlaywright(): Promise<any> {
  for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    try {
      const m = await importFrom<any>('apps/dashboard', name)
      const pw = m.chromium ? m : m.default
      if (pw?.chromium) return pw
    } catch {
      /* tenta o próximo */
    }
  }
  if (process.env.WSM_PLAYWRIGHT) return importFrom(process.env.WSM_PLAYWRIGHT, 'playwright')
  throw new Error("playwright não resolvível a partir de apps/dashboard (devDependency 'playwright' esperada)")
}

/** Chromium já instalado em ms-playwright (headless shell primeiro), para não baixar nada. */
function chromiumExecutable(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'AppData', 'Local', 'ms-playwright')
  if (!existsSync(base)) return undefined
  const dirs = readdirSync(base).sort().reverse()
  const candidates: string[] = []
  for (const d of dirs.filter((x) => x.startsWith('chromium_headless_shell-')))
    candidates.push(join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), join(base, d, 'chrome-linux', 'headless_shell'))
  for (const d of dirs.filter((x) => /^chromium-\d+$/.test(x))) candidates.push(join(base, d, 'chrome-win64', 'chrome.exe'), join(base, d, 'chrome-win', 'chrome.exe'), join(base, d, 'chrome-linux', 'chrome'))
  return candidates.find((c) => existsSync(c))
}

export async function launchBrowser() {
  const pw = await loadPlaywright()
  try {
    return await pw.chromium.launch({ headless: true })
  } catch (e) {
    const executablePath = chromiumExecutable()
    if (!executablePath) throw e
    return pw.chromium.launch({ headless: true, executablePath })
  }
}

// ---- contexto ---------------------------------------------------------------------------

export interface DCtx {
  tempDb: TempDb
  db: any
  redis: any
  token: string
  app: any
  manager: any
  tf: TransportFactory
  base: string
  browser: any
  /** erros de página (pageerror) de todas as páginas abertas via newPage */
  pageErrors: string[]
  newPage(opts?: { login?: boolean }): Promise<any>
}

export function useDashboard(): DCtx {
  const ctx = { pageErrors: [] as string[] } as DCtx
  let server: { close(): Promise<void> } | undefined
  const contexts: any[] = []
  beforeAll(async () => {
    ensureBuild()
    ctx.tempDb = createTempDb('wsm_t12')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    const logger = (await captureLogger()).logger
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    const SessionManager = (worker as any).SessionManager
    ctx.tf = createTransportFactory()
    ctx.manager = new SessionManager({ db: ctx.db, logger, transportFactory: ctx.tf.factory, sleep: async () => {}, pairingTimeoutMs: 10_000 })
    ctx.app = await (createApp as any)({ db: ctx.db, redis: ctx.redis, logger, apiToken: ctx.token, sessions: ctx.manager })
    await ctx.manager.start()
    const s = await serve(ctx.app)
    server = s
    ctx.base = s.url
    ctx.browser = await launchBrowser()
    ctx.newPage = async ({ login = true } = {}) => {
      const bc = await ctx.browser.newContext()
      contexts.push(bc)
      const page = await bc.newPage()
      page.setDefaultTimeout(15_000)
      page.on('pageerror', (e: Error) => ctx.pageErrors.push(e.message))
      if (login) await doLogin(ctx, page)
      return page
    }
  })
  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => {})
    await ctx.browser?.close().catch(() => {})
    await server?.close()
    await ctx.manager?.stop().catch(() => {})
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

// ---- helpers de UI ---------------------------------------------------------------------------

export const tid = (id: string) => `[data-testid="${id}"]`

export const hashOf = (page: any) => page.evaluate(() => location.hash)

export async function doLogin(ctx: DCtx, page: any, token = ctx.token) {
  await page.goto(`${ctx.base}/#/login`)
  await page.locator(tid('login-token')).fill(token)
  await page.locator(tid('login-submit')).click()
  await expect.poll(() => hashOf(page), { timeout: 15_000, message: 'login não saiu de #/login' }).not.toMatch(/^#\/login/)
}

export async function go(ctx: DCtx, page: any, hashPath: string) {
  await page.goto(`${ctx.base}/#${hashPath}`)
}

export const textOf = async (page: any, testId: string) => ((await page.locator(tid(testId)).first().textContent()) ?? '').trim()

// ---- API / banco ------------------------------------------------------------------------------

export const api = (ctx: DCtx, method: string, path: string, body?: unknown) => call(ctx.app, method, path, { token: ctx.token, body })

export const randomPhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

export async function createSession(ctx: DCtx, extra: Record<string, unknown> = {}) {
  const res = await api(ctx, 'POST', '/api/sessions', { name: `painel-${randomBytes(3).toString('hex')}`, phone: randomPhone(), ...extra })
  expect(res.status, `POST /api/sessions → ${res.text}`).toBe(201)
  return res.body as Record<string, any>
}

/** Sessão conectada de verdade (QR → login no FakeTransport): WARMING. */
export async function connectedSession(ctx: DCtx) {
  const s = await createSession(ctx)
  const qr = await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
  expect(qr.status, qr.text).toBe(202)
  await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
  const t = ctx.tf.last(s.id)!
  await t.login()
  await expect.poll(() => statusOf(ctx, s.id), { timeout: 5_000 }).toBe('WARMING')
  return { id: s.id as string, name: s.name as string, transport: t }
}

export const statusOf = (ctx: DCtx, id: string) => sqlOk(ctx.tempDb.url, `SELECT status FROM sessions WHERE id = ${lit(id)};`)[0]?.[0]

/** Força o estado no banco (semente de dados para a UI; não passa pela máquina de estados). */
export const setStatus = (ctx: DCtx, id: string, status: string) =>
  sqlOk(ctx.tempDb.url, `UPDATE sessions SET status = ${lit(status)}::session_status, warmup_started_at = coalesce(warmup_started_at, now()) WHERE id = ${lit(id)};`)

export function insertMessages(ctx: DCtx, id: string, n: number, status: string, direction: 'outbound' | 'inbound' = 'outbound') {
  if (n <= 0) return
  sqlOk(
    ctx.tempDb.url,
    `INSERT INTO messages (session_id, direction, phone, content, status, created_at, sent_at)
       SELECT ${lit(id)}, ${lit(direction)}::message_direction, '+5599900000001', '{"text":"t"}'::jsonb, ${lit(status)}::message_status,
              now() - interval '10 minutes', CASE WHEN ${lit(status)} IN ('sent','delivered','read') THEN now() - interval '9 minutes' ELSE NULL END
         FROM generate_series(1, ${n});`,
  )
}

export function insertHealthEvent(ctx: DCtx, id: string, type: string) {
  sqlOk(ctx.tempDb.url, `INSERT INTO health_events (session_id, type, detail) VALUES (${lit(id)}, ${lit(type)}, '{}'::jsonb);`)
}

export const INDICATORS: Record<string, string> = {
  NEW: '⚫ New',
  WARMING: '🟡 Warm-up',
  STABLE: '🟢 Connected',
  DEGRADED: '🟠 Degraded',
  PAUSED: '🔴 Paused',
  DISCONNECTED: '⚫ Disconnected',
}

