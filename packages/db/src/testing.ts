import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { DEFAULT_DATABASE_URL, migrateUrl } from './client.js'

export interface TempDatabase {
  name: string
  url: string
  drop(): Promise<void>
}

export function randomDatabaseName(prefix = 'wsm_test'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

/** URL igual à base, trocando só o nome do banco. */
export function withDatabase(baseUrl: string, database: string): string {
  const u = new URL(baseUrl)
  u.pathname = `/${database}`
  return u.toString()
}

/**
 * Cria um banco descartável (CREATE DATABASE com nome aleatório), opcionalmente já migrado.
 * `drop()` encerra conexões remanescentes e remove o banco.
 */
export async function createTempDatabase(
  opts: { baseUrl?: string; migrate?: boolean; prefix?: string } = {},
): Promise<TempDatabase> {
  const baseUrl = opts.baseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const name = randomDatabaseName(opts.prefix)
  const url = withDatabase(baseUrl, name)
  await adminQuery(baseUrl, `CREATE DATABASE "${name}"`)
  if (opts.migrate) await migrateUrl(url)
  return {
    name,
    url,
    drop: () => adminQuery(baseUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  }
}

async function adminQuery(baseUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}
