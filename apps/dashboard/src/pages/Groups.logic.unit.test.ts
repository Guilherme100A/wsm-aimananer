import { afterEach, describe, expect, it } from 'vitest'
import { ApiRequestError, setFetch } from '../lib/api'
import type { Session } from '../lib/types'
import { confirmText, groupsAddApi, resultFromError, resultText, targetOptions } from './Groups.logic'

afterEach(() => setFetch((input, init) => globalThis.fetch(input, init)))

const s = (id: string, name: string, phone: string) => ({ id, name, phone }) as Session

describe('Grupos — adicionar número (lógica)', () => {
  it('alvos: todas as sessões menos a própria; texto de confirmação', () => {
    const list = [s('a', 'Admin', '+551'), s('b', 'Vendas', '+552'), s('c', 'Suporte', '+553')]
    expect(targetOptions(list, 'a').map((x) => x.id)).toEqual(['b', 'c'])
    expect(confirmText(list[1]!, { id: 'g@g.us', name: 'Clientes' })).toBe('Adicionar Vendas (+552) ao grupo Clientes?')
  })

  it('resultados da API → textos da tela', () => {
    expect(resultFromError(new ApiRequestError(403, 'NOT_GROUP_ADMIN', 'x'))).toBe('not_admin')
    expect(resultFromError(new ApiRequestError(429, 'RATE_LIMIT', 'x'))).toBe('rate_limited')
    expect(resultFromError(new ApiRequestError(404, 'GROUP_NOT_FOUND', 'x'))).toBe('group_not_found')
    expect(resultFromError(new Error('x'))).toBe('error')
    expect(resultText('added')).toMatch(/adicionado/i)
    expect(resultText('already_member')).toMatch(/já é membro/i)
    expect(resultText('not_admin')).toMatch(/não é admin/i)
    expect(resultText('rate_limited')).toMatch(/limite/i)
  })

  it('POST com UM alvo', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    setFetch(async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ result: 'added', groupId: 'g', targetSessionId: 't', jid: 'j' }), { status: 200 })
    })
    expect(await groupsAddApi.add('s1', '120@g.us', 't')).toMatchObject({ result: 'added' })
    expect(calls).toEqual([{ url: '/api/sessions/s1/groups/120%40g.us/participants', body: { targetSessionId: 't' } }])
  })
})
