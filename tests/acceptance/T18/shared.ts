// Harness do T18: o mesmo do T12 (API em processo + SessionManager com FakeTransport + build do dashboard
// na mesma origem + chromium headless), com login admin/nimda (defaults do AC-T17-01).
// Contrato de UI combinado com o Operário (Cinzel):
//   login: login-username ('Usuário'), login-password ('Senha'), login-submit, login-error; token em sessionStorage 'wsm.token';
//          nav-logout → POST /api/auth/logout; qualquer 401 → #/login.
//   nav:   sem nav-proxies; #/proxies → #/sessions.
//   novo:  new-name, new-phone, bloco 'Proxy' (new-proxy-protocol|host|port|username|password), new-note, gen-qr, gen-pairing;
//          validação no cliente em new-proxy-error (sem POST); erros da API em auth-error.
//   lista: session-proxy em cada session-row ('host:port' ou '—').
//   detalhe: detail-proxy ('protocol://user:***@host:port' ou 'Sem proxy'), proxy-edit → edit-proxy-* + proxy-save/proxy-cancel/
//          proxy-remove, proxy-error, proxy-restart-warning ('Exige restart da sessão para aplicar o novo proxy.').
import { randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { api, randomPhone, type DCtx } from '../T12/shared'

export * from '../T12/shared'

export interface InlineProxy {
  protocol?: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

/** Cria a sessão pela API com proxy inline (AC-T17-03). */
export async function createSessionWithProxy(ctx: DCtx, proxy: InlineProxy | null, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = { name: `t18-${randomBytes(3).toString('hex')}`, phone: randomPhone(), ...extra }
  if (proxy) body.proxy = { protocol: 'http', ...proxy }
  const res = await api(ctx, 'POST', '/api/sessions', body)
  expect(res.status, `POST /api/sessions → ${res.text}`).toBe(201)
  return res.body as Record<string, any>
}

export async function getSession(ctx: DCtx, id: string) {
  const res = await api(ctx, 'GET', `/api/sessions/${id}`)
  expect(res.status, res.text).toBe(200)
  return res.body as Record<string, any>
}

export async function findSessionByName(ctx: DCtx, name: string): Promise<string> {
  let id = ''
  await expect
    .poll(
      async () => {
        const list = await api(ctx, 'GET', '/api/sessions')
        const items: any[] = Array.isArray(list.body) ? list.body : (list.body?.items ?? [])
        id = items.find((s) => s.name === name)?.id ?? ''
        return id
      },
      { timeout: 10_000, message: `sessão ${name} não criada pela UI` },
    )
    .not.toBe('')
  return id
}

export interface SeenRequest {
  method: string
  url: string
  path: string
  body: any
  authorization?: string
}

/** Registra as requisições /api/* feitas pela página. */
export function recordApiRequests(page: any): SeenRequest[] {
  const seen: SeenRequest[] = []
  page.on('request', (req: any) => {
    const url = new URL(req.url())
    if (!url.pathname.startsWith('/api/')) return
    let body: any = req.postData()
    try {
      body = body ? JSON.parse(body) : undefined
    } catch {
      /* corpo não-JSON */
    }
    seen.push({ method: req.method(), url: req.url(), path: url.pathname, body, authorization: req.headers()['authorization'] })
  })
  return seen
}

export const randomSecret = (prefix = 'pw') => `${prefix}${randomBytes(6).toString('hex')}`
