import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rootPath } from '../helpers/exec'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage'])
const isTest = (f: string) => /\.test\.tsx?$/.test(f)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

const productFiles = () => [...walk(rootPath('apps')), ...walk(rootPath('packages'))].filter((f) => !isTest(f))
const rel = (f: string) => relative(rootPath(), f).split(sep).join('/')

describe('T09 — ponto único de envio', () => {
  it('AC-T09-04 transport.sendMessage( só aparece em packages/core/src/send/', () => {
    const files = productFiles()
    expect(files.length).toBeGreaterThan(20)
    const hits = files.filter((f) => /transport\s*\??\.\s*sendMessage\s*\(/.test(readFileSync(f, 'utf8'))).map(rel)
    expect(hits.length, 'o ponto único deveria existir em send/').toBeGreaterThan(0)
    expect(hits.filter((f) => !f.startsWith('packages/core/src/send/')), `fora de send/: ${hits.join(', ')}`).toEqual([])
  })

  it('AC-T09-04 nenhuma outra chamada .sendMessage( fora de send/ e da própria camada de transporte', () => {
    const offenders = productFiles()
      .map(rel)
      .filter((f) => !f.startsWith('packages/core/src/send/') && !f.startsWith('packages/core/src/transport/'))
      .filter((f) => /\.sendMessage\s*\(/.test(readFileSync(rootPath(f), 'utf8')))
    expect(offenders, `chamadas de sendMessage fora do ponto único: ${offenders.join(', ')}`).toEqual([])
  })

  it('AC-T09-04 o AntibanAdapter e o pipeline não enviam por conta própria (sem sendMessage em antiban/ e safety/)', () => {
    const offenders = productFiles()
      .map(rel)
      .filter((f) => f.startsWith('packages/core/src/antiban/') || f.startsWith('packages/core/src/safety/'))
      .filter((f) => /sendMessage\s*\(/.test(readFileSync(rootPath(f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
