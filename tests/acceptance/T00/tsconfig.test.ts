import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, exec, extractJson, parseJsonc, rootPath, tail } from '../helpers/exec'
import { WORKSPACES } from './workspaces'

interface TsConfig {
  extends?: string | string[]
  compilerOptions?: { strict?: boolean }
}

const readTsconfig = (abs: string) => parseJsonc<TsConfig>(readFileSync(abs, 'utf8'))

function resolveExtends(from: string, ext: string): string | null {
  if (!ext.startsWith('.') && !ext.startsWith('/')) return null // pacote npm: fora do contrato
  const abs = resolve(dirname(from), ext)
  if (existsSync(abs)) return abs
  if (existsSync(`${abs}.json`)) return `${abs}.json`
  return null
}

/** Cadeia de `extends` (arquivos locais), começando pelo próprio tsconfig. */
function extendsChain(abs: string, seen = new Set<string>()): string[] {
  if (seen.has(abs)) return []
  seen.add(abs)
  const cfg = readTsconfig(abs)
  const exts = cfg.extends === undefined ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends]
  const chain = [abs]
  for (const e of exts) {
    const next = resolveExtends(abs, e)
    if (next) chain.push(...extendsChain(next, seen))
  }
  return chain
}

const isRootLevel = (abs: string) => dirname(abs) === resolve(ROOT) && /^tsconfig[^/\\]*\.json$/.test(relative(ROOT, abs))

function showConfig(tsconfigRel: string, cwd: string) {
  // tsc do workspace raiz; se não houver, do próprio workspace.
  let r = exec(`pnpm exec tsc --showConfig -p "${tsconfigRel}"`)
  if (r.code !== 0) r = exec('pnpm exec tsc --showConfig -p tsconfig.json', { cwd })
  return r
}

describe('T00 — tsconfig base strict', () => {
  it('AC-T00-05 existe um tsconfig base na raiz com compilerOptions.strict = true', () => {
    const base = rootPath('tsconfig.base.json')
    expect(existsSync(base), 'tsconfig.base.json não existe na raiz').toBe(true)
    expect(readTsconfig(base).compilerOptions?.strict).toBe(true)
  })

  for (const ws of WORKSPACES) {
    it(`AC-T00-05 ${ws.dir}/tsconfig.json herda o tsconfig base (strict: true) sem sobrescrever`, () => {
      const tsconfig = rootPath(ws.dir, 'tsconfig.json')
      expect(existsSync(tsconfig), `${ws.dir}/tsconfig.json não existe`).toBe(true)

      const chain = extendsChain(tsconfig)
      const base = chain.find((f) => isRootLevel(f))
      expect(base, `${ws.dir}/tsconfig.json não estende um tsconfig da raiz (cadeia: ${chain.map((f) => relative(ROOT, f)).join(' → ')})`).toBeTruthy()
      expect(readTsconfig(base!).compilerOptions?.strict, `${relative(ROOT, base!)} sem strict: true`).toBe(true)
      // Nenhum elo da cadeia antes do base pode desligar strict.
      for (const f of chain.slice(0, chain.indexOf(base!))) {
        expect(readTsconfig(f).compilerOptions?.strict, `${relative(ROOT, f)} sobrescreve strict`).not.toBe(false)
      }
    })

    it(`AC-T00-05 config efetiva de ${ws.dir} (tsc --showConfig) tem strict: true`, () => {
      const r = showConfig(`${ws.dir}/tsconfig.json`, rootPath(ws.dir))
      expect(r.code, tail(r)).toBe(0)
      const effective = extractJson<TsConfig>(r.stdout)
      expect(effective.compilerOptions?.strict).toBe(true)
    })
  }
})
