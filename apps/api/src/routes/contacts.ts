// /api/contacts (T07): CRUD, import CSV e reversão de opt-out só com novo consentimento.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { ContactError, ContactsService, CsvHeaderError, isE164, toContactDto, type ContactPatch } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

const phone = z.string().trim().refine(isE164, 'phone must be E.164 (e.g. +5511999999999)')
const date = z
  .string()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid date (use ISO 8601)')
  .transform((s) => new Date(s))
const nullableText = z.string().trim().min(1).nullable()

const contactFields = {
  name: nullableText.optional(),
  consent: z.boolean().optional(),
  consent_at: date.nullable().optional(),
  consent_source: nullableText.optional(),
  opt_out: z.boolean().optional(),
  last_contact_at: date.nullable().optional(),
}

export const createContactSchema = z.object({ phone, ...contactFields })
export const updateContactSchema = z.object({ phone: phone.optional(), ...contactFields })

const listQuerySchema = z.object({
  phone: z.string().optional(),
  opt_out: z.enum(['true', 'false']).optional(),
  consent: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const idParam = z.object({ id: z.uuid() })

type Body = z.output<typeof updateContactSchema>

function toPatch(b: Body): ContactPatch {
  const p: ContactPatch = {}
  if (b.name !== undefined) p.name = b.name
  if (b.phone !== undefined) p.phone = b.phone
  if (b.consent !== undefined) p.consent = b.consent
  if (b.consent_at !== undefined) p.consentAt = b.consent_at
  if (b.consent_source !== undefined) p.consentSource = b.consent_source
  if (b.opt_out !== undefined) p.optOut = b.opt_out
  if (b.last_contact_at !== undefined) p.lastContactAt = b.last_contact_at
  return p
}

function toApiError(err: unknown): unknown {
  if (!(err instanceof ContactError)) return err
  if (err.code === 'not_found') return new ApiError('NOT_FOUND', err.message)
  return new ApiError('VALIDATION_ERROR', err.message, { reason: err.code })
}

const bool = (v: 'true' | 'false' | undefined) => (v === undefined ? undefined : v === 'true')

/** Lê o CSV de `text/csv` (corpo cru), `multipart/form-data` (campo `file`) ou JSON `{ csv }`. */
async function readCsv(c: Context<AppEnv>): Promise<string> {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    const body = await c.req.parseBody()
    const file = body.file ?? body.csv
    if (file instanceof File) return file.text()
    if (typeof file === 'string') return file
    throw new ApiError('VALIDATION_ERROR', 'multipart body must include a "file" field')
  }
  if (type.includes('application/json')) {
    const body = (await c.req.json()) as { csv?: unknown }
    if (typeof body?.csv === 'string') return body.csv
    throw new ApiError('VALIDATION_ERROR', 'JSON body must include a "csv" string')
  }
  return c.req.text()
}

export function contactsRoutes(deps: Pick<AppDeps, 'db'>) {
  const service = new ContactsService(deps.db)
  const run = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn()
    } catch (err) {
      throw toApiError(err)
    }
  }

  return new Hono<AppEnv>()
    .get('/api/contacts', validate('query', listQuerySchema), async (c) => {
      const q = c.req.valid('query')
      const rows = await service.list({
        phone: q.phone,
        optOut: bool(q.opt_out),
        consent: bool(q.consent),
        limit: q.limit,
        offset: q.offset,
      })
      return c.json(rows.map(toContactDto), 200)
    })
    .post('/api/contacts/import', async (c) => {
      const text = await readCsv(c)
      if (!text.trim()) throw new ApiError('VALIDATION_ERROR', 'CSV body is empty')
      let result
      try {
        result = await service.importCsv(text)
      } catch (err) {
        if (err instanceof CsvHeaderError) throw new ApiError('VALIDATION_ERROR', err.message)
        throw err
      }
      setAudit(c, {
        action: 'contact.import',
        targetType: 'contact',
        targetId: '-',
        detail: { imported: result.imported, rejected: result.rejected.length },
      })
      return c.json(
        { imported: result.imported, rejected: result.rejected, contacts: result.created.map(toContactDto) },
        200,
      )
    })
    .post('/api/contacts', validate('json', createContactSchema), async (c) => {
      const b = c.req.valid('json')
      const contact = await run(() => service.create({ ...toPatch(b), phone: b.phone }))
      setAudit(c, { action: 'contact.create', targetType: 'contact', targetId: contact.id })
      return c.json(toContactDto(contact), 201)
    })
    .get('/api/contacts/:id', validate('param', idParam), async (c) => {
      const contact = await run(() => service.getOrThrow(c.req.valid('param').id))
      return c.json(toContactDto(contact), 200)
    })
    .patch('/api/contacts/:id', validate('param', idParam), validate('json', updateContactSchema), async (c) => {
      const { id } = c.req.valid('param')
      const { contact, optOutReverted } = await run(() => service.update(id, toPatch(c.req.valid('json'))))
      setAudit(c, {
        action: optOutReverted ? 'contact.opt_out_reverted' : 'contact.update',
        targetType: 'contact',
        targetId: id,
        detail: optOutReverted
          ? { consent_at: contact.consentAt?.toISOString(), consent_source: contact.consentSource }
          : undefined,
      })
      return c.json(toContactDto(contact), 200)
    })
    .delete('/api/contacts/:id', validate('param', idParam), async (c) => {
      const { id } = c.req.valid('param')
      await run(() => service.delete(id))
      setAudit(c, { action: 'contact.delete', targetType: 'contact', targetId: id })
      return c.body(null, 204)
    })
}
