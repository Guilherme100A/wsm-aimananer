import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, rootPath } from '../helpers/exec'
import { fakeJid, uniqueId } from '../helpers/factories'
import { countSocketConnects, fakeAuthState, loadTransport } from '../helpers/transport'

// Os nomes dos módulos são montados em partes para este próprio arquivo não casar com a varredura.
const BAILEYS = ['@whiskeysockets/' + 'baileys', 'bail' + 'eys']
const WA_HOSTS = ['web.' + 'whatsapp.com', 'g.' + 'whatsapp.net', 'mmg.' + 'whatsapp.net']
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const MOD = `(?:${BAILEYS.map(esc).join('|')})(?:/[^'"\`]*)?`
const IMPORT_PATTERNS = [
  new RegExp(`\\bfrom\\s+['"\`]${MOD}['"\`]`),
  new RegExp(`\\bimport\\s+['"\`]${MOD}['"\`]`),
  new RegExp(`\\bimport\\s*\\(\\s*['"\`]${MOD}['"\`]\\s*\\)`),
  new RegExp(`\\brequire\\s*\\(\\s*['"\`]${MOD}['"\`]\\s*\\)`),
  new RegExp(`\\b(?:vi|jest)\\.(?:mock|doMock|importActual)\\s*\\(\\s*['"\`]${MOD}['"\`]`),
]
const REAL_SOCKET_PATTERNS = [
  ...WA_HOSTS.map((h) => new RegExp(esc(h), 'i')),
  /\bmakeWASocket\s*\(\s*\{/, // chamar a factory real do Baileys (a factory falsa recebe config por argumento)
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'].includes(extname(name))) out.push(full)
  }
  return out
}

const testFiles = () => walk(rootPath('tests'))
const rel = (f: string) => relative(ROOT, f).split('\\').join('/')

function scan(patterns: RegExp[]) {
  const hits: string[] = []
  for (const f of testFiles()) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => patterns.some((p) => p.test(line)) && hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`))
  }
  return hits
}

describe('T04 — testes sem WhatsApp real', () => {
  it('AC-T04-04 nenhum arquivo em tests/** importa o Baileys diretamente', () => {
    expect(testFiles().length).toBeGreaterThan(0)
    const hits = scan(IMPORT_PATTERNS)
    expect(hits, `imports diretos do Baileys em tests/**:\n${hits.join('\n')}`).toEqual([])
  })

  it('AC-T04-04 nenhum arquivo em tests/** aponta para servidores do WhatsApp nem cria socket real', () => {
    const hits = scan(REAL_SOCKET_PATTERNS)
    expect(hits, `referências a socket real em tests/**:\n${hits.join('\n')}`).toEqual([])
  })

  it('AC-T04-04 a varredura detecta um import direto do Baileys (autoteste do detector)', () => {
    const samples = [
      `import makeWASocket from '${BAILEYS[0]}'`,
      `import { DisconnectReason } from "${BAILEYS[1]}"`,
      `const b = require('${BAILEYS[0]}')`,
      `const b = await import('${BAILEYS[0]}/lib/Types')`,
      `vi.mock('${BAILEYS[0]}', () => ({}))`,
    ]
    for (const s of samples) expect(IMPORT_PATTERNS.some((p) => p.test(s)), s).toBe(true)
    expect(IMPORT_PATTERNS.some((p) => p.test(`import { FakeTransport } from '@wsm/core'`))).toBe(false)
  })

  it('AC-T04-04 um fluxo completo no FakeTransport não abre nenhum socket de rede', async () => {
    const { FakeTransport } = await loadTransport()
    const probe = countSocketConnects()
    try {
      const t = new FakeTransport()
      const events: string[] = []
      t.on('qr', () => events.push('qr'))
      t.on('connection', (u: any) => events.push(`connection:${u.state}`))
      t.on('message', () => events.push('message'))
      t.on('receipt', () => events.push('receipt'))
      await t.connect({ sessionId: uniqueId('session'), auth: fakeAuthState() })
      t.emitQr('2@fake-qr')
      t.open()
      const { messageId } = await t.sendMessage(fakeJid(), { text: 'sem rede' })
      t.receipt(messageId, 'delivered')
      t.receive({ id: uniqueId('in'), from: fakeJid(), text: 'resposta' })
      await t.fetchGroups()
      t.close('transient')
      await t.logout()
      await t.close()
      await new Promise((r) => setTimeout(r, 50))
      expect(events.length).toBeGreaterThan(0)
    } finally {
      probe.restore()
    }
    expect(probe.hosts, `conexões abertas: ${probe.hosts.join(', ')}`).toEqual([])
  })
})
