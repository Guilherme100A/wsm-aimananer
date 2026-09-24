// Servidor HTTP mínimo do worker: GET /health (healthcheck do compose) e GET /metrics (Prometheus).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WsmMetrics } from '@wsm/core'

export const DEFAULT_WORKER_OBSERVABILITY_PORT = 9464

export interface ObservabilityServerOptions {
  /** Porta (0 = aleatória; `url` reflete a porta real). Default: WORKER_HEALTH_PORT ou 9464. */
  port?: number
  host?: string
  metrics?: WsmMetrics
  /** Verificação de saúde; false ou erro → 503. Default: sempre saudável. */
  check?: () => boolean | Promise<boolean>
}

export interface ObservabilityServer {
  url: string
  port: number
  close(): Promise<void>
}

export async function startObservabilityServer(opts: ObservabilityServerOptions = {}): Promise<ObservabilityServer> {
  const port = opts.port ?? Number(process.env.WORKER_HEALTH_PORT ?? DEFAULT_WORKER_OBSERVABILITY_PORT)
  const host = opts.host ?? '0.0.0.0'
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (path === '/health') {
      void (async () => {
        const ok = await (async () => (opts.check ? opts.check() : true))().catch(() => false)
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'down' }))
      })()
      return
    }
    if (path === '/metrics' && opts.metrics) {
      const metrics = opts.metrics
      metrics
        .render()
        .then((body) => res.writeHead(200, { 'content-type': metrics.contentType }).end(body))
        .catch(() => res.writeHead(500).end())
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const actual = (server.address() as AddressInfo).port
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    url: `http://${urlHost}:${actual}`,
    port: actual,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
