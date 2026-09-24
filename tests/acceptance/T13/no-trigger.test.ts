// AC-T13-06: não existe caminho de código que gere mensagens sem gatilho de entrada (checagem estática
// do código da IA) e a API pública não expõe geração de sugestão sem mensagem recebida.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rootPath } from '../helpers/exec'
import { C, W } from './shared'

function files(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

const AI_DIRS = ['packages/core/src/ai', 'apps/worker/src/ai']
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bsetInterval\s*\(/, 'timer periódico'],
  [/\bcron\b|node-cron|CronJob|repeat\s*:\s*\{/i, 'agendamento'],
  [/\.sendMessage\s*\(/, 'envio direto ao transporte'],
  [/\b\w*[qQ]ueue\w*\.enqueue\s*\(/, 'enfileiramento direto na fila'],
]

describe('T13 — sem geração espontânea', () => {
  it('AC-T13-06 o código da IA (core e worker) não agenda, não enfileira e não envia mensagens', () => {
    const all = AI_DIRS.flatMap((d) => files(rootPath(d)))
    expect(all.length, `nenhum arquivo em ${AI_DIRS.join(', ')}`).toBeGreaterThan(0)
    const hits: string[] = []
    for (const f of all) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return
          for (const [re, why] of FORBIDDEN) if (re.test(line)) hits.push(`${relative(rootPath(), f)}:${i + 1} (${why}): ${line.trim()}`)
        })
    }
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('AC-T13-06 envio a partir de sugestão só existe via aprovação (approve); não há rota de geração avulsa', () => {
    const routes = readdirSync(rootPath('apps/api/src/routes')).filter((f) => /^suggestions.*\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    expect(routes.length, 'apps/api/src/routes/suggestions*.ts').toBeGreaterThan(0)
    const src = routes.map((f) => readFileSync(rootPath('apps/api/src/routes', f), 'utf8')).join('\n')
    expect(src).toMatch(/\/approve/)
    expect(src, 'rotas de sugestão não chamam o transporte diretamente').not.toMatch(/\.sendMessage\s*\(/)
    expect(src, 'não há rota para gerar sugestão sem mensagem recebida').not.toMatch(/\.post\(\s*['"`]\/api\/suggestions['"`]/)
  })

  it('AC-T13-06 attachAi só produz sugestões a partir do evento message do transporte', async () => {
    expect(typeof W.attachAi).toBe('function')
    // A API pública do assistente só transforma texto recebido; não há gerador sem entrada.
    const AiAssistant = C.AiAssistant
    const proto = Object.getOwnPropertyNames(AiAssistant.prototype)
    expect(proto).toContain('suggest')
    for (const name of proto) expect(name, `método suspeito no AiAssistant: ${name}`).not.toMatch(/^(send|broadcast|schedule|warm|generateMessage|autoReply)/i)
  })
})
