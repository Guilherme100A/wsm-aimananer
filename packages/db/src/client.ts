import { fileURLToPath } from 'node:url'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from './schema/index.js'

export type Schema = typeof schema
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool }

export const DEFAULT_DATABASE_URL = 'postgres://wsm:wsm@localhost:5432/wsm'

// src/ e dist/ são irmãos de drizzle/, então o caminho relativo vale nos dois.
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

// Chave arbitrária do advisory lock que serializa migrations concorrentes (api + worker no boot).
const MIGRATION_LOCK_KEY = 7_345_001

export interface CreateDbOptions {
  max?: number
}

/** Cria o client Drizzle (node-postgres). `db.$client` é o Pool; feche com `db.$client.end()`. */
export function createDb(url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, opts: CreateDbOptions = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 })
  return drizzle(pool, { schema }) as Database
}

/** Aplica as migrations pendentes. Idempotente: migrations já aplicadas são ignoradas. */
export async function runMigrations(db: Database, migrationsFolder: string = MIGRATIONS_FOLDER): Promise<void> {
  const client = await db.$client.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      await migrate(drizzle(client), { migrationsFolder })
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

/** Conveniência: conecta, migra e fecha. */
export async function migrateUrl(url: string, migrationsFolder?: string): Promise<void> {
  const db = createDb(url, { max: 1 })
  try {
    await runMigrations(db, migrationsFolder)
  } finally {
    await db.$client.end()
  }
}
