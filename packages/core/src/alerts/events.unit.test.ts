import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { ALERT_EVENTS, alertBody, formatAlertText, isAlertEventType, signPayload, signWebhookBody } from './events'
import { decryptWebhookSecret, encryptWebhookSecret } from './secret'
import { maskUrl, validateWebhook, WebhookError } from './webhooks'

const prevKey = process.env.CREDENTIALS_KEY
beforeAll(() => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
})
afterAll(() => {
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

const at = new Date('2026-01-01T00:00:00Z')

describe('eventos e assinatura', () => {
  it('eventos alertáveis do AC-T11-01', () => {
    expect([...ALERT_EVENTS].sort()).toEqual(
      ['disconnected', 'error_burst', 'forbidden_403', 'health_degraded', 'proxy_unavailable', 'warmup_paused'].sort(),
    )
    expect(isAlertEventType('forbidden_403')).toBe(true)
    expect(isAlertEventType('nope')).toBe(false)
  })

  it('signWebhookBody = HMAC-SHA256 hex do body cru', () => {
    const body = alertBody({ type: 'forbidden_403', sessionId: 's1', at })
    expect(JSON.parse(body)).toEqual({ event: 'forbidden_403', sessionId: 's1', at: at.toISOString(), detail: {} })
    const expected = createHmac('sha256', 'k3y').update(body).digest('hex')
    expect(signWebhookBody(body, 'k3y')).toBe(expected)
    expect(signPayload).toBe(signWebhookBody)
    expect(signWebhookBody(body, 'other')).not.toBe(expected)
  })

  it('texto do alerta contém evento e sessão', () => {
    const text = formatAlertText({ type: 'disconnected', sessionId: 'abc', at, detail: { reason: 'transient' } })
    expect(text).toContain('disconnected')
    expect(text).toContain('abc')
    expect(text).toContain('transient')
  })
})

describe('segredo do webhook', () => {
  it('cifra sem texto claro e decifra só com o mesmo id', () => {
    const stored = encryptWebhookSecret('w1', 'super-secret-token')
    expect(stored).toMatch(/^enc:v1:/)
    expect(stored).not.toContain('super-secret-token')
    expect(Buffer.from(stored.split(':')[4]!, 'base64').toString()).not.toContain('super-secret-token')
    expect(decryptWebhookSecret('w1', stored)).toBe('super-secret-token')
    expect(() => decryptWebhookSecret('w2', stored)).toThrow()
    expect(() => decryptWebhookSecret('w1', 'plain')).toThrow()
  })
})

describe('validação de webhook', () => {
  const ok = { config: {}, events: [], hasSecret: true }
  it.each([
    [{ channel: 'http' as const, url: 'http://x/h', ...ok }, null],
    [{ channel: 'http' as const, url: 'http://x/h', ...ok, hasSecret: false }, 'secret'],
    [{ channel: 'http' as const, url: 'ftp://x', ...ok }, 'url'],
    [{ channel: 'discord' as const, url: 'not a url', ...ok }, 'url'],
    [{ channel: 'discord' as const, url: 'https://discord/x', ...ok, hasSecret: false }, null],
    [{ channel: 'telegram' as const, url: 'https://api.telegram.org', ...ok }, 'config.chatId'],
    [{ channel: 'telegram' as const, url: 'https://api.telegram.org', ...ok, config: { chatId: 1 } }, null],
    [{ channel: 'email' as const, url: 'smtp://h:25', ...ok }, 'config.to'],
    [{ channel: 'email' as const, url: '', ...ok, config: { to: 'a@b' } }, null],
    [{ channel: 'email' as const, url: 'http://h', ...ok, config: { to: 'a@b' } }, 'url'],
    [{ channel: 'http' as const, url: 'http://x', ...ok, events: ['nope'] }, 'events'],
  ])('%o → %s', (w, path) => {
    if (path === null) expect(() => validateWebhook(w)).not.toThrow()
    else {
      const err = (() => {
        try {
          validateWebhook(w)
        } catch (e) {
          return e
        }
      })()
      expect(err).toBeInstanceOf(WebhookError)
      expect((err as WebhookError).path).toBe(path)
    }
  })

  it('maskUrl esconde a senha', () => {
    expect(maskUrl('smtp://u:p4ss@h:25')).toBe('smtp://u:***@h:25')
    expect(maskUrl('https://x/y')).toBe('https://x/y')
  })
})
