// Entrypoint do processo worker (Dockerfile: node dist/main.js). Lê o ambiente, sobe tudo e trata SIGTERM/SIGINT.
import { createWorkerLogger } from './observability'
import { startWorker } from './boot'

const logger = createWorkerLogger()

async function main() {
  const worker = await startWorker({ logger })
  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    logger.info({ signal }, 'worker shutting down')
    worker
      .stop()
      .then(() => {
        logger.info({ signal }, 'worker stopped')
        process.exit(0)
      })
      .catch((err: unknown) => {
        logger.error({ err: String(err) }, 'worker shutdown failed')
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? { message: err.message, name: err.name } : String(err) }, 'worker failed to start')
  process.exit(1)
})
