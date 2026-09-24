import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cryptoApi, envelopeBytes, loadCoreWithKey, newKey, preserveKeyEnv, tamper, toBytes, type Part } from './shared'

let restoreEnv: () => void
let api: ReturnType<typeof cryptoApi>

beforeAll(async () => {
  restoreEnv = preserveKeyEnv()
  api = cryptoApi(await loadCoreWithKey(newKey()))
})

afterAll(() => restoreEnv())

const bytesEqual = (a: unknown, b: Uint8Array) => a instanceof Uint8Array && Buffer.from(a).equals(Buffer.from(b))

describe('T02 — encrypt/decrypt (AES-256-GCM)', () => {
  const strings: Array<[string, string]> = [
    ['ASCII', 'credencial-de-teste-123'],
    ['unicode/emoji', 'ção ñ 日本語 🔐 \u0000 fim'],
    ['JSON de creds', JSON.stringify({ noiseKey: { private: 'abc', public: 'def' }, registrationId: 1234 })],
    ['texto longo (256 KiB)', 'x'.repeat(256 * 1024)],
  ]

  it.each(strings)('AC-T02-01 decrypt(encrypt(x)) === x para string (%s)', async (_label, x) => {
    const out = await api.decrypt(await api.encrypt(x))
    expect(typeof out).toBe('string')
    expect(out).toBe(x)
  })

  const buffers: Array<[string, Buffer]> = [
    ['1 byte', Buffer.from([0x7f])],
    ['32 bytes aleatórios', randomBytes(32)],
    ['64 KiB aleatórios', randomBytes(64 * 1024)],
    ['bytes nulos', Buffer.alloc(100)],
  ]

  it.each(buffers)('AC-T02-01 decrypt(encrypt(x)) devolve os mesmos bytes para Buffer (%s)', async (_label, x) => {
    const out = await api.decrypt(await api.encrypt(x))
    expect(out, 'decrypt de Buffer deve devolver bytes (Buffer/Uint8Array)').toBeInstanceOf(Uint8Array)
    expect(bytesEqual(out, x)).toBe(true)
  })

  it('AC-T02-01 o texto cifrado não contém o texto puro e o IV muda a cada chamada', async () => {
    const secret = `segredo-${randomBytes(8).toString('hex')}`
    const a = await api.encrypt(secret)
    const b = await api.encrypt(secret)
    for (const bytes of envelopeBytes(a)) expect(bytes.includes(Buffer.from(secret)), 'texto puro visível no envelope').toBe(false)
    expect(JSON.stringify(a)).not.toContain(secret)
    // AES-GCM com IV repetido é inseguro: duas cifragens do mesmo valor não podem coincidir.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('AC-T02-01 a chave vem de CREDENTIALS_KEY: outra chave não decifra', async () => {
    const coreA = cryptoApi(await loadCoreWithKey(newKey()))
    const envelope = await coreA.encrypt('valor cifrado com a chave A')
    const coreB = cryptoApi(await loadCoreWithKey(newKey()))
    await expect(Promise.resolve().then(() => coreB.decrypt(envelope))).rejects.toThrow()
  })

  it('AC-T02-01 a mesma CREDENTIALS_KEY decifra após reinicializar o módulo', async () => {
    const key = newKey()
    const envelope = await cryptoApi(await loadCoreWithKey(key)).encrypt('sobrevive ao restart')
    const again = cryptoApi(await loadCoreWithKey(key))
    expect(await again.decrypt(envelope)).toBe('sobrevive ao restart')
  })

  const badKeys: Array<[string, string | undefined]> = [
    ['ausente', undefined],
    ['vazia', ''],
    ['16 bytes (curta)', randomBytes(16).toString('base64')],
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['64 bytes (longa)', randomBytes(64).toString('base64')],
    ['não é base64', 'isto não é uma chave base64 válida!!!'],
  ]

  it.each(badKeys)('AC-T02-01 CREDENTIALS_KEY %s lança erro na inicialização', async (_label, key) => {
    // "Inicialização" = carregar o módulo ou o primeiro uso da cripto; nenhum dos dois pode cifrar.
    const attempt = async () => {
      const { encrypt } = cryptoApi(await loadCoreWithKey(key))
      return encrypt('não deveria cifrar')
    }
    await expect(attempt()).rejects.toThrow()
  })
})

describe('T02 — detecção de adulteração', () => {
  const parts: Part[] = ['ciphertext', 'iv', 'authTag']

  it.each(parts)('AC-T02-02 %s adulterado faz decrypt lançar erro', async (part) => {
    const envelope = await api.encrypt('conteúdo íntegro de credencial')
    const bad = tamper(envelope, part)
    let result: unknown
    await expect(
      Promise.resolve()
        .then(() => api.decrypt(bad))
        .then((r) => (result = r)),
      `decrypt devolveu ${JSON.stringify(result)}`,
    ).rejects.toThrow()
  })

  it.each(parts)('AC-T02-02 %s adulterado em Buffer também lança erro', async (part) => {
    const envelope = await api.encrypt(randomBytes(48))
    await expect(Promise.resolve().then(() => api.decrypt(tamper(envelope, part)))).rejects.toThrow()
  })

  it('AC-T02-02 auth tag truncado lança erro (tag curta não é aceita)', async () => {
    const envelope = await api.encrypt('tag precisa ter o tamanho completo')
    expect(envelope && typeof envelope === 'object' && !(envelope instanceof Uint8Array), 'encrypt deve devolver um envelope { ciphertext, iv, authTag }').toBe(true)
    const e = { ...(envelope as Record<string, unknown>) }
    const key = Object.keys(e).find((k) => /^(auth_?tag|tag)$/i.test(k))!
    const { bytes, back } = toBytes(e[key])
    e[key] = back(bytes.subarray(0, 4))
    await expect(Promise.resolve().then(() => api.decrypt(e))).rejects.toThrow()
  })

  it('AC-T02-02 IV de outra cifragem lança erro', async () => {
    const a = (await api.encrypt('mensagem A')) as Record<string, unknown>
    const b = (await api.encrypt('mensagem B')) as Record<string, unknown>
    const ivKey = Object.keys(a).find((k) => /^(iv|nonce)$/i.test(k))
    expect(ivKey, 'envelope sem campo iv').toBeTruthy()
    await expect(Promise.resolve().then(() => api.decrypt({ ...a, [ivKey!]: b[ivKey!] }))).rejects.toThrow()
  })
})
