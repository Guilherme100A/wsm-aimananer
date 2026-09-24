import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { REDACTED, createLogger, isSensitiveLogKey, redactSecrets } from './index'

function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk))
      cb()
    },
  })
  const logger = createLogger({ level: 'info', destination: stream })
  return { logger, output: () => lines.join('') }
}

const SECRET = 'MARCADOR-VAZAMENTO-123'

describe('logger com redação', () => {
  it.each(['creds', 'keys', 'noiseKey', 'signedIdentityKey'])('redige %s no topo, aninhado e em child', (field) => {
    const { logger, output } = capture()
    logger.info({ [field]: SECRET }, 'topo')
    logger.info({ [field]: { private: SECRET, nested: { deep: SECRET } } }, 'objeto')
    logger.warn({ session: { [field]: { private: SECRET } } }, 'aninhado')
    const child = logger.child({ component: 'x' })
    child.error({ [field]: SECRET }, 'child')
    logger.child({ [field]: SECRET }).info('binding')
    expect(output()).not.toContain(SECRET)
    expect(output()).toContain(REDACTED)
    expect(output().split('\n').filter(Boolean)).toHaveLength(5)
  })

  it('mantém campos não sensíveis e não altera o objeto original', () => {
    const { logger, output } = capture()
    const obj = { sessionId: 's-1', creds: { me: { id: 'x' } } }
    logger.info(obj, 'msg')
    const line = JSON.parse(output()) as Record<string, unknown>
    expect(line).toMatchObject({ sessionId: 's-1', creds: REDACTED, msg: 'msg' })
    expect(obj.creds).toEqual({ me: { id: 'x' } })
  })

  it('preserva erros (serializer err) e lida com ciclos', () => {
    const { logger, output } = capture()
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    logger.error({ err: new Error('falhou'), cyc }, 'erro')
    const line = JSON.parse(output()) as { err: { message: string; stack: string }; cyc: { self: string } }
    expect(line.err.message).toBe('falhou')
    expect(line.err.stack).toContain('falhou')
    expect(line.cyc.self).toBe('[Circular]')
  })
})

describe('redactSecrets', () => {
  it('chaves com variação de caixa/separador', () => {
    expect(isSensitiveLogKey('signed_identity_key')).toBe(true)
    expect(isSensitiveLogKey('API_TOKEN')).toBe(true)
    expect(isSensitiveLogKey('sessionId')).toBe(false)
    expect(redactSecrets({ list: [{ noiseKey: 1 }], ok: 2 })).toEqual({ list: [{ noiseKey: REDACTED }], ok: 2 })
  })
})
