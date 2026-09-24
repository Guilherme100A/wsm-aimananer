// Proxy configurado junto com a sessão (AC-T18-02/03): validação no cliente, payload do T17 e exibição.
import type { ProxyProtocol, SessionProxy } from './types'

export const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ['http', 'https', 'socks5']

/** Campos do formulário (strings cruas dos inputs). */
export interface ProxyFormValues {
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  password: string
}

/** Proxy inline aceito por POST/PATCH /api/sessions (AC-T17-03/04). */
export interface ProxyInput {
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
}

export type ProxyFormResult = { ok: true; proxy: ProxyInput | null } | { ok: false; error: string }

export function emptyProxyForm(): ProxyFormValues {
  return { protocol: 'http', host: '', port: '', username: '', password: '' }
}

/** Formulário a partir do proxy atual da sessão (a senha nunca vem da API: fica vazia). */
export function proxyFormFrom(proxy: SessionProxy | null | undefined): ProxyFormValues {
  if (!proxy) return emptyProxyForm()
  return { protocol: proxy.protocol, host: proxy.host, port: String(proxy.port), username: proxy.username ?? '', password: '' }
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const IPV6_RE = /^\[?[0-9a-f:]+\]?$/i

/**
 * Valida o bloco de proxy. Tudo vazio → sem proxy (`proxy: null`).
 * Opções: `keepPassword` (edição: senha vazia mantém a atual) — nesse caso a senha é omitida do payload.
 */
export function parseProxyForm(v: ProxyFormValues, opts: { keepPassword?: boolean } = {}): ProxyFormResult {
  const host = v.host.trim()
  const port = v.port.trim()
  const username = v.username.trim()
  const password = v.password
  if (!host && !port && !username && !password) return { ok: true, proxy: null }
  if (!host) return { ok: false, error: 'Informe o IP/host do proxy' }
  if (!HOST_RE.test(host) && !IPV6_RE.test(host)) return { ok: false, error: 'IP/host do proxy inválido' }
  if (!port) return { ok: false, error: 'Informe a porta do proxy' }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { ok: false, error: 'Porta do proxy deve estar entre 1 e 65535' }
  if (password && !username) return { ok: false, error: 'Informe o usuário do proxy junto com a senha' }
  if (!PROXY_PROTOCOLS.includes(v.protocol)) return { ok: false, error: 'Protocolo do proxy inválido' }
  const proxy: ProxyInput = { protocol: v.protocol, host, port: Number(port) }
  if (username) proxy.username = username
  if (password) proxy.password = password
  else if (opts.keepPassword) delete proxy.password
  return { ok: true, proxy }
}

/** `host:port` para a lista de sessões; `—` sem proxy. */
export function proxyAddress(proxy: SessionProxy | null | undefined): string {
  return proxy ? `${proxy.host}:${proxy.port}` : '—'
}

/** `protocol://user:***@host:port` (a senha nunca aparece; `***` só indica que existe). */
export function proxyLabel(proxy: SessionProxy | null | undefined): string {
  if (!proxy) return 'Sem proxy'
  const auth = proxy.username ? `${proxy.username}${proxy.hasPassword ? ':***' : ''}@` : proxy.hasPassword ? ':***@' : ''
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`
}
