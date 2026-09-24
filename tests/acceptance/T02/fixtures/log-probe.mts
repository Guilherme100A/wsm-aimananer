// Processo filho do AC-T02-05: carrega o logger compartilhado do @wsm/core e loga os casos recebidos.
// Uso: node --import tsx log-probe.mts <arquivo-json-com-casos>
// Cada caso: { id, level, child, payload } → logger[level](payload, `probe:<id>`)
import { readFileSync } from 'node:fs'

const core: Record<string, any> = await import(new URL('../../../../packages/core/src/index.ts', import.meta.url).href)

const logger = core.logger ?? (typeof core.createLogger === 'function' ? core.createLogger() : undefined)
if (!logger || typeof logger.info !== 'function') {
  process.stderr.write('PROBE-ERROR: @wsm/core não exporta logger (nem createLogger)\n')
  process.exit(3)
}

const cases = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Array<{ id: string; level: string; child: boolean; payload: unknown }>
for (const c of cases) {
  const target = c.child ? logger.child({ component: 'probe' }) : logger
  target[c.level](c.payload, `probe:${c.id}`)
}
logger.flush?.()
await new Promise((r) => setTimeout(r, 300))
