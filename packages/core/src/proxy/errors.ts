// Erros de domínio de proxies. A API mapeia `code` para a SPEC 3.4.

export type ProxyErrorCode = 'PROXY_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'PROXY_IN_USE' | 'PROXY_UNAVAILABLE'

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}

/** Proxy configurado para a sessão está indisponível: a conexão NÃO pode seguir sem ele (AC-T06-05). */
export class ProxyUnavailableError extends ProxyError {
  constructor(
    readonly proxyId: string,
    reason?: string | null,
  ) {
    super('PROXY_UNAVAILABLE', `proxy ${proxyId} is unavailable${reason ? `: ${reason}` : ''}`)
    this.name = 'ProxyUnavailableError'
  }
}

/** Violação de unicidade do Postgres (23505), inclusive quando embrulhada pelo Drizzle em `cause`. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: string; constraint?: string }
    if (pg.code === '23505') return constraint === undefined || pg.constraint === constraint
  }
  return false
}
