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
