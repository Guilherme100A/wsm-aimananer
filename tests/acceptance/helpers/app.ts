// Teste da API sem porta: createApp(deps) de @wsm/api + app.request (Hono).
// Libs de terceiros (pino, ioredis, zod, ...) não são dependências da raiz: são carregadas
// a partir do workspace que as declara (contrato combinado no T03).
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { rootPath } from './exec'

/** Importa `name` resolvido a partir de um workspace (ex.: 'apps/api'). */
export async function importFrom<T = any>(workspace: string, name: string): Promise<T> {
  const req = createRequire(rootPath(workspace, 'package.json'))
  let resolved: string
  try {
    resolved = req.resolve(name)
  } catch (e) {
    throw new Error(`'${name}' não resolvível a partir de ${workspace} (deve ser dependência direta): ${String(e)}`)
  }
  return (await import(pathToFileURL(resolved).href)) as T
}

/** Logger pino que captura cada linha emitida (para inspecionar logs JSON). */
export async function captureLogger(workspace = 'apps/api') {
  const pinoMod = await importFrom<any>(workspace, 'pino')
  const pino = typeof pinoMod.default === 'function' ? pinoMod.default : pinoMod.pino
  const lines: string[] = []
  const stream = { write: (s: string) => void lines.push(...String(s).split('\n').filter((l) => l.trim())) }
  const logger = pino({ level: 'trace' }, stream)
  return { logger, lines }
}

export async function importRedis(workspace = 'apps/api') {
  const mod = await importFrom<any>(workspace, 'ioredis')
  return (mod.Redis ?? mod.default) as new (...args: any[]) => any
}

/** Cliente ioredis conectado (lança se o Redis não responder). */
export async function createRedis(url: string, workspace = 'apps/api') {
  const Redis = await importRedis(workspace)
  const client = new Redis(url, { maxRetriesPerRequest: 1 })
  client.on('error', () => {})
  await withTimeout(client.ping(), 10_000, `ping ${url}`)
  return client
}

/** Cliente ioredis apontando para um servidor inexistente, que falha rápido (sem reconectar). */
export async function createDeadRedis(url = 'redis://127.0.0.1:1', workspace = 'apps/api') {
  const Redis = await importRedis(workspace)
  const client = new Redis(url, { maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null, connectTimeout: 1000 })
  client.on('error', () => {})
  return client
}

export async function closeQuietly(x: any) {
  if (!x) return
  try {
    if (typeof x.disconnect === 'function') return void x.disconnect()
    const client = x.$client ?? x.client ?? x.session?.client
    if (client && typeof client.end === 'function') await client.end()
  } catch {
    /* ignora */
  }
}

export interface AppResponse<T = any> {
  status: number
  headers: Headers
  body: T
  text: string
}

export interface CallOptions {
  token?: string | null
  body?: unknown
  /** corpo cru (ex.: JSON malformado) */
  raw?: string
  headers?: Record<string, string>
}

export async function call<T = any>(app: any, method: string, path: string, opts: CallOptions = {}): Promise<AppResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  let body: string | undefined
  if (opts.raw !== undefined) body = opts.raw
  else if (opts.body !== undefined) body = JSON.stringify(opts.body)
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res: Response = await app.request(`http://localhost${path}`, { method, headers, body })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, headers: res.headers, body: parsed as T, text }
}

/** Promise com prazo, para detectar handlers que penduram. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout (${ms}ms): ${what}`)), ms))])
}
