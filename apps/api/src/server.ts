// Entrypoint HTTP: lê env, cria dependências reais e sobe o servidor.
import { serve } from '@hono/node-server'
import { createDb } from '@wsm/db'
import { Redis } from 'ioredis'
import { createApp } from './app'
import { loadConfig } from './config'
import { createLogger } from './logger'

const config = loadConfig()
const logger = createLogger({ level: config.LOG_LEVEL })
const db = createDb(config.DATABASE_URL)
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 })
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'))

const app = createApp({ db, redis, logger, apiToken: config.API_TOKEN })
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info({ port: info.port }, 'api listening')
})

let closing = false
async function shutdown(signal: string) {
  if (closing) return
  closing = true
  logger.info({ signal }, 'shutting down')
  server.close()
  await Promise.allSettled([db.$client.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
