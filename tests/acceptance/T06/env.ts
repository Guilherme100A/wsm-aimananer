// CREDENTIALS_KEY precisa existir antes de qualquer import de @wsm/* (a cifra do T02 lê a chave da env).
import { randomBytes } from 'node:crypto'

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')
