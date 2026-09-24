# Alertas (T11)

## Eventos alertáveis

`forbidden_403`, `disconnected`, `error_burst`, `proxy_unavailable`, `warmup_paused`, `health_degraded`.

Fontes:
- `HealthMonitor` (T10) → evento `alert` `{ type, sessionId, at, detail }`.
- `ProxyChecker` (T06) → evento `proxy_unavailable` `{ proxyId, error, errorCount, checkedAt }`. Gera um alerta por
  sessão vinculada ao proxy (`sessions.proxy_id`); sem sessão, um alerta com `sessionId: null`.

## Canais (tabela `webhooks`, CRUD em `/api/webhooks`)

| Canal | `url` | `secret` (cifrado) | `config` | Envio |
|---|---|---|---|---|
| `http` | endpoint | segredo HMAC (obrigatório) | — | `POST url`, JSON `{ event, sessionId, at, detail }`, header `x-wsm-signature` = HMAC-SHA256 hex do body cru |
| `discord` | webhook URL | — | — | `POST url`, JSON `{ content }` |
| `telegram` | base da Bot API (ex.: `https://api.telegram.org`) | bot token (obrigatório) | `chatId` (obrigatório), `baseUrl` opcional | `POST {base}/bot{token}/sendMessage`, JSON `{ chat_id, text }` |
| `email` | `smtp://host:port` (vazio → `SMTP_URL`) | senha SMTP (opcional) | `to` (obrigatório), `from` (default `alerts@wsm.local`), `user` | nodemailer, subject `[WSM] <evento>` |

`events` vazio assina todos os eventos. `enabled: false` desliga o webhook.

### Verificando a assinatura (webhook HTTP)

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-wsm-signature']))
```

## Segredos

O segredo é cifrado com AES-256-GCM (`CREDENTIALS_KEY`, T02) e gravado em `webhooks.secret` como
`enc:v<versão>:<iv>:<tag>:<ciphertext>` (base64). A API nunca devolve o segredo (só `hasSecret`), e os logs e
mensagens de erro não o incluem.

## Deduplicação e retries

- O mesmo `(evento, sessão)` não é reenviado por 10 minutos (`ALERT_DEDUP_MS` ou `dedupMs`). A janela conta a partir do
  último alerta não deduplicado.
- Cada webhook recebe até 3 tentativas no total (`maxAttempts`), com backoff 1s, 2s (`backoff`). Status não-2xx,
  timeout e erro de rede contam como falha. Ao esgotar, loga `error` (com `webhook_id` e `event`) e emite
  `delivery_failed`. Nada disso derruba o worker: `dispatch`/`notify` nunca lançam.

## Uso no worker

```ts
const alerts = new AlertService({ db })
alerts.attachHealthMonitor(monitor)
alerts.attachProxyChecker(proxyMonitor.checker) // ou startProxyMonitor({ onUnavailable: alerts.onProxyUnavailable })
```
