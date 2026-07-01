# Research: Worker HTTP API (Feature 003)

## D1 — Framework HTTP: Fastify

**Decision**: Fastify v5

**Rationale**:
- Tipos TypeScript nativos (sem `@types/fastify` separado) — alinha com strict mode do projeto
- ESM-native: funciona limpo com `"type": "module"` sem workarounds
- Sistema de plugins/hooks (`onRequest`) é mais simples que middleware Express para auth global
- `fastify.inject()` permite testes de rota sem subir servidor real
- Uma única dependência (`fastify`) — atende a restrição de "mínimo de pacotes novos"

**Alternatives considered**:
- Express: requer `@types/express` separado, middleware chain menos ergonômica em TypeScript strict, ESM tem edge cases; descartado
- Node.js `http` nativo: sem roteamento, validação ou body parsing embutidos — adicionaria código equivalente ao próprio framework; descartado

---

## D2 — Integração no mesmo processo (sem fork/cluster)

**Decision**: Fastify sobe dentro de `src/index.ts` ao lado do cron, compartilhando o mesmo `Pool` pg.

**Rationale**:
- Spec exige "mesmo processo Node.js"
- O `Pool` já é singleton (`getPool()`); a API recebe referência direta
- Shutdown gracioso: `fastify.close()` é chamado junto com `task.stop()` e `closePool()`
- Sem overhead de IPC ou serialização entre processos

**How**:
```typescript
const api = await buildApiServer(pool, config);
await api.listen({ port: config.workerApiPort, host: '0.0.0.0' });
// em shutdown:
await api.close();
```

---

## D3 — Autenticação: Fastify `onRequest` hook global

**Decision**: Um único `onRequest` hook registrado globalmente, com exceção explícita para `GET /health`.

**Rationale**:
- Spec: middleware único comparando com `WORKER_API_SECRET`
- Hook global com `if (request.url === '/health') return` cobre o caso sem plugin separado
- Comparação timing-safe (`timingSafeEqual` de `node:crypto`) para evitar timing attacks

**Alternatives considered**:
- Fastify plugin de auth por prefixo: mais complexo, desnecessário para um único secret
- Variável de ambiente sem timing-safe compare: vulnerável a timing attack, descartado

---

## D4 — Paginação por cursor

**Decision**: Cursor opaco = `base64(JSON.stringify({ created_at: ISO8601, id: UUID }))`, aplicado como cláusula `(created_at, id) < ($cursor_ts, $cursor_id)` com `ORDER BY created_at DESC, id DESC`.

**Rationale**:
- Estável sob inserções concorrentes (usa `id` UUID como tiebreaker)
- Não expõe offset ou dados internos ao consumidor (opaco)
- Compatível com índice existente `idx_outbox_pending` (precisa de índice adicional `idx_outbox_tenant_created` para listagem por tenant)

**Cursor encoding**:
```typescript
function encodeCursor(created_at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: created_at.toISOString(), i: id })).toString('base64url');
}
function decodeCursor(cursor: string): { t: string; i: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString());
}
```

---

## D5 — CPF masking nas respostas da API

**Decision**: Reutilizar a função `maskCpf` de `src/lib/logger.ts` extraída para `src/lib/mask.ts`, aplicada em toda resposta que contenha `aggregate_id` do outbox.

**Rationale**:
- `safeLog()` já mascara CPF em logs; reutilizar a regex é consistente
- O `aggregate_id` é descriptografado via `decrypt()` antes de retornar; depois mascarado
- Formato: `***.XXX.YYY-**` (grupos centrais visíveis, extremos mascarados)
- `credentials` do `erp_connections`: campo nunca incluído nas queries de leitura da API

**Implementation**:
- Mover `maskCpf` e `CPF_REGEX` de `logger.ts` para `lib/mask.ts`
- Re-exportar de `logger.ts` para manter retrocompatibilidade
- Aplicar em `src/api/routes/outbox.ts` ao serializar cada registro

---

## D6 — Sync-status: agregação via audit_log + sync_state

**Decision**: `GET /tenants/:tenantId/sync-status` retorna um array por `erp_name` ativo do tenant, cruzando dados de `sync_state` (last_synced_at) com contadores do `audit_log` do dia corrente (UTC).

**SQL pattern**:
```sql
SELECT
  ec.erp_name,
  ss.last_synced_at,
  COALESCE(SUM((al.details->>'fetched')::int)  FILTER (WHERE al.action = 'sync_cycle.complete'), 0) AS fetched_today,
  COALESCE(SUM((al.details->>'enqueued')::int) FILTER (WHERE al.action = 'sync_cycle.complete'), 0) AS enqueued_today,
  COUNT(*) FILTER (WHERE al.action = 'delivery.success')  AS delivered_today,
  COUNT(*) FILTER (WHERE al.action = 'delivery.failed')   AS failed_today
FROM erp_connections ec
LEFT JOIN sync_state ss ON ss.tenant_id = ec.tenant_id AND ss.erp_name = ec.erp_name
LEFT JOIN audit_log al ON al.tenant_id = ec.tenant_id
  AND al.erp_name = ec.erp_name
  AND al.timestamp >= date_trunc('day', now() AT TIME ZONE 'UTC')
WHERE ec.tenant_id = $1 AND ec.is_active = true
GROUP BY ec.erp_name, ss.last_synced_at
```

**next_sync_at**: `last_synced_at + interval 'POLLING_INTERVAL_MINUTES minutes'` calculado em TypeScript.

---

## D7 — PUT field_mappings / event_mappings: substituição integral em transação

**Decision**: `PUT /tenants/:id/field-mappings/:erpName` executa `DELETE WHERE (tenant_id, erp_name) = ($1, $2)` seguido de `INSERT` em uma única transação no pg client.

**Rationale**:
- Semântica de substituição integral (spec FR-006, FR-007)
- Transação garante atomicidade — sem estado intermediário vazio visível ao worker
- Mais simples que UPSERT com chave composta em arrays dinâmicos

---

## D8 — DB_SCHEMA / search_path no pool principal

**Decision**: Adicionar `DB_SCHEMA` (padrão: `integrations`) ao `ConfigSchema` e configurar `search_path` via pool `connect` event em `src/db/index.ts`.

**Rationale**:
- Crítico: sem `search_path`, queries em produção (Supabase) não encontram tabelas no schema `integrations`
- O mesmo padrão já usado no `migrate.ts` (via `client.query('SET search_path TO ...')`)
- `pool.on('connect', client => client.query(...))` é o padrão recomendado pelo `pg`

**Implementation** (fix necessário antes da API):
```typescript
// src/db/index.ts
pool.on('connect', (client) => {
  void client.query(`SET search_path TO ${config.dbSchema}`);
});
```
```typescript
// src/config/index.ts
dbSchema: z.string().default('integrations'),
```

**Note**: O `void` silencia a Promise — aceitável aqui porque o `pg` pool já lida com erros de connect via `pool.on('error')`.
