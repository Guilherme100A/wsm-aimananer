# Warm-up e Health Monitor (T10)

O Health Score é **apenas um indicador operacional**. Ele não garante nada sobre o comportamento do
WhatsApp. O sistema só **para** a sessão diante de sinais anormais e nunca aumenta a atividade para compensar.

## Warm-up (`@wsm/core` → `computeWarmup`)

O cronograma segue o `WarmUpConfig` do [baileys-antiban](https://github.com/kobie3717/baileys-antiban)
(consultado via context7; o pacote ainda não é dependência do projeto: a integração dos delays fica com o T09).

| Parâmetro | Env | Default |
|---|---|---|
| `warmUpDays` | `WARMUP_DAYS` | 7 |
| `day1Limit` | `WARMUP_DAY1_LIMIT` | 20 |
| `growthFactor` | `WARMUP_GROWTH_FACTOR` | 1.8 |

- Idade = `now - sessions.warmup_started_at` (gravado pelo SessionManager em `NEW → WARMING`).
- `percent = floor(min(100, idade / warmUpDays · 100))`; `day = floor(idade / 24h)`.
- Limite diário do dia `d`: `round(day1Limit · growthFactor^d)` → 20, 36, 65, 117, 210, 378, 680. Em 100% o
  limite de warm-up deixa de existir (`dailyLimit = null`).
- Em 100%, o monitor move a sessão `WARMING → STABLE` (health_event `warmup_completed`).
- O warm-up só limita volume. Nenhuma mensagem é gerada para "aquecer" a conta.

## Health Score (`computeHealthScore`, função pura)

Parte de 100 e subtrai penalidades (resultado arredondado e limitado a 0..100):

| Sinal | Penalidade |
|---|---|
| Falhas de envio | 3 por falha (teto 30) + `failed/(sent+failed) · 20` a partir de 5 tentativas |
| Desconexões | 5 por desconexão (teto 30) |
| Eventos 403 | 40 por evento (teto 60) |
| Taxa de resposta (`received/sent`, a partir de 20 envios) | < 2% → 15; < 10% → 8 |
| Tendência de erros (metade recente − metade anterior da janela, se > 0) | 4 por unidade (teto 20) |

Rótulos: `Good` (≥ 70), `Warning` (40–69), `Critical` (< 40).

Os contadores vêm da janela `(now − 24h, now]` (configurável: `windowMs`), usando `created_at`:
`sent` = mensagens outbound `sent|delivered|read`; `failed` = outbound `failed`; `received` = inbound;
`disconnects` = health_events `disconnected`; `forbidden403` = health_events `forbidden_403`.
Sinais anteriores ao último resume manual (health_event `resumed`) não contam.

## Regras do monitor (`@wsm/worker` → `HealthMonitor`)

| Condição | Ação |
|---|---|
| warm-up 100% em `WARMING` | `→ STABLE` |
| score < 70 em `WARMING`/`STABLE` | `→ DEGRADED`, health_event `health_degraded`, alerta `health_degraded` (level `warning`) |
| score ≥ 70 em `DEGRADED` | volta a `WARMING` ou `STABLE` conforme o warm-up (`health_recovered`) |
| score < 40 **ou** qualquer 403 | `manager.pause(id)` (`→ PAUSED`), `queueControl.pause(id)`, health_event `auto_paused`, alerta `forbidden_403` ou `health_degraded` (level `critical`); `warmup_paused` se estava em `WARMING` |
| erros recentes ≥ 5 e tendência de alta | health_event + alerta `error_burst` |
| queda da conexão com 403 | fila pausada + alerta `forbidden_403` (o SessionManager pausa a sessão) |
| queda transitória/loggedOut | alerta `disconnected` |

O resume é **somente manual** (`POST /api/sessions/:id/resume`); `resumeState` devolve `STABLE` se o
warm-up terminou, senão `WARMING`.

### Uso

```ts
const monitor = new HealthMonitor({ db, queueControl })
const manager = new SessionManager({
  db, transportFactory,
  onConnected: monitor.onConnected,
  onDisconnected: monitor.onDisconnected,
  resumeState: monitor.resumeState,
})
monitor.attach(manager)
monitor.on('alert', (a) => /* T11 */ undefined)
createApp({ db, redis, logger, apiToken, sessions: manager, health: monitor })
```

## API

`GET /api/sessions/:id/health` →
`{ state, warmupPercent, score, label, sent, received, failed, disconnects, forbidden403, lastEventAt }`.
