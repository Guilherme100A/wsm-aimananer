import { describe, expect, it } from 'vitest'
import { exec, tail } from '../helpers/exec'

describe('T00 — install e build', () => {
  it('AC-T00-01 pnpm install seguido de pnpm -r build termina com exit 0', () => {
    const install = exec('pnpm install', { timeoutMs: 900_000 })
    expect(install.code, tail(install)).toBe(0)

    const build = exec('pnpm -r build', { timeoutMs: 900_000 })
    expect(build.code, tail(build)).toBe(0)
  }, 1_800_000)
})
