# SPEC — WhatsApp Session Manager (execução orquestrada)

> Fonte: nota "WhatsApp Session Manager" (canvas Maestri). Esta spec converte a nota em tarefas executáveis por um **Orquestrador**, seus **Operários** (implementam) e **Testers** (validam).
>
> Todo critério de aceitação possui um ID `AC-Txx-nn` rastreável até um teste que passa.

---

## Limpeza aplicada

A versão limpa deve remover do documento:

1. Referências a funcionalidades anteriormente recusadas.
2. Histórico de decisões que não faz parte do contrato atual.
3. Menções a "REJECT", "recusado", "proposta recusada" ou equivalentes quando estiverem descrevendo decisões antigas de produto.
4. Referências a `F-NO-GROUP-JOIN`.
5. Restrições antigas relacionadas a entrada automática em grupos.
6. Explicações históricas dentro das tarefas que não sejam necessárias para implementar ou testar o estado atual.
7. Qualquer critério que exista apenas para verificar a ausência de uma funcionalidade que não faz mais parte do escopo.

---

## 1. Papéis e regras

### 1.1 Orquestrador

* Não escreve código de produto nem testes.
* Planeja, despacha, verifica e decide.
* Despacha tarefas respeitando dependências.
* Para cada tarefa, despacha Operário e Tester.
* Só marca uma tarefa como `ACCEPTED` quando os dois verifies terminam com exit code 0.
* Mantém `spec/STATUS.md` atualizado.
* Após 3 ciclos de rejeição na mesma tarefa, escala para o humano com o relatório em `spec/reports/`.

### 1.2 Operário

* Implementa uma tarefa por vez.
* Trabalha apenas dentro dos `paths` declarados.
* Não edita `tests/acceptance/**`.
* Escreve testes unitários próprios.
* Antes de reportar `DONE`, executa o verify da tarefa.
* Se um critério estiver ambíguo, reporta `BLOCKED`.

### 1.3 Tester

* Escreve testes de aceitação a partir dos critérios.
* Utiliza `tests/acceptance/Txx/`.
* Todo teste de aceitação possui o ID `AC-Txx-nn` no título.
* Não edita código de produto.
* Utiliza `FakeTransport` nos testes.
* Antes de reportar `DONE`, executa o verify da tarefa.

### 1.4 Regras gerais

1. Credenciais do WhatsApp nunca ficam em texto puro.
2. Todo envio passa pelo pipeline definido em T09.
3. Nenhum envio ocorre para contato sem consentimento válido ou com `opt_out = true`.
4. O sistema pode pausar uma sessão diante de sinais anormais.
5. O Health Score é um indicador operacional e não representa garantia de disponibilidade ou comportamento futuro.

---

## 2. Protocolo de execução

### 2.1 Ciclo de vida

```text
TODO
  │
  ▼
IN_PROGRESS
  │
  ▼
VERIFYING
  │
  ├── ambos verify OK ──► ACCEPTED
  │
  └── falha ──► REJECTED ──► novo ciclo
```

`BLOCKED` é utilizado quando existe uma pergunta de requisito ou dependência que precisa de decisão.

### 2.2 Execução por onda

1. Selecionar tarefas cujas dependências estão `ACCEPTED`.
2. Despachar Operário e Tester.
3. Executar o verify do Operário quando ele reportar `DONE`.
4. Executar o verify do Tester quando ele reportar `DONE`.
5. Com ambos em exit 0, marcar `ACCEPTED`.
6. Executar a regressão da onda.

### 2.3 Formato de reporte

```text
<STATUS> Txx <papel>
STATUS: DONE | BLOCKED | REJECT
Arquivos alterados: <lista>
Verify: <exit code> (<comando>)
Notas: <decisões, desvios, perguntas>
```

### 2.4 Paralelismo e conflitos

As regras atuais de paralelismo, `SHARED_PATHS`, migrations, worktrees e checagem de escopo permanecem iguais.

---

## 3. Contratos globais

As seções abaixo permanecem como contrato atual do sistema:

* estrutura do repositório;
* estados da sessão;
* estados das mensagens;
* códigos de erro;
* variáveis de ambiente.

Não manter nesta seção histórico de decisões de produto.

### 3.2 Estados da sessão

```text
NEW → WARMING
WARMING → STABLE
WARMING|STABLE → DEGRADED
DEGRADED → WARMING|STABLE
WARMING|STABLE|DEGRADED → PAUSED
PAUSED → WARMING|STABLE
* → DISCONNECTED
DISCONNECTED → NEW
```

### 3.3 Estados da mensagem

```text
queued → processing → sent → delivered → read
```

Também existem:

```text
failed
retrying
cancelled
```

---

## 4. Grafo de tarefas

| Onda | Tarefa | Título                                | Depende de                        |
| ---- | ------ | ------------------------------------- | --------------------------------- |
| 0    | T00    | Scaffold do monorepo e infraestrutura | —                                 |
| 1    | T01    | Schema do banco                       | T00                               |
| 1    | T03    | Esqueleto da API                      | T00                               |
| 1    | T04    | Abstração de transporte               | T00                               |
| 2    | T02    | Criptografia e auth state             | T01, T04                          |
| 2    | T06    | Gerenciamento de proxies              | T01, T03                          |
| 2    | T07    | Contatos e consentimento              | T01, T03                          |
| 3    | T05    | Session Manager                       | T02, T03, T04, T06                |
| 4    | T08    | Fila de mensagens                     | T05, T07                          |
| 4    | T10    | Warm-up e Health Monitor              | T05                               |
| 5    | T09    | Motor de segurança                    | T07, T08, T10                     |
| 5    | T11    | Alertas                               | T10, T06                          |
| 5    | T14    | Grupos                                | T05                               |
| 6    | T13    | IA assistiva                          | T09                               |
| 6    | T15    | Observabilidade                       | T08, T10                          |
| 6    | T12    | Dashboard                             | T05, T06, T07, T08, T10, T11, T14 |
| 7    | T16    | Integração E2E                        | todas                             |
| 8    | T17    | Login admin e proxy na sessão         | T03, T05, T06                     |
| 8    | T18    | Dashboard: login e proxy              | T17, T12                          |
| 8    | T19    | Configurações do LLM                  | T13, T12                          |
| 8    | T20    | Adicionar número a grupo              | T14, T16, T18                     |
| 8    | T21    | Redesign do dashboard                 | T12, T18, T19                     |
| 8    | T22    | Chip pessoal / conexão direta         | T21, T18                          |

---

## 5. Tarefas

### T14 — Grupos

**Objetivo:** visualização e ações administrativas sobre grupos.

**Paths:**

```text
packages/core/src/groups/**
apps/api/src/routes/groups*
```

**Critérios:**

* **AC-T14-01** `GET /api/sessions/:id/groups` lista `{ id, name, participants, status }` através de `transport.fetchGroups()`.
* **AC-T14-02** Ações administrativas sobre grupos são autenticadas e auditadas.

---

### T19 — Configurações do modelo de LLM

Os critérios existentes do T19 permanecem.

Remover apenas referências históricas que não façam parte do comportamento atual do sistema.

O AC-T13-06 continua estabelecendo que a IA trabalha a partir de mensagens recebidas e não cria fluxos independentes de geração de mensagens.

---

### T20 — Adicionar número a um grupo

**Objetivo:** permitir que um administrador adicione manualmente uma sessão do sistema a um grupo.

**Paths:**

```text
packages/core/src/transport/**
packages/core/src/groups/**
apps/api/src/routes/groups*
apps/api/src/bridge/**
apps/worker/src/boot/**
apps/dashboard/src/pages/Groups*
apps/dashboard/src/components/**
docs/groups.md
```

**Critérios de aceitação:**

* **AC-T20-01** `WaTransport.addGroupParticipant(groupId, jid)` utiliza a operação correspondente do Baileys e retorna o resultado por participante. O `FakeTransport` possui os cenários necessários para teste.
* **AC-T20-02** `POST /api/sessions/:id/groups/:groupId/participants { targetSessionId }` adiciona uma sessão.
* **AC-T20-03** A operação possui limite de frequência por sessão.
* **AC-T20-04** Toda operação é auditada com sessão, grupo, alvo, resultado e ator.
* **AC-T20-05** A operação funciona entre os containers através da ponte interna.
* **AC-T20-06** O dashboard apresenta a ação na página de grupos e mostra o resultado da operação.

A operação é manual e autenticada. Não existe endpoint de lote.

---

## 6. Scripts de verificação

Os scripts permanecem responsáveis por:

1. verificar arquivos obrigatórios;
2. executar typecheck, lint e testes;
3. verificar regras de segurança;
4. verificar escopo;
5. verificar cobertura dos ACs;
6. executar as suítes de aceitação;
7. gerar os relatórios.

Os checks devem verificar somente comportamentos que fazem parte do contrato atual.

Não devem existir verificações de funcionalidades removidas do escopo.

---

## 7. Prompts de despacho

Os prompts de Operário, Tester e Orquestrador permanecem iguais, removendo apenas referências a requisitos históricos que não estejam presentes nos critérios atuais.

### Operário

```text
Você é OPERÁRIO na tarefa {Txx} — {título}.

Leia wa-session-manager/spec/SPEC.md:
seções 1, 3 e a tarefa {Txx} inteira.

Escreva SOMENTE dentro dos Paths da tarefa.
Não toque em tests/acceptance/**.

Implemente os entregáveis e atenda a todos os critérios AC-{Txx}-nn.

Escreva testes unitários (*.unit.test.ts) para a lógica criada.

Antes de reportar, rode:

node spec/verify/verify.mjs {Txx} --role operario

O comando precisa terminar com exit 0.

Ao terminar, reporte:

maestri ask "{Orquestrador}" "<relatório no formato da seção 2.3>"

Dúvida de requisito → reporte BLOCKED com a pergunta.
Não invente requisitos.
```

### Tester

```text
Você é TESTER na tarefa {Txx} — {título}.

Leia wa-session-manager/spec/SPEC.md:
seções 1, 3 e a tarefa {Txx} inteira.

Escreva testes de aceitação em:

tests/acceptance/{Txx}/

Cada critério deve possuir pelo menos um teste cujo título contenha seu ID.

Teste o comportamento pelos contratos públicos da tarefa.

Use FakeTransport quando houver transporte WhatsApp envolvido.
Nunca conecte ao WhatsApp real.

Não edite apps/** nem packages/**.

Quando a implementação estiver pronta, rode:

node spec/verify/verify.mjs {Txx} --role tester

Reporte:

maestri ask "{Orquestrador}" "<relatório no formato da seção 2.3>"
```

### Orquestrador

```text
Você é o ORQUESTRADOR do projeto wa-session-manager.

Leia wa-session-manager/spec/SPEC.md inteiro e siga o protocolo da seção 2.

Você não escreve código de produto nem testes.

Use maestri list para verificar os agentes disponíveis.

Despache por onda usando maestri ask --batch.

Execute os verifies correspondentes e mantenha spec/STATUS.md atualizado.

Uma tarefa só vira ACCEPTED quando Operário e Tester terminarem com exit 0.

Após 3 rejeições da mesma tarefa, escale ao humano.
```
