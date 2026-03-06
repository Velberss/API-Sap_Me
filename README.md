SAP Knowledge Search API
=======================

Serviço em camadas que automatiza o login no portal me.sap.com para executar buscas na Knowledge Search oficial da SAP e expõe os resultados como uma API REST simples.

### Stack

- Node.js + TypeScript
- Express 5
- Playwright + Puppeteer stealth helpers
- Zod para validação de payloads
- Pino para logging estruturado

## Objetivo

Esta API centraliza a autenticação em `me.sap.com` (com cache de sessão e retries) e, a partir de uma query textual, retorna os registros mais relevantes encontrados na Knowledge Search. Serve como base para automatizar integrações internas que precisam consultar a base de conhecimento SAP sem acesso direto ao portal.

## Pré-requisitos

1. Node.js 20+ instalado localmente.
2. Credenciais SAP válidas com acesso ao portal `me.sap.com` (são utilizadas diretamente no fluxo de login).
3. Browser Chromium compatível com a versão do Playwright instalada (a configuração padrão baixa automaticamente o binário necessário).

## Instalação

```bash
npm install
```

## Configuração de ambiente

1. Duplique o arquivo `.env.example` para `.env`.
2. Ajuste os valores conforme seu ambiente (desenvolvimento, homologação ou produção).

| Variável | Valor padrão | Descrição |
| --- | --- | --- |
| `NODE_ENV` | `development` | Define o modo para carregar `dotenv` e logs. |
| `PORT` | `3000` | Porta onde o Express irá escutar. |
| `LOG_LEVEL` | `info` | Nível mínimo de log (`debug`, `info`, `warn`, `error`). |
| `SAP_USERNAME` | sem valor | Email/usuário usado para autenticar no portal SAP (obrigatório). |
| `SAP_PASSWORD` | sem valor | Senha do usuário SAP (obrigatório). |
| `SAP_SESSION_TTL_MINUTES` | `20` | Tempo em minutos para considerar a sessão válida antes de renovar. |
| `SAP_BROWSER_HEADLESS` | shared -> config -> env.ts -> '`true` | Controla se o Playwright abre o Chromium em modo headless (`false` para ver o navegador)'. |
| `SAP_LOGIN_MAX_ATTEMPTS` | `3` | Número máximo de tentativas de login antes de falhar. |

> As variáveis acima habilitam o fluxo real descrito abaixo: o `AuthSessionManager` realiza login no SAP ID Service, mantêm o cache de cookies e o `SapSearchAutomation` extrai resultados diretamente do Knowledge Search.

## Executando a API

### Desenvolvimento

```bash
npm run dev
```

Roda `tsx watch src/server.ts`, recompila o código em memória e reinicia a cada alteração.

### Produção

```bash
npm run build
npm start
```

Compila o TypeScript para `dist/` e roda o bundle em Node 20+. As dependências do Playwright já estão incluídas no build.

## Endpoints expostos

### `POST /search`

- **Objetivo:** executa uma busca textual na Knowledge Search SAP com os cookies de sessão autenticada.
- **Conteúdo:** `application/json`
- **Autenticação:** automática, baseada nas variáveis SAP_USERNAME/SAP_PASSWORD e no fluxo de autenticação implementado em `AuthSessionManager`.

#### Payload esperado

```json
{
  "query": "erro 31025"
}
```

- `query` (string, obrigatório): termo livre utilizado para filtrar artigos, notas e KBAs.

#### Exemplo de requisição curl

```bash
curl -X POST http://localhost:3000/search \H "Content-Type: application/json" \-d '{"query":"SAP HANA memory"}'
```

#### Resposta de sucesso (200)

```json
[
  {
    "title": "1999997 - FAQ: SAP HANA Memory",
    "link": "https://me.sap.com/notes/1999997/E"
  },
  {
    "title": "2926166 - How to limit the overall SAP HANA memory allocation",
    "link": "https://me.sap.com/notes/2926166/E"
  }
]
```

- Retorna um array de `KnowledgeArticle` com os campos `title` e `link` (strings). Os resultados são extraídos diretamente do portal SAP e podem variar conforme a query e o estado da base.

### `GET /health`

- Endpoint simples para monitoramento (`{ status: "ok" }`). Deve responder `200` assim que a API estiver pronta para receber requisições.

## Tratamento de erros e códigos de status

| Código | Origem | Formato | Quando ocorre |
| --- | --- | --- | --- |
| `400 ValidationError` | `Zod` | `{ code, message, details }` | Payload ausente ou `query` vazio. |
| `401 SAP_SESSION_EXPIRED` | `AuthSessionManager` / Playwright | `{ code, message }` | Cookies expirados e não há login válido. O gerenciador tenta novas tentativas antes de expirar. |
| `424 SAP_SEARCH_INPUT_NOT_FOUND` | Automação Playwright | `{ code, message }` | Campo de busca não encontrado no UI5 da SAP. Validar seletores ou atualizá-los conforme HTML real. |
| `424 SAP_SEARCH_FAILED` | Automação Playwright | `{ code, message }` | Falha genérica durante a navegação ou extração de resultados. |
| `500 INTERNAL_ERROR` | Handler genérico | `{ code, message }` | Qualquer exceção não prevista (ex: conexão com SAP). |

> O middleware `errorHandler` uniformiza a saída, garantindo sempre os campos `code` e `message`.

## Observações operacionais

1. `AuthSessionManager` mantém cache em memória e renova sessões após `SAP_SESSION_TTL_MINUTES`. Em ambientes com múltiplas instâncias, sincronize esse cache (Redis, etc.) ou force novos logins para garantir consistência.
2. O fluxo usa o Chromium controlado pelo Playwright (`SapAuthProvider` + `SapSearchAutomation`). Definir `SAP_BROWSER_HEADLESS=false` permite inspecionar o navegador e os seletores; capturas são armazenadas em `debug-output/` quando `NODE_ENV=development`.
3. Em produção, coloque `SAP_USERNAME` e `SAP_PASSWORD` em um cofre de segredos em vez de arquivos locais e limite o acesso às variáveis de ambiente.
4. `POST /search` realiza login real + navegação no SAP e, portanto, pode levar vários segundos. Ajuste timeouts do cliente, monitore o tempo de execução nos logs e acione circuit breakers se necessário.