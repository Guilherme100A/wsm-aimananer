# Operação (T16)

## Serviços (`docker-compose.yml`)

| Serviço | Porta (container) | Porta no host (variável, default) | Saúde |
|---|---|---|---|
| postgres | 5432 | `POSTGRES_HOST_PORT` (5432) | `pg_isready` |
| redis (AOF ligado) | 6379 | `REDIS_HOST_PORT` (6379) | `redis-cli ping` |
| worker | 9464 (`/health`, `/metrics`), 9465 (interno) | `WORKER_HEALTH_HOST_PORT` (9464), `WORKER_INTERNAL_HOST_PORT` (9465) | `GET :9464/health` (db + redis) |
| api | 3000 | `API_HOST_PORT` (3000) | `GET /health` |
| dashboard (nginx) | 80 | `DASHBOARD_HOST_PORT` (8080) | `GET /` |

- **Exposição de rede (T17):** todas as portas de host são publicadas **só em `127.0.0.1`** (postgres, redis,
  worker 9464/9465 e api 3000), **menos o dashboard**, que escuta em todas as interfaces. Os testes e as
  ferramentas no próprio host continuam acessando por `localhost`, mas nada fica aberto na rede local:
  postgres usa `wsm/wsm` por default e redis não tem senha. Da rede, o único ponto de entrada é o nginx do
  dashboard, que encaminha `/api` para a API sobrescrevendo `X-Forwarded-For` (a API roda com
  `TRUST_PROXY=true`, ver `docs/auth.md`). Para expor outra porta de propósito, troque o `127.0.0.1:` do
  mapeamento e proteja o serviço (senha no postgres/redis, `INTERNAL_TOKEN` forte, `TRUST_PROXY=false` na
  API).
- `docker compose up -d --wait` sobe os 5 serviços healthy. Numa máquina com as imagens já construídas, isso leva uns 15 s.
- O compose não fixa `container_name` nem nomes de volume. Para rodar outra instância isolada, use `docker compose -p <projeto> ...` com outras portas.
- O dashboard é servido pelo nginx, que encaminha `/api`, `/metrics` e `/health` para `api:3000` (`apps/dashboard/nginx.conf`).
- O worker roda `node dist/main.js`, que chama `startWorker()` em `apps/worker/src/boot/start.ts`. A API roda `node dist/server.js`.

### Variáveis

| Variável | Onde | Observação |
|---|---|---|
| `API_TOKEN` | api | Bearer das rotas `/api/*`. O default do compose (`dev-api-token`) é **só para desenvolvimento**. |
| `INTERNAL_TOKEN` | api, worker | Bearer da ponte interna. O default (`dev-internal-token`) é **só para desenvolvimento**. |
| `CREDENTIALS_KEY` | worker (e api) | 32 bytes em base64 para cifrar as credenciais do WhatsApp. O default do compose é uma chave **pública de desenvolvimento**: com ela, as credenciais não ficam protegidas. Em qualquer ambiente real, gere uma chave com `openssl rand -base64 32` e guarde-a fora do repositório. Trocar a chave invalida as credenciais já gravadas. |
| `WA_TRANSPORT` | worker | `baileys` (default) ou `fake` (só para testes; habilita `/internal/fake/*`). |
| `ANTIBAN_MODE` / `ANTIBAN_PRESET` | worker | `real`/`conservative` por default (ver `docs/antiban.md`). |
| `WORKER_INTERNAL_URL` | api | `http://worker:9465`. Sem essa variável, a API só acessa o banco: criar, listar e ler funciona, mas as ações de sessão e de fila ficam indisponíveis. |

## Ponte API ↔ worker

A API e o worker rodam em containers separados. O worker é o dono do `SessionManager`, da `MessageQueue` e do `HealthMonitor`. A API usa clientes (`apps/api/src/bridge/client.ts`) que implementam **as mesmas interfaces** das rotas (`SessionsControl`, `MessagesControl` + `enqueue`, `HealthControl`), então as rotas não mudaram.

- O transporte é `POST http://worker:9465/internal/rpc` com `{ target, method, args }` e `Authorization: Bearer INTERNAL_TOKEN`. Os métodos permitidos formam uma lista fechada, em `apps/worker/src/boot/internal-server.ts`.
- Os erros de domínio (`SessionError`, `InvalidTransitionError`, `MessageNotFoundError`, `TransportNotConnectedError`...) viajam serializados e a API os recria com as classes originais. Assim o mapeamento HTTP (SPEC 3.4) é o mesmo dos testes em processo.
- Se o worker estiver fora do ar, a API responde 500 `INTERNAL_ERROR`.
- **Limitação conhecida:** o `getTransport` remoto é síncrono e sempre devolve um proxy. Por isso, na API em container, o gate `connected` do pipeline olha **só o estado** (WARMING/STABLE). Uma sessão nesse estado mas momentaneamente sem socket tem a mensagem aceita, e ela fica `queued` até a conexão voltar (a fila segura o envio). Os grupos consultam o worker e respondem 409 se o transporte não estiver conectado.
- A porta 9465 é publicada no host, só em `127.0.0.1`, para os testes E2E. Em produção, não publique essa porta e troque o `INTERNAL_TOKEN`.

## Boot do worker

Ordem do boot:

1. Carrega a config e inicializa a cifra (`CREDENTIALS_KEY`).
2. Conecta ao banco e roda as migrations (com advisory lock).
3. Conecta ao Redis.
4. Monta a factory de transporte (cada transporte fica ligado à sua sessão).
5. Cria a `MessageQueue`, com `deliver` passando pelo antiban + marca de envio em curso, `forbidden_403` para o `HealthMonitor` e redução de limites.
6. Cria o `HealthMonitor` e o `SessionManager` com os hooks e liga a fila às sessões.
7. **Reconcilia** as mensagens presas em `processing`.
8. Liga o `attachAi` (T13): persiste as mensagens recebidas, aplica o opt-out do T07 antes de tudo e gera sugestões que só são enviadas com aprovação humana. Depois liga o verificador de proxies (T06), os alertas (T11) e as métricas (T15).
9. Sobe o servidor de observabilidade (`:9464`) e o servidor interno (`:9465`).
10. `manager.start()` reconecta toda sessão com credenciais e estado ≠ DISCONNECTED (PAUSED reconecta e continua PAUSED).
11. Liga os workers das filas que têm mensagens pendentes.

Com banco vazio, ou sem sessões com credenciais, nenhuma conexão é aberta.

**Shutdown (SIGTERM/SIGINT):** a ordem é inversa. Primeiro fecham os servidores, depois alertas, proxies e métricas. Em seguida a **fila é fechada ANTES das sessões**: o BullMQ espera o job ativo terminar, então um envio em curso termina com o transporte ainda aberto. Só então as sessões fecham (sem mudar o estado no banco), depois o Redis e o banco. `stop_grace_period: 30s` no compose.

## Mensagens presas em `processing` (AC-T16-05)

A fila tem concorrência 1 por sessão, então existe no máximo uma mensagem `processing` por sessão. Se o worker morre (SIGKILL, OOM, queda do host) no meio de um envio, a mensagem fica em `processing`. O próximo boot decide o destino dela **antes** de qualquer worker da fila começar:

| Situação no boot | Destino | Por quê |
|---|---|---|
| `transport_message_id` preenchido | `sent` | O WhatsApp aceitou a mensagem; só faltou gravar o estado. Os receipts continuam casando pelo `transport_message_id`. |
| Sem `transport_message_id` e **sem** marca de envio em curso | `retrying` + job de volta na fila | O worker caiu antes de chamar `transport.sendMessage`, por exemplo durante a espera do antiban, que é quase todo o tempo em `processing`. Reenviar não duplica. |
| Sem `transport_message_id` e **com** marca de envio em curso | `failed` com `error = "delivery state unknown (worker stopped during send)"` | O worker caiu **durante** `sendMessage`: não dá para saber se o WhatsApp recebeu. **Não reenviamos**, porque uma mensagem duplicada para um contato é pior (spam, risco para a conta) do que uma falha visível. O operador vê o `failed` com o motivo e decide se reenvia. |

**Marca de envio em curso:** é a chave Redis `<prefix>:send-inflight:<sessionId>`, gravada imediatamente antes de `transport.sendMessage` (depois da espera do antiban) e apagada quando o envio retorna. Se a gravação da marca falhar, o envio não acontece e a fila tenta de novo, o que é seguro. Se apagar a marca falhar, o próximo boot fica mais conservador (`failed` em vez de reenvio) e a marca órfã é limpa. Toda transição da reconciliação grava `message_events` com `detail.reconciled = true`.

**Jobs órfãos no BullMQ:** o worker morto deixa o job da mensagem em `active`, com lock válido por até 30 s. Como a concorrência global é 1 por sessão, esse job seguraria a fila da sessão até o BullMQ detectá-lo como travado (30–60 s). No boot, antes de qualquer Worker da fila começar, `recoverOrphanJobs` apaga o lock e remove todo job `active`. O job é recriado com o mesmo `jobId` se a mensagem ainda estiver `queued`/`retrying`, e descartado se já foi `sent`/`failed`/`cancelled`. Isso pressupõe **um único processo worker** por deploy, que é o que o compose define. Com várias réplicas, seria preciso trocar isso por um lease por sessão.

As mensagens `queued` e `retrying` ficam nos jobs do BullMQ no Redis, com AOF ligado, e voltam a ser processadas depois do boot, quando a sessão pode enviar. Nada é perdido e nada é reenviado depois de `sent`, porque o processador só reivindica mensagens `queued` ou `retrying`.

## Controle do FakeTransport (só `WA_TRANSPORT=fake`)

As rotas ficam no servidor interno do worker (`:9465`) e exigem `Authorization: Bearer INTERNAL_TOKEN`. Com `WA_TRANSPORT=baileys`, **não existem** (404).

| Rota | Efeito |
|---|---|
| `GET /internal/fake/boot` | `{ bootId }` (muda a cada boot) |
| `GET /internal/fake/sessions/:id/state` | `{ exists, bootId, connected, connectCalls, transports, lastConnect, sent }` |
| `GET /internal/fake/sessions/:id/sent-history` | Envios bem-sucedidos de todos os boots (Redis `<prefix>:fake:sent:<id>`) |
| `POST .../qr` `{qr?}`, `.../pairing-code` `{code?}`, `.../open` | Autenticação e conexão |
| `POST .../close` `{reason: loggedOut\|forbidden\|transient, statusCode?}` | Queda da conexão |
| `POST .../receive` `{from, text?, fromMe?}` | Mensagem recebida (ex.: `SAIR`) |
| `POST .../receipt` `{messageId, status: delivered\|read}` | Receipt (use o `transportMessageId` da mensagem) |
| `POST .../fail-next-send` `{message?, statusCode?}` | Próximo envio falha (ex.: 403) |
| `PUT .../groups` `{groups}` | Grupos devolvidos por `fetchGroups` |
| `POST .../hold-before-send` `{ms}` | Espera **antes** da marca (simula a espera do antiban) |
| `POST .../send-delay` `{ms}` | Espera **depois** da marca, antes do envio (simula um envio lento) |

Sem transporte vivo para a sessão, a resposta é `404 FAKE_TRANSPORT_NOT_FOUND`. O `sent-history` responde sempre.

## Pendências conhecidas

- As mensagens recebidas (inbound) são persistidas pelo `attachAi` (T13), que também é o único ponto que chama o opt-out do T07. As rotas `/api/suggestions` usam a mesma ponte (fila e sessões) para enviar sugestões aprovadas pelo SendPipeline.
- O Health Score e os limites são indicadores operacionais. Nenhuma camada garante que a conta não será restringida pelo WhatsApp.
