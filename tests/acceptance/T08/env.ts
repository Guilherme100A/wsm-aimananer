// Precisa rodar antes de qualquer import de @wsm/*: a cifra do T02 lê CREDENTIALS_KEY da env
// e o worker escolhe o transporte por WA_TRANSPORT (testes nunca usam o Baileys real).
import { randomBytes } from 'node:crypto'

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')
process.env.WA_TRANSPORT = 'fake'
