# ADR-002: Criptografia Determinística para CPF em Repouso

**Status**: Aceito  
**Data**: 2026-06-29

## Contexto

FR-014 exige criptografia de CPF em repouso. O campo `outbox.aggregate_id` armazena o CPF do paciente e é usado em queries de igualdade (`WHERE aggregate_id = $1`) para verificação de idempotência em `hasRecentSuccess()`.

## Decisão

Usar **AES-256-GCM com IV determinístico** derivado de `HMAC-SHA256(key, plaintext)`. O mesmo CPF sempre produz o mesmo ciphertext com a mesma chave, permitindo queries de igualdade sem expor o valor original.

## Consequências

**Positivas**:
- Queries `WHERE aggregate_id = $1` funcionam sem mudanças no schema
- AuthTag de 128 bits garante integridade (detecta adulteração)
- Sem alteração de performance perceptível nas queries

**Negativas**:
- IV determinístico elimina IND-CPA (segurança semântica): um atacante com dois ciphertexts do mesmo CPF sabe que são iguais. Aceitável pois o banco é controlado e não é um oráculo público.
- Rotação de chave requer re-criptografia de todos os registros existentes

## Alternativas Consideradas

- **AES-256-GCM com IV aleatório**: Semanticamente seguro mas impossibilita queries de igualdade sem mudança de arquitetura (e.g., armazenar hash separado para lookup)
- **AES-256-SIV**: Oferece determinismo com garantias formais mais fortes, mas não disponível nativamente no Node.js `crypto`
- **Tokenização via tabela de mapeamento**: Complexidade adicional sem ganho proporcional para este caso de uso
