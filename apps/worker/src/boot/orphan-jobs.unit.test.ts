import { describe, expect, it } from 'vitest'
import type { MessageStatus } from '@wsm/core'
import { recoverOrphanJobs, type OrphanQueue } from './orphan-jobs'

function fakeQueue(sessionId: string, activeIds: string[]) {
  const removed: string[] = []
  const added: Array<{ data: unknown; opts: Record<string, unknown> }> = []
  const q: OrphanQueue = {
    getJobs: async () => activeIds.map((id) => ({ id, data: { messageId: id }, remove: async () => void removed.push(id) })),
    toKey: (type) => `p:session:${sessionId}:${type}`,
    add: async (_name, data, opts) => void added.push({ data, opts }),
  }
  return { q, removed, added }
}

describe('recoverOrphanJobs', () => {
  it('apaga o lock, remove o job ativo e recria só os de mensagens pendentes', async () => {
    const a = fakeQueue('s1', ['m-queued', 'm-sent'])
    const b = fakeQueue('s2', ['m-retrying', 'm-gone'])
    const status: Record<string, MessageStatus | undefined> = { 'm-queued': 'queued', 'm-sent': 'sent', 'm-retrying': 'retrying', 'm-gone': undefined }
    const deleted: string[] = []
    const res = await recoverOrphanJobs({
      sessionIds: ['s1', 's2', 's3'],
      queueFor: (id) => (id === 's1' ? a.q : id === 's2' ? b.q : fakeQueue(id, []).q),
      redis: { del: async (k) => void deleted.push(k) },
      messageStatus: async (id) => status[id],
      jobOptions: { attempts: 3 },
    })
    expect(res).toEqual({ requeued: ['m-queued', 'm-retrying'], dropped: ['m-sent', 'm-gone'] })
    expect(deleted).toEqual(['p:session:s1:m-queued:lock', 'p:session:s1:m-sent:lock', 'p:session:s2:m-retrying:lock', 'p:session:s2:m-gone:lock'])
    expect(a.removed).toEqual(['m-queued', 'm-sent'])
    expect(a.added).toEqual([{ data: { messageId: 'm-queued' }, opts: { attempts: 3, jobId: 'm-queued' } }])
    expect(b.added.map((x) => x.data)).toEqual([{ messageId: 'm-retrying' }])
  })

  it('falha ao remover não recria o job (evita duplicata)', async () => {
    const added: unknown[] = []
    const q: OrphanQueue = {
      getJobs: async () => [{ id: 'm1', data: { messageId: 'm1' }, remove: async () => Promise.reject(new Error('locked')) }],
      toKey: (t) => t,
      add: async (...a) => void added.push(a),
    }
    const res = await recoverOrphanJobs({ sessionIds: ['s'], queueFor: () => q, redis: { del: async () => 0 }, messageStatus: async () => 'queued', jobOptions: {} })
    expect(res).toEqual({ requeued: [], dropped: [] })
    expect(added).toEqual([])
  })
})
