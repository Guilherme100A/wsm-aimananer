// Regra de conexão com proxy (AC-T06-05): sessão com proxy configurado NUNCA conecta sem ele.
// Proxy indisponível → a conexão falha e a sessão fica DISCONNECTED (sem fallback para conexão direta).
import { eq } from 'drizzle-orm'
import { proxies, sessions, type Database } from '@wsm/db'
import type { AuthenticationState, ConnectOptions, WaTransport } from '../transport'
import { ProxyError, ProxyUnavailableError } from './errors'
import { proxyConnectionUrl } from './service'

export interface SessionProxy {
  proxyId?: string
  /** URL em claro (com senha) para o transporte; `undefined` só quando a sessão não tem proxy. */
  proxyUrl?: string
}

/**
 * Resolve a rede de uma sessão. Sessão sem proxy → `{}` (conexão direta é a configuração dela).
 * Proxy configurado mas indisponível → `ProxyUnavailableError`. Sessão inexistente → `SESSION_NOT_FOUND`.
 */
export async function resolveSessionProxy(db: Database, sessionId: string): Promise<SessionProxy> {
  const [row] = await db
    .select({ sessionId: sessions.id, proxyId: sessions.proxyId, proxy: proxies })
    .from(sessions)
    .leftJoin(proxies, eq(proxies.id, sessions.proxyId))
    .where(eq(sessions.id, sessionId))
  if (!row) throw new ProxyError('SESSION_NOT_FOUND', `session ${sessionId} not found`)
  if (!row.proxyId) return {}
  // proxy_id setado sem linha correspondente não deve ocorrer (FK); por segurança, trata como indisponível.
  if (!row.proxy) throw new ProxyUnavailableError(row.proxyId, 'proxy not found')
  if (!row.proxy.available) throw new ProxyUnavailableError(row.proxyId, row.proxy.lastError)
  let proxyUrl: string
  try {
    proxyUrl = proxyConnectionUrl(row.proxy)
  } catch (err) {
    throw new ProxyUnavailableError(row.proxyId, `cannot decrypt proxy credentials (${(err as Error).name})`)
  }
  return { proxyId: row.proxyId, proxyUrl }
}

export interface ConnectSessionOptions extends Omit<ConnectOptions, 'proxyUrl' | 'auth'> {
  db: Database
  transport: WaTransport
  auth: AuthenticationState
}

/**
 * Conecta a sessão usando o proxy configurado. Se o proxy não puder ser usado, NÃO chama
 * `transport.connect`, marca a sessão como `DISCONNECTED` e rejeita com o erro original.
 * O proxy é lido do banco a cada conexão: uma troca (AC-T06-03) vale a partir do próximo connect.
 */
export async function connectSession(opts: ConnectSessionOptions): Promise<SessionProxy> {
  const { db, transport, ...connect } = opts
  let resolved: SessionProxy
  try {
    resolved = await resolveSessionProxy(db, connect.sessionId)
  } catch (err) {
    if (err instanceof ProxyError && err.code === 'SESSION_NOT_FOUND') throw err
    await db
      .update(sessions)
      .set({ status: 'DISCONNECTED', updatedAt: new Date() })
      .where(eq(sessions.id, connect.sessionId))
    throw err
  }
  const connectOpts: ConnectOptions = resolved.proxyUrl ? { ...connect, proxyUrl: resolved.proxyUrl } : connect
  await transport.connect(connectOpts)
  return resolved
}
