import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiRequestError, api, setFetch } from './api'
import { getToken, setToken } from './auth'
import { loginErrorMessage } from './login'
import { emptyProxyForm, parseProxyForm, proxyAddress, proxyFormFrom, proxyLabel, type ProxyFormValues } from './proxy-form'
import { signOut } from './signout'
import type { SessionProxy } from './types'

const form = (v: Partial<ProxyFormValues>): ProxyFormValues => ({ ...emptyProxyForm(), ...v })

describe('parseProxyForm (AC-T18-02)', () => {
  it('bloco vazio → sem proxy', () => {
    expect(parseProxyForm(emptyProxyForm())).toEqual({ ok: true, proxy: null })
    expect(parseProxyForm(form({ host: '  ', protocol: 'socks5' }))).toEqual({ ok: true, proxy: null })
  })

  it('proxy completo vira o payload do T17 (porta numérica, sem campos vazios)', () => {
    expect(parseProxyForm(form({ protocol: 'socks5', host: ' 10.1.2.3 ', port: '1080', username: 'u', password: 'p@ss' }))).toEqual({
      ok: true,
      proxy: { protocol: 'socks5', host: '10.1.2.3', port: 1080, username: 'u', password: 'p@ss' },
    })
    expect(parseProxyForm(form({ host: 'proxy.example.com', port: '8080' }))).toEqual({
      ok: true,
      proxy: { protocol: 'http', host: 'proxy.example.com', port: 8080 },
    })
  })

  it.each([
    [{ host: '10.0.0.1' }, /porta/i],
    [{ port: '8080' }, /host/i],
    [{ host: '10.0.0.1', port: '0' }, /1 e 65535/],
    [{ host: '10.0.0.1', port: '70000' }, /1 e 65535/],
    [{ host: '10.0.0.1', port: '80a' }, /1 e 65535/],
    [{ username: 'u' }, /host/i],
    [{ password: 'p' }, /host/i],
    [{ host: '10.0.0.1', port: '80', password: 'p' }, /usuário/i],
    [{ host: 'bad host!', port: '80' }, /inválido/i],
  ])('proxy incompleto/inválido %o → erro no cliente', (v, msg) => {
    const r = parseProxyForm(form(v))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(msg)
  })

  it('edição: senha em branco é omitida (mantém a atual); preenchida troca', () => {
    const r = parseProxyForm(form({ host: 'h', port: '1', username: 'u' }), { keepPassword: true })
    expect(r).toEqual({ ok: true, proxy: { protocol: 'http', host: 'h', port: 1, username: 'u' } })
    expect(r.ok && r.proxy && 'password' in r.proxy).toBe(false)
    expect(parseProxyForm(form({ host: 'h', port: '1', username: 'u', password: 'n' }), { keepPassword: true })).toMatchObject({ proxy: { password: 'n' } })
  })
})

describe('exibição do proxy (AC-T18-03)', () => {
  const p: SessionProxy = { id: 'x', protocol: 'http', host: '10.1.2.3', port: 8080, username: 'user', hasPassword: true }

  it('lista: host:port ou —', () => {
    expect(proxyAddress(p)).toBe('10.1.2.3:8080')
    expect(proxyAddress(null)).toBe('—')
    expect(proxyAddress(undefined)).toBe('—')
  })

  it('detalhe: senha sempre mascarada', () => {
    expect(proxyLabel(p)).toBe('http://user:***@10.1.2.3:8080')
    expect(proxyLabel({ ...p, hasPassword: false })).toBe('http://user@10.1.2.3:8080')
    expect(proxyLabel({ ...p, username: null, hasPassword: false, protocol: 'socks5' })).toBe('socks5://10.1.2.3:8080')
    expect(proxyLabel(null)).toBe('Sem proxy')
  })

  it('formulário de edição parte do proxy atual, sem senha', () => {
    expect(proxyFormFrom(p)).toEqual({ protocol: 'http', host: '10.1.2.3', port: '8080', username: 'user', password: '' })
    expect(proxyFormFrom(null)).toEqual(emptyProxyForm())
  })
})

describe('login e saída (AC-T18-01)', () => {
  it('mensagens de erro do login', () => {
    expect(loginErrorMessage(new ApiRequestError(401, 'UNAUTHORIZED', 'invalid username or password'))).toBe('Usuário ou senha inválidos')
    expect(loginErrorMessage(new ApiRequestError(429, 'RATE_LIMIT', 'x'))).toMatch(/Muitas tentativas/)
    expect(loginErrorMessage(new Error('rede'))).toBe('rede')
  })

  describe('signOut', () => {
    let calls: Array<{ url: string; init?: RequestInit }>
    let status = 204
    const store = new Map<string, string>()
    beforeEach(() => {
      calls = []
      status = 204
      store.clear()
      Object.assign(globalThis, {
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      })
      setFetch(async (url, init) => {
        calls.push({ url, init })
        return new Response(status === 204 ? null : JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'x' } }), { status })
      })
    })
    afterEach(() => setFetch((input, init) => globalThis.fetch(input, init)))

    it('chama POST /api/auth/logout com o token e limpa o token', async () => {
      setToken('tok')
      await signOut()
      expect(calls[0]).toMatchObject({ url: '/api/auth/logout', init: { method: 'POST' } })
      expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
      expect(getToken()).toBeNull()
      expect(store.has('wsm.token')).toBe(false)
    })

    it('falha da API não impede sair', async () => {
      setToken('tok')
      status = 401
      await signOut()
      expect(getToken()).toBeNull()
    })
  })

  it('api.updateSession manda PATCH com o proxy inline', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    setFetch(async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 's1' }), { status: 200 })
    })
    await api.updateSession('s1', { proxy: null })
    expect(calls[0]).toMatchObject({ url: '/api/sessions/s1', init: { method: 'PATCH' } })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ proxy: null })
    setFetch((input, init) => globalThis.fetch(input, init))
  })
})
