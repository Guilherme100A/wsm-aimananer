// Validação de entrada com zod (AC-T03-03). Falha → 400 VALIDATION_ERROR com o path dos campos.
import { validator } from 'hono/validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'
import { validationError } from './errors'

/** Middleware: `app.post('/x', validate('json', schema), (c) => c.req.valid('json'))`. */
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return validator(target, async (value) => {
    const result = await schema.safeParseAsync(value)
    if (!result.success) throw validationError(result.error)
    return result.data as z.output<T>
  })
}
