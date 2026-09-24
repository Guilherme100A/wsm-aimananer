import { describe, expect, it } from 'vitest'
import { nextTheme, parseTheme, resolveTheme, THEME_KEY } from './theme'

describe('theme', () => {
  it('aceita só light/dark como valor salvo', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('Dark')).toBeNull()
    expect(parseTheme(null)).toBeNull()
    expect(parseTheme(undefined)).toBeNull()
  })

  it('escolha salva vence a preferência do sistema', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('sem escolha salva, segue prefers-color-scheme', () => {
    expect(resolveTheme(null, true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
  })

  it('alterna entre os dois temas', () => {
    expect(nextTheme('dark')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
  })

  it('usa a chave combinada e não a do token', () => {
    expect(THEME_KEY).toBe('wsm.theme')
  })
})
