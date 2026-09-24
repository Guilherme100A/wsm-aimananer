// Configuração do servidor a partir do ambiente (SPEC 3.5).
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
})

export type ApiConfig = z.output<typeof schema>

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`invalid API configuration: ${fields}`)
  }
  return parsed.data
}
