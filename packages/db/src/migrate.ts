// CLI: `pnpm --filter @wsm/db migrate` (usa DATABASE_URL).
import { DEFAULT_DATABASE_URL, migrateUrl } from './client.js'

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL

try {
  await migrateUrl(url)
  process.stdout.write('migrations aplicadas\n')
} catch (err) {
  process.stderr.write(`falha nas migrations: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
}
