import { describe, expect, it } from 'vitest'
import { fileExists, readText } from '../helpers/exec'
import { ENV_VARS } from './workspaces'

function parseEnv(text: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) value = value.slice(1, value.lastIndexOf(q))
    else value = value.replace(/\s+#.*$/, '')
    vars.set(m[1], value)
  }
  return vars
}

const PLACEHOLDER = /change|replace|example|placeholder|your[-_]?|xxx|<[^>]*>|\$\{[^}]*\}|dummy|fake|sample|dev|local|test|todo|fill|insert|generate|gere|troque|preencha|sua[-_]|seu[-_]|secret[-_]?here/i

// Padrões de segredos reais conhecidos (nunca devem aparecer em .env.example).
const REAL_SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

function entropy(s: string): number {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

/** Um valor é "segredo real" se parecer aleatório (longo e de alta entropia) e não for placeholder. */
function looksLikeRealSecret(value: string): boolean {
  if (!value) return false
  if (PLACEHOLDER.test(value)) return false
  if (/^(.)\1*=*$/.test(value)) return false // ex.: AAAA…= ou xxxxxx
  return value.length >= 16 && entropy(value) > 3.5
}

const SECRET_VARS = ['API_TOKEN', 'CREDENTIALS_KEY', 'AI_PROVIDER_API_KEY'] as const

describe('T00 — .env.example', () => {
  it('AC-T00-04 .env.example contém todas as variáveis da seção 3.5', () => {
    expect(fileExists('.env.example'), '.env.example não existe').toBe(true)
    const vars = parseEnv(readText('.env.example'))
    const missing = ENV_VARS.filter((v) => !vars.has(v))
    expect(missing, `variáveis ausentes: ${missing.join(', ')}`).toEqual([])
  })

  it('AC-T00-04 .env.example não tem valor secreto real (tokens/chaves vazios ou placeholders)', () => {
    const vars = parseEnv(readText('.env.example'))
    for (const name of SECRET_VARS) {
      const value = vars.get(name) ?? ''
      expect(looksLikeRealSecret(value), `${name} parece conter um segredo real: "${value}"`).toBe(false)
    }
  })

  it('AC-T00-04 .env.example não contém padrões de credenciais reais nem senhas fortes em URLs', () => {
    const text = readText('.env.example')
    for (const [label, re] of REAL_SECRET_PATTERNS) expect(re.test(text), `encontrado ${label}`).toBe(false)

    const vars = parseEnv(text)
    for (const [name, value] of vars) {
      const m = /^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:([^@\s]+)@/i.exec(value)
      if (m) expect(looksLikeRealSecret(decodeURIComponent(m[1])), `${name}: senha na URL parece real`).toBe(false)
      if (/(TOKEN|SECRET|KEY|PASSWORD)$/.test(name)) {
        expect(looksLikeRealSecret(value), `${name} parece conter um segredo real: "${value}"`).toBe(false)
      }
    }
  })
})
