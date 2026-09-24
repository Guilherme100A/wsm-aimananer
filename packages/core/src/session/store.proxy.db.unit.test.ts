// T17: sessão com proxy inline (criação atômica) e edição (PATCH) sobre Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createDb, createTempDatabase, proxies, sessions, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { decryptProxyPassword, proxyConnectionUrl } from '../proxy/service'
import { ProxyService } from '../proxy/service'
import { SessionError, SessionStore } from './store'

let tmp: TempDatabase
let db: Database
let store: SessionStore
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_session_proxy' })
  db = createDb(tmp.url, { max: 4 })
  store = new SessionStore(db)
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(proxies)
})

const proxy = { protocol: 'socks5' as const, host: '10.0.0.5', port: 1080, username: 'u', password: 's3cr3t' }
const proxyRow = async (id: string | null) => (id ? (await db.select().from(proxies).where(eq(proxies.id, id)))[0] : undefined)

describe('create com proxy inline', () => {
  it('cria o proxy (senha cifrada) e a sessão vinculada', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy })
    const p = await proxyRow(s.proxyId)
    expect(p).toMatchObject({ protocol: 'socks5', host: '10.0.0.5', port: 1080, username: 'u' })
    expect(JSON.stringify(p)).not.toContain('s3cr3t')
    expect(decryptProxyPassword(p!)).toBe('s3cr3t')
    expect(proxyConnectionUrl(p!)).toBe('socks5://u:s3cr3t@10.0.0.5:1080')
    expect(s.requiresRestart).toBe(false)
  })

  it('proxy inválido ou junto com proxyId → VALIDATION_ERROR e nada gravado', async () => {
    await expect(store.create({ name: 'a', phone: '+5511999990001', proxy: { ...proxy, port: 0 } })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'proxy.port',
    })
    const other = await new ProxyService(db).create({ url: 'http://h:1' })
    await expect(store.create({ name: 'a', phone: '+5511999990001', proxy, proxyId: other.id })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'proxy',
    })
    expect(await db.select().from(sessions)).toHaveLength(0)
    expect(await db.select().from(proxies)).toHaveLength(1)
  })

  it('mesma transação: falha no INSERT da sessão desfaz o proxy', async () => {
    await db.execute(sql`create or replace function t17_fail() returns trigger as $$ begin raise exception 't17 forced failure'; end $$ language plpgsql`)
    await db.execute(sql`create trigger t17_fail_sessions before insert on sessions for each row execute function t17_fail()`)
    try {
      await expect(store.create({ name: 'a', phone: '+5511999990001', proxy })).rejects.toThrow()
      expect(await db.select().from(proxies)).toHaveLength(0)
    } finally {
      await db.execute(sql`drop trigger t17_fail_sessions on sessions`)
    }
  })

  it('sem proxy continua como antes', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001' })
    expect(s.proxyId).toBeNull()
  })
})

describe('updateDetails (PATCH)', () => {
  it('só nome/observação: requires_restart não muda', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy })
    const r = await store.updateDetails(s.id, { name: ' b ', note: 'n' })
    expect(r).toMatchObject({ proxyChanged: false, deletedProxyId: null, row: { name: 'b', note: 'n', requiresRestart: false, proxyId: s.proxyId } })
  })

  it('troca o proxy: novo proxy, antigo apagado, requires_restart; senha ausente mantém a atual', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy })
    const r = await store.updateDetails(s.id, { proxy: { protocol: 'http', host: '10.0.0.6', port: 3128, username: 'u' } })
    expect(r).toMatchObject({ proxyChanged: true, previousProxyId: s.proxyId, deletedProxyId: s.proxyId, row: { requiresRestart: true } })
    expect(r.row.proxyId).not.toBe(s.proxyId)
    expect(await proxyRow(s.proxyId)).toBeUndefined()
    const p = await proxyRow(r.row.proxyId)
    expect(proxyConnectionUrl(p!)).toBe('http://u:s3cr3t@10.0.0.6:3128')
  })

  it('password null remove; string troca; sem usuário a senha cai', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy })
    const r1 = await store.updateDetails(s.id, { proxy: { ...proxy, password: null } })
    expect(proxyConnectionUrl((await proxyRow(r1.row.proxyId))!)).toBe('socks5://u@10.0.0.5:1080')
    const r2 = await store.updateDetails(s.id, { proxy: { ...proxy, password: 'novo' } })
    expect(proxyConnectionUrl((await proxyRow(r2.row.proxyId))!)).toBe('socks5://u:novo@10.0.0.5:1080')
    const r3 = await store.updateDetails(s.id, { proxy: { protocol: 'socks5', host: '10.0.0.5', port: 1080 } })
    expect(proxyConnectionUrl((await proxyRow(r3.row.proxyId))!)).toBe('socks5://10.0.0.5:1080')
    expect(await db.select().from(proxies)).toHaveLength(1)
  })

  it('proxy idêntico (senha mantida) não é troca', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy })
    const r = await store.updateDetails(s.id, { proxy: { protocol: 'socks5', host: '10.0.0.5', port: 1080, username: 'u' } })
    expect(r).toMatchObject({ proxyChanged: false, row: { proxyId: s.proxyId, requiresRestart: false } })
  })

  it('remove o proxy (null) e adiciona a uma sessão sem proxy', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy })
    const r = await store.updateDetails(s.id, { proxy: null })
    expect(r).toMatchObject({ proxyChanged: true, deletedProxyId: s.proxyId, row: { proxyId: null, requiresRestart: true } })
    expect(await db.select().from(proxies)).toHaveLength(0)
    const plain = await store.create({ name: 'b', phone: '+5511999990002' })
    const r2 = await store.updateDetails(plain.id, { proxy })
    expect(r2).toMatchObject({ proxyChanged: true, previousProxyId: null, deletedProxyId: null, row: { requiresRestart: true } })
    expect((await store.updateDetails(plain.id, { proxy: null })).proxyChanged).toBe(true)
    expect((await store.updateDetails(plain.id, { proxy: null })).proxyChanged).toBe(false)
  })

  it('proxy inválido → nada muda; inexistente → SESSION_NOT_FOUND', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy })
    await expect(store.updateDetails(s.id, { name: 'x', proxy: { ...proxy, host: '' } })).rejects.toBeInstanceOf(SessionError)
    expect(await store.get(s.id)).toMatchObject({ name: 'a', proxyId: s.proxyId })
    await expect(store.updateDetails('00000000-0000-4000-8000-000000000000', { name: 'x' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await expect(store.updateDetails('nope', { name: 'x' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
