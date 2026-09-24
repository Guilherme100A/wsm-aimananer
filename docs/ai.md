# IA assistiva (T13)

A IA só **sugere** respostas para mensagens recebidas. Nada é enviado sem aprovação humana, e nenhum caminho de
código gera mensagens sem uma mensagem recebida real.

## Fluxo

1. `attachAi(manager, { db, assistant })` (worker) assina o evento `message` de cada transporte que conecta.
2. Toda mensagem recebida é gravada em `messages` com `direction = 'inbound'` (status `delivered`, porque o enum
   de mensagens não tem "received"). Mensagens próprias e de grupo são ignoradas, e o mesmo `msg.id` não duplica.
3. O handler de opt-out do T07 roda primeiro. Se marcar opt-out, **não há sugestão**.
4. `AiAssistant.suggest(texto)` classifica a intenção e propõe uma resposta, gravada em `suggestions` com status
   `pending_approval`. Mídia sem texto é gravada, mas não gera sugestão.
5. `POST /api/suggestions/:id/approve` (texto opcionalmente editado) envia pelo `SendPipeline` do T09: todos os
   gates valem. Sucesso → `sent` (com `messageId`). Rejeição de gate → `failed` (com `error` = código), e a
   resposta HTTP é o erro do gate. `POST /api/suggestions/:id/reject` → `rejected`, nada é enviado.

## Roteador de modelos

| Variável | Default | Uso |
|---|---|---|
| `AI_PROVIDER_API_KEY` | vazio | Chave da API da Anthropic. Sem chave, só o fallback determinístico |
| `AI_MODEL_SMALL` | `claude-haiku-4-5-20251001` | Modelo padrão |
| `AI_MODEL_LARGE` | `claude-sonnet-5` | Só quando a confiança do small < limiar |
| `AI_CONFIDENCE_THRESHOLD` | `0.6` | Limiar de confiança (0..1) |
| `AI_MAX_TOKENS` | `512` | `max_tokens` de cada chamada |
| `AI_TIMEOUT_MS` | `10000` | Timeout de cada chamada (a chamada é abortada) |

- **Cache:** por SHA-256 do texto normalizado (trim, minúsculas, espaços colapsados). Uma mensagem repetida não
  chama o provedor de novo. O fallback não entra no cache.
- **Fallback:** em caso de erro, timeout, recusa ou resposta inválida do provedor, a intenção sai de regras por
  palavra-chave (`greeting`, `pricing`, `scheduling`, `support`, `complaint`, `thanks`, `question`, `other`) e a
  resposta sai de um template fixo. Se o modelo large falhar, fica o resultado do small.
- O provedor real (`AnthropicProvider`) usa o SDK oficial `@anthropic-ai/sdk` com structured outputs. O texto do
  cliente vai delimitado e é tratado como conteúdo, não como instrução. Os testes injetam um `AiProvider` fake.

## Configuração pelo painel (T19)

A página **IA / Modelo LLM** do dashboard (`#/ai`) e a API `/api/ai/settings` configuram o provedor e o modelo sem restart.

- **Armazenamento:** a tabela `ai_settings` tem uma linha única (`id = 1`, migration `0003_ai_settings`). Cada coluna `NULL` usa o ambiente (as variáveis acima, mais `AI_ENABLED`). Uma coluna preenchida **vence o ambiente campo a campo**. A origem de cada valor aparece como `sources.<campo> = 'db' | 'env'` (os defaults contam como `env`).
- **Chave de API:** fica só cifrada (AES-256-GCM com a `CREDENTIALS_KEY`, cripto do T02, AAD `ai_settings/api_key`). Ela nunca sai pela API, nem cifrada nem mascarada: a API só informa `hasApiKey`. `apiKey: null` remove a chave do banco; se houver `AI_PROVIDER_API_KEY` no ambiente, essa volta a valer.

| Rota | Efeito |
|---|---|
| `GET /api/ai/settings` | Configuração efetiva: `{ provider, modelSmall, modelLarge, confidenceThreshold, maxTokens, timeoutMs, enabled, hasApiKey, updatedAt, sources }` |
| `PUT /api/ai/settings` | Alteração parcial validada: campo omitido mantém o valor, `null` volta a usar o ambiente. Auditada como `ai.settings.update`, sem a chave |
| `POST /api/ai/settings/test` | Chamada mínima ao provedor com a configuração salva, mesclada com o body (sem salvar). Responde `{ ok, model, latencyMs, error? }`, com o erro sanitizado e sem a chave. Auditada como `ai.settings.test` |

**Limites aceitos:** modelos de 1 a 200 caracteres; `confidenceThreshold` de 0 a 1; `maxTokens` inteiro de 1 a 8192; `timeoutMs` inteiro de 500 a 120000; `provider` só `anthropic`. Campos desconhecidos dão 400.

**No worker:** o boot cria `new AiAssistant({ settings: new AiSettingsService({ db, env }), providerFactory, refreshMs })`.

- O assistente relê a configuração a cada `AI_SETTINGS_REFRESH_MS` (default 5 s; `0` relê a cada mensagem) e tem `refresh()` para forçar a releitura.
- Se mudar o provedor, a chave, algum modelo, o limiar, os tokens, o timeout ou `enabled`, o provedor é recriado e o **cache de classificação é zerado**.
- Com `enabled = false` ou sem chave, não há nenhuma chamada ao provedor: vale só o fallback determinístico.
- Se o banco estiver fora do ar, o assistente mantém a última configuração lida. Se nunca leu nenhuma, usa só o fallback.

As configurações **não criam nenhum caminho novo** de geração ou envio: a IA continua agindo só a partir de mensagens recebidas, e o envio só acontece com aprovação humana. Entrada em grupos continua proibida.
