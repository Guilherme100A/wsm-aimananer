// Cliente HTTP mínimo para testes caixa-preta da API (SPEC 3.4).
import { expect } from 'vitest'

export interface ApiResponse<T = any> {
  status: number
  headers: Headers
  body: T
  text: string
}

export interface ApiClientOptions {
  baseUrl?: string
  /** Bearer token; `null` envia sem Authorization. */
  token?: string | null
}

export const DEFAULT_BASE_URL = process.env.WSM_API_URL ?? 'http://127.0.0.1:3000'
export const DEFAULT_TOKEN = process.env.API_TOKEN ?? 'test-token'

export function createClient(opts: ApiClientOptions = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const token = opts.token === undefined ? DEFAULT_TOKEN : opts.token

  async function request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const h: Record<string, string> = { accept: 'application/json', ...headers }
    if (token) h.authorization = `Bearer ${token}`
    if (body !== undefined) h['content-type'] = 'application/json'
    const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      /* corpo não-JSON: mantém texto */
    }
    return { status: res.status, headers: res.headers, body: parsed as T, text }
  }

  return {
    baseUrl,
    request,
    get: <T = any>(p: string) => request<T>('GET', p),
    post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
    put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
    patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
    delete: <T = any>(p: string) => request<T>('DELETE', p),
  }
}

export type ApiClient = ReturnType<typeof createClient>

/** Confere o formato de erro da SPEC 3.4: `{ error: { code, message, details? } }`. */
export function expectApiError(res: ApiResponse, code: string, status: number) {
  expect(res.status, `HTTP esperado ${status}; corpo: ${res.text.slice(0, 300)}`).toBe(status)
  expect(res.body?.error?.code).toBe(code)
  expect(typeof res.body?.error?.message).toBe('string')
}

/** Espera até a URL responder (qualquer status HTTP). */
export async function waitForHttp(url: string, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  throw new Error(`timeout esperando ${url}: ${String(last)}`)
}
