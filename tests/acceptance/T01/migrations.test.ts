import { afterAll, describe, expect, it } from 'vitest'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, migrate, tableNames, type TempDb } from '../helpers/pg'
import { REQUIRED_TABLES, useMigratedDb } from './shared'

describe('T01 — migrations', () => {
  const ctx = useMigratedDb()

  it('AC-T01-01 migrations criam as tabelas sessions, session_credentials, proxies, contacts, messages, message_events, health_events, webhooks e audit_logs', () => {
    const tables = tableNames(ctx.db.url)
    for (const t of REQUIRED_TABLES) expect(tables, `tabela ${t} ausente; existentes: ${tables.join(', ')}`).toContain(t)
  })
})

describe('T01 — idempotência das migrations', () => {
  let db: TempDb | undefined
  afterAll(() => dropTempDb(db))

  it('AC-T01-04 rodar as migrations duas vezes seguidas num banco vazio termina sem erro', () => {
    db = createTempDb()
    expect(tableNames(db.url)).toEqual([])

    const first = migrate(db)
    expect(first.code, tail(first)).toBe(0)
    const afterFirst = tableNames(db.url)

    const second = migrate(db)
    expect(second.code, tail(second)).toBe(0)
    const afterSecond = tableNames(db.url)

    expect(afterSecond).toEqual(afterFirst)
    for (const t of REQUIRED_TABLES) expect(afterSecond).toContain(t)
  })
})
