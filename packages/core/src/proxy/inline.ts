// Proxy informado junto com a sessão (T17, AC-T17-03/04/05): validação dos campos, gravação (senha cifrada, T06)
// e a visão pública sem senha.
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { proxies, type Database } from '@wsm/db'
import { encryptProxyPassword, type ProxyRow } from './service'
import { buildProxyUrl, parseProxyUrl, ProxyUrlError, SUPPORTED_PROXY_PROTOCOLS, type ProxyProtocolName } from './url'

/** Proxy inline no cadastro/edição da sessão. */
export interface InlineProxyInput {
  protocol: ProxyProtocolName
  host: string
  port: number
  username?: string | null
  /** No PATCH: ausente = manter a senha atual; null = remover. */
  password?: string | null
}

/** Proxy de uma sessão na API: nunca a senha nem campos cifrados. */
export interface SessionProxyView {
  id: string
  protocol: ProxyProtocolName
  host: string
  port: number
  username: string | null
  hasPassword: boolean
}

export interface NormalizedInlineProxy {
  protocol: ProxyProtocolName
  host: string
  port: number
  username: string | null
  password: string | null
}

type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>

/**
 * Valida o proxy inline (protocolo, host, porta 1..65535 inteira). Lança `ProxyUrlError` com `field`.
 * `password: undefined` vira null (quem trata "manter a atual" é o PATCH).
 */
export function normalizeInlineProxy(input: InlineProxyInput): NormalizedInlineProxy {
  const fail = (field: string, message: string): never => {
    const err = new ProxyUrlError(message) as ProxyUrlError & { field: string }
    err.field = field
    throw err
  }
  if (!input || typeof input !== 'object') fail('proxy', 'proxy must be an object')
  if (!(SUPPORTED_PROXY_PROTOCOLS as readonly string[]).includes(input.protocol)) {
    fail('proxy.protocol', `unsupported proxy protocol "${String(input.protocol)}" (use http, https or socks5)`)
  }
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (!host) fail('proxy.host', 'proxy host is required')
  if (/[\s/?#@]/.test(host)) fail('proxy.host', 'proxy host must be a hostname or IP address')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) fail('proxy.port', 'proxy port must be an integer between 1 and 65535')
  const username = typeof input.username === 'string' && input.username !== '' ? input.username : null
  const password = typeof input.password === 'string' && input.password !== '' ? input.password : null
  if (password && !username) fail('proxy.username', 'proxy password requires a username')
  // Confere com o parser do T06 (hostname/IPv6 válido e URL montável).
  try {
    const parsed = parseProxyUrl(buildProxyUrl({ protocol: input.protocol, host, port: input.port }))
    return { protocol: parsed.protocol, host: parsed.host, port: parsed.port, username, password }
  } catch (err) {
    if (err instanceof ProxyUrlError) fail('proxy.host', 'proxy host must be a hostname or IP address')
    throw err
  }
}

export function toSessionProxyView(row: ProxyRow): SessionProxyView {
  return {
    id: row.id,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: row.passwordCiphertext != null,
  }
}

/** Grava um proxy novo (senha cifrada com AAD do id). */
export async function insertInlineProxy(db: Executor, proxy: NormalizedInlineProxy): Promise<ProxyRow> {
  const id = randomUUID()
  const [row] = await db
    .insert(proxies)
    .values({
      id,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      ...encryptProxyPassword(id, proxy.password),
      lastChangedAt: new Date(),
    })
    .returning()
  return row!
}

/** Visões dos proxies pelos ids (para enriquecer listas de sessões). */
export async function loadSessionProxies(db: Pick<Database, 'select'>, ids: ReadonlyArray<string | null>): Promise<Map<string, SessionProxyView>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))]
  if (wanted.length === 0) return new Map()
  const rows = await db.select().from(proxies).where(inArray(proxies.id, wanted))
  return new Map(rows.map((r) => [r.id, toSessionProxyView(r)]))
}
