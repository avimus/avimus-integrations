-- ============================================================
-- Migration 006: Per-tenant Ávimus API token
-- ============================================================
-- AVIMUS_API_TOKEN era uma única credencial global em .env, usada para
-- TODAS as chamadas à API do Ávimus Patient Journey, independente de qual
-- tenant do worker gerou o evento — isso fazia com que todo evento fosse
-- entregue sob a identidade de um único tenant do patient-journey, mesmo
-- vindo de hospitais diferentes. Cada tenant do worker passa a ter seu
-- próprio token (JWT do Supabase de um usuário daquele tenant específico no
-- patient-journey), criptografado como as demais credenciais.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS avimus_api_token TEXT;
