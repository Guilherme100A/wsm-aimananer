// Segredo do webhook (HMAC, bot token, senha SMTP) cifrado com a cripto do T02 (AES-256-GCM, CREDENTIALS_KEY).
// Formato na coluna `webhooks.secret`: `enc:v<keyVersion>:<iv>:<authTag>:<ciphertext>` (base64). Nunca texto claro.
import { decrypt, encrypt } from '../crypto'

const PREFIX = 'enc'
const aad = (webhookId: string) => `webhook/${webhookId}/secret`

export function encryptWebhookSecret(webhookId: string, secret: string): string {
  const p = encrypt(secret, { aad: aad(webhookId) })
  return [PREFIX, `v${p.keyVersion}`, p.iv.toString('base64'), p.authTag.toString('base64'), p.ciphertext.toString('base64')].join(':')
}

export function decryptWebhookSecret(webhookId: string, stored: string): string {
  const [prefix, version, iv, tag, ct] = stored.split(':')
  if (prefix !== PREFIX || !version?.startsWith('v') || !iv || !tag || ct === undefined) throw new Error('invalid webhook secret format')
  return decrypt<string>(
    { ciphertext: Buffer.from(ct, 'base64'), iv: Buffer.from(iv, 'base64'), authTag: Buffer.from(tag, 'base64'), keyVersion: Number(version.slice(1)) },
    { aad: aad(webhookId) },
  )
}
