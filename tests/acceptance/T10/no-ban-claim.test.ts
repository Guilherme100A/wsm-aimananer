// AC-T10-05: nenhum texto em apps/** ou packages/** promete imunidade a ban (SPEC 1.4 #6).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rootPath } from '../helpers/exec'
import { api, connectedSession, createSession, useHealth } from './shared'

/** Frases proibidas + variações comuns em PT/EN. */
const RULE = /(imune\s+a\s+ban|immune\s+to\s+ban|seguro\s+contra\s+(o\s+)?ban|ban[\s-]?proof|[àa]\s+prova\s+de\s+ban|anti-?ban\s+garantido|nunca\s+(ser[áa]\s+)?banid|never\s+(get\s+)?banned)/i
const EXTRA = /(garant\w*\s+(que\s+)?(n[ãa]o\s+)?(ser[áa]\s+)?(contra\s+)?ban|100%\s+(seguro|safe)|zero\s+(risk|risco)\s+(of|de)\s+ban|ban[\s-]?free|livre\s+de\s+ban|evita\s+ban\s+(com\s+)?certeza|prevents?\s+bans?\s+completely)/i
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.md', '.json', '.html', '.css']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage'])

function walk(dir: string, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out)
    } else if (EXTS.some((x) => e.name.endsWith(x)) && !/\.test\.tsx?$/.test(e.name)) out.push(join(dir, e.name))
  }
  return out
}

function offenders(text: string, file: string): string[] {
  const hits: string[] = []
  text.split('\n').forEach((line, i) => {
    if (RULE.test(line) || EXTRA.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`)
  })
  return hits
}

describe('T10 — sem promessa de imunidade a ban', () => {
  it('AC-T10-05 a regra detecta as frases proibidas (sanidade do scanner)', () => {
    for (const s of ['Seguro contra ban', 'imune a ban', 'ban-proof', 'anti-ban garantido', 'never get banned', '100% seguro', 'à prova de ban'])
      expect(RULE.test(s) || EXTRA.test(s), s).toBe(true)
    for (const s of ['Health Score é apenas um indicador operacional', 'reduz o risco, sem garantias', 'baileys-antiban']) expect(RULE.test(s) || EXTRA.test(s), s).toBe(false)
  })

  it('AC-T10-05 nenhum arquivo de apps/** ou packages/** promete imunidade a ban', () => {
    const files = [...walk(rootPath('apps')), ...walk(rootPath('packages'))]
    expect(files.length, 'nenhum arquivo encontrado em apps/ e packages/').toBeGreaterThan(10)
    const hits = files.flatMap((f) => offenders(readFileSync(f, 'utf8'), relative(rootPath(), f)))
    expect(hits, `promessas de imunidade a ban:\n${hits.join('\n')}`).toEqual([])
  })

  describe('respostas e alertas em execução', () => {
    const ctx = useHealth()

    it('AC-T10-05 respostas de health e eventos de alerta não prometem imunidade a ban', async () => {
      const { id, transport } = await connectedSession(ctx)
      const s = await createSession(ctx)
      const texts = [
        (await api(ctx, 'GET', `/api/sessions/${id}/health`)).text,
        (await api(ctx, 'GET', `/api/sessions/${s.id}/health`)).text,
        (await api(ctx, 'GET', `/api/sessions/${id}`)).text,
      ]
      await transport.close('forbidden', 403)
      await expect.poll(() => ctx.alerts.some((a) => a.sessionId === id), { timeout: 5_000 }).toBe(true)
      texts.push(JSON.stringify(ctx.alerts))
      for (const t of texts) expect(offenders(t, 'runtime'), t.slice(0, 300)).toEqual([])
    })
  })
})
