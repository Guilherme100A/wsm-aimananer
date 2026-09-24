import { C, connectedSession, createContact, GATE_CODES, GATES, messageCount, useQueue } from './shared'
import { describe, expect, it } from 'vitest'

describe('T09 — SendPipeline: ordem fixa dos gates e curto-circuito', () => {
  const ctx = useQueue()

  /** Gates espiões que registram a ordem; `failAt` lança SendRejectedError com o código do gate. */
  function spyGates(order: string[], failAt?: string) {
    const gates: Record<string, (req: any, c: any) => Promise<any>> = {}
    for (const name of GATES) {
      gates[name] = async () => {
        order.push(name)
        if (name === failAt) throw new C.SendRejectedError(GATE_CODES[name]![0], `falha simulada em ${name}`)
        if (name === 'enqueue') return { id: 'fake-message', status: 'queued' }
      }
    }
    return gates
  }

  const fakeQueue = () => {
    const enqueued: any[] = []
    return { enqueued, enqueue: async (input: any) => (enqueued.push(input), { id: 'x', status: 'queued', ...input }) }
  }

  const req = (over: Record<string, unknown> = {}) => ({
    sessionId: '00000000-0000-4000-8000-000000000001',
    phone: '+5511999990000',
    content: { text: 'oi' },
    actor: 'tester',
    ...over,
  })

  it('AC-T09-01 GATE_ORDER é auth → sessionExists → connected → contactAllowed → warmupLimit → rateLimit → enqueue', () => {
    expect(C.GATE_ORDER).toEqual([...GATES])
  })

  it('AC-T09-01 com todos os gates aprovando, eles rodam exatamente nessa ordem, uma vez cada', async () => {
    const order: string[] = []
    const pipeline = new C.SendPipeline({ db: ctx.db, queue: fakeQueue(), gates: spyGates(order) })
    await pipeline.send(req())
    expect(order).toEqual([...GATES])
  })

  it('AC-T09-01 runGates também respeita a ordem', async () => {
    const order: string[] = []
    const pipeline = new C.SendPipeline({ db: ctx.db, queue: fakeQueue(), gates: spyGates(order) })
    await pipeline.runGates(req())
    expect(order.filter((g) => g !== 'enqueue')).toEqual(GATES.filter((g) => g !== 'enqueue'))
  })

  for (const failing of GATES.filter((g) => g !== 'enqueue')) {
    it(`AC-T09-01 falha em ${failing} interrompe a cadeia com ${GATE_CODES[failing]![0]} (HTTP ${GATE_CODES[failing]![1]}) e nenhum gate seguinte roda`, async () => {
      const order: string[] = []
      const queue = fakeQueue()
      const pipeline = new C.SendPipeline({ db: ctx.db, queue, gates: spyGates(order, failing) })
      const err = await pipeline.send(req()).then(
        () => undefined,
        (e: any) => e,
      )
      expect(err, 'send deveria rejeitar').toBeDefined()
      expect(err).toBeInstanceOf(C.SendRejectedError)
      const [code, status] = GATE_CODES[failing]!
      expect(err.code).toBe(code)
      expect(err.status).toBe(status)
      expect(err.gate).toBe(failing)
      const idx = GATES.indexOf(failing)
      expect(order, 'gates anteriores rodam, os seguintes não').toEqual(GATES.slice(0, idx + 1))
      expect(order).not.toContain('enqueue')
      expect(queue.enqueued).toHaveLength(0)
    })
  }

  it('AC-T09-01 gates padrão: sem actor → UNAUTHORIZED antes de qualquer outra verificação', async () => {
    const order: string[] = []
    const spies = spyGates(order)
    delete spies.auth
    const queue = fakeQueue()
    const pipeline = new C.SendPipeline({ db: ctx.db, queue, getTransport: (id: string) => ctx.manager.getTransport(id), gates: spies })
    await expect(pipeline.send(req({ actor: undefined }))).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401, gate: 'auth' })
    expect(order).toEqual([])
    expect(queue.enqueued).toHaveLength(0)
  })

  it('AC-T09-01 gates padrão com o banco: sessão inexistente para em sessionExists (SESSION_NOT_FOUND) e não consulta contato', async () => {
    const order: string[] = []
    const spies = spyGates(order)
    for (const g of ['auth', 'sessionExists', 'connected']) delete spies[g]
    const pipeline = new C.SendPipeline({ db: ctx.db, queue: fakeQueue(), getTransport: (id: string) => ctx.manager.getTransport(id), gates: spies })
    await expect(pipeline.send(req())).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404, gate: 'sessionExists' })
    expect(order).toEqual([])
  })

  it('AC-T09-01 gates padrão: sessão conectada + contato sem consentimento → para em contactAllowed; warmup/rate/enqueue não rodam', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx, { consent: false })
    const order: string[] = []
    const spies = spyGates(order)
    for (const g of ['auth', 'sessionExists', 'connected', 'contactAllowed']) delete spies[g]
    const before = messageCount(ctx, id)
    const pipeline = new C.SendPipeline({ db: ctx.db, queue: ctx.queue, getTransport: (sid: string) => ctx.manager.getTransport(sid), gates: spies })
    await expect(pipeline.send(req({ sessionId: id, phone: contact.phone }))).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403, gate: 'contactAllowed' })
    expect(order).toEqual([])
    expect(messageCount(ctx, id)).toBe(before)
  })

  it('AC-T09-01 gates padrão aprovando tudo: o gate enqueue enfileira na MessageQueue e send() resolve com a MessageView queued', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const pipeline = new C.SendPipeline({ db: ctx.db, queue: ctx.queue, getTransport: (sid: string) => ctx.manager.getTransport(sid) })
    const view = await pipeline.send(req({ sessionId: id, phone: contact.phone }))
    expect(view?.id).toBeTruthy()
    expect(view.status).toBe('queued')
    expect(view.sessionId).toBe(id)
  })
})
