// AC-T08-06 — o worker só entrega ao transporte via packages/core/src/send/ (ponto único, T09).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as core from '@wsm/core'
import { ROOT, fileExists } from '../helpers/exec'
import { connectedSession, enqueue, useQueue, waitMsgStatus } from './shared'

function productFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) productFiles(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p: string) => relative(ROOT, p).split('\\').join('/')

describe('T08 — ponto único de entrega', () => {
  // deliver espião: registra a chamada e delega ao deliver real do @wsm/core
  const delivered: Array<{ transport: any; to: string; content: any }> = []
  const ctx = useQueue({
    queueOptions: () => ({
      deliver: async (transport: any, to: string, content: any) => {
        delivered.push({ transport, to, content })
        return (core as any).deliver(transport, to, content)
      },
    }),
  })

  it('AC-T08-06 packages/core/src/send/deliver.ts existe e @wsm/core exporta deliver', () => {
    expect(fileExists('packages/core/src/send/deliver.ts')).toBe(true)
    expect(typeof (core as any).deliver).toBe('function')
  })

  it('AC-T08-06 nenhum código de produto fora de packages/core/src/send/ (e da própria implementação do transporte) chama .sendMessage(', () => {
    const offenders: string[] = []
    for (const base of ['apps', 'packages']) {
      for (const f of productFiles(join(ROOT, base))) {
        const r = rel(f)
        if (r.startsWith('packages/core/src/send/') || r.startsWith('packages/core/src/transport/')) continue
        const lines = readFileSync(f, 'utf8').split('\n')
        lines.forEach((l, i) => {
          if (/\.sendMessage\s*\(/.test(l)) offenders.push(`${r}:${i + 1}: ${l.trim()}`)
        })
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('AC-T08-06 a fila do worker entrega ao transporte somente através do deliver injetado', async () => {
    const { id, t } = await connectedSession(ctx)
    const before = delivered.length
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')

    const mine = delivered.slice(before)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.transport).toBe(t)
    expect(mine[0]!.to).toBe(`${m.phone.replace(/^\+/, '')}@s.whatsapp.net`)
    expect(mine[0]!.content).toEqual({ text: m.text })
    // cada envio que chegou ao transporte passou pelo deliver
    expect(t.sendCalls).toHaveLength(mine.length)
  })
})

describe('T08 — deliver que não delega', () => {
  // se o deliver injetado não chama o transporte, nada chega ao transporte: não há caminho paralelo
  const calls: string[] = []
  const ctx = useQueue({
    queueOptions: () => ({
      deliver: async (_transport: any, to: string) => {
        calls.push(to)
        return { messageId: `STUB-${calls.length}` }
      },
    }),
  })

  it('AC-T08-06 com deliver substituído, o transporte não recebe nenhum sendMessage', async () => {
    const { id, t } = await connectedSession(ctx)
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')
    expect(calls).toHaveLength(1)
    expect(t.sendCalls).toHaveLength(0)
  })
})
