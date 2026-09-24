// Factories de dados de teste. Nada aqui representa pessoa ou número real.
import { randomBytes, randomUUID } from 'node:crypto'

let seq = 0

export const uniqueId = (prefix = 'test') => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}-${randomBytes(3).toString('hex')}`

/** Telefone fictício E.164 (faixa 5599900xxxxxx, não atribuída a pessoas reais nos testes). */
export const fakePhone = () => `55999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

/** JID fictício do WhatsApp a partir de um telefone. */
export const fakeJid = (phone = fakePhone()) => `${phone}@s.whatsapp.net`

/** Chave de 32 bytes em base64 (formato de CREDENTIALS_KEY, SPEC 3.5). */
export const credentialsKey = () => randomBytes(32).toString('base64')

export const uuid = () => randomUUID()

export const buildSession = (overrides: Record<string, unknown> = {}) => ({
  name: uniqueId('session'),
  ...overrides,
})

export const buildContact = (overrides: Record<string, unknown> = {}) => ({
  phone: fakePhone(),
  name: uniqueId('contact'),
  ...overrides,
})

export const buildProxy = (overrides: Record<string, unknown> = {}) => ({
  url: `socks5://user:pass@127.0.0.1:${10000 + Math.floor(Math.random() * 50000)}`,
  ...overrides,
})

export const buildMessage = (overrides: Record<string, unknown> = {}) => ({
  to: fakePhone(),
  text: `mensagem de teste ${uniqueId('msg')}`,
  ...overrides,
})
