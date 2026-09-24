# Grupos (T14 e T20)

## Leitura (T14)

- `GET /api/sessions/:id/groups` lista os grupos pelo `fetchGroups()` do transporte, com os campos `{ id, name, participants, status, announce, communityId, isAdmin }`.
- `POST /api/sessions/:id/groups/refresh` relê os grupos e fica auditado.
- A sessão precisa estar em WARMING ou STABLE; fora disso, a resposta é 409 `SESSION_NOT_CONNECTED`.

## Adicionar um número a um grupo (T20)

A adição é uma ação **manual** do admin: o sistema adiciona **uma** sessão do sistema a um grupo em que a sessão selecionada é admin.

Ela substitui, de forma deliberadamente limitada, a proposta de entrada automática em grupos, que foi **recusada**. Por isso:
- não existe lote, agendamento, fila de adições nem escolha de grupos por IA;
- nenhum timer, job ou handler chama a adição;
- a conta nunca entra sozinha em grupos (`groupAcceptInvite` não existe no código, F-NO-GROUP-JOIN).

### Rota

`POST /api/sessions/:id/groups/:groupId/participants` com o body `{ "targetSessionId": "<uuid>" }`. A rota exige autenticação e aceita um único alvo: um array ou qualquer campo extra dá 400.

| Situação | Resposta |
|---|---|
| Body inválido (array, campo extra, uuid inválido) | 400 `VALIDATION_ERROR` (não auditado) |
| `:id` inexistente | 404 `SESSION_NOT_FOUND` |
| Alvo igual à sessão admin, ou sem telefone | 400 `VALIDATION_ERROR` |
| Alvo inexistente | 404 `SESSION_NOT_FOUND` (`details.field = targetSessionId`) |
| Sessão admin fora de WARMING/STABLE ou sem conexão | 409 `SESSION_NOT_CONNECTED` |
| Grupo não encontrado para a sessão | 404 `GROUP_NOT_FOUND` |
| A sessão não é admin do grupo | 403 `NOT_GROUP_ADMIN` |
| Já houve uma tentativa nos últimos 60 s | 429 `RATE_LIMIT` (`details.retryAfterMs`) |
| Tentativa feita | 200 `{ result, groupId, targetSessionId, jid, code? }`, com `result` = `added`, `already_member`, `not_allowed` (a privacidade do número não permite ser adicionado) ou `failed` |

- **Admin:** o `fetchGroups` informa `isAdmin`, calculado pelos participantes do grupo (`admin`/`superadmin`) e pela conta autenticada (`user.id`/`lid`). A adição usa `groupParticipantsUpdate(groupId, [jid], 'add')` do Baileys. O `jid` é o telefone da sessão alvo (`<dígitos>@s.whatsapp.net`).
- **Freio anti-rajada:** no máximo **1 tentativa por minuto por sessão admin**. Conta toda tentativa que chega ao transporte, com sucesso ou falha. As checagens anteriores (alvo, conexão, grupo, admin) não contam. A janela vem das tentativas registradas em `audit_logs` (`detail.attempted = true`), e uma reserva em memória impede duas tentativas simultâneas da mesma sessão.
- **Auditoria:** toda tentativa, com sucesso ou falha, é auditada como `group.participant.add`, com `target_type = session` e `target_id` = sessão admin. O `detail` traz `{ groupId, targetSessionId, jid, result, attempted }` (nas falhas, também `errorCode`), e o ator vem do login.
- **Entre containers:** a API chama o worker pela ponte interna (`POST /internal/rpc`, `sessions.addGroupParticipant`, Bearer `INTERNAL_TOKEN`). As checagens, o freio e o transporte rodam no worker, pelo `GroupParticipantService`, e a auditoria é gravada pela API.

### Painel

Na página **Grupos**, cada grupo em que a sessão selecionada é admin mostra o botão **"Adicionar número"**. Nos demais, o botão fica desabilitado, com uma dica explicando que somente admins podem adicionar.

O botão abre um diálogo para escolher **uma** sessão do sistema. Em seguida o painel pede confirmação ("Adicionar <nome (telefone)> ao grupo <grupo>?") e mostra o resultado: adicionado, já é membro, não é admin, limite de 1 por minuto ou falha.
