# Quickstart: Tasy-Ávimus Sync

## Prerequisites

- Node.js 20+ LTS
- PostgreSQL 14+ with `pgcrypto` extension
- Access to Tasy ERP API
- Ávimus API token with patient/journey/step permissions

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.example .env

# 3. Configure environment variables (see below)
# Edit .env with your values

# 4. Run database migrations
npm run db:migrate

# 5. Start the service
npm start
```

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/avimus_integrations

# Ávimus API
AVIMUS_API_URL=https://api.avimus.example.com
AVIMUS_API_TOKEN=your_bearer_token_here

# Tasy ERP
TASY_BASE_URL=http://192.168.80.190:9001

# ERP Selection (comma-separated)
ERP_NAMES=tasy

# Encryption key for sensitive data at rest
ENCRYPTION_KEY=your_256_bit_hex_key_here

# Service
NODE_ENV=development
LOG_LEVEL=info
INITIAL_LOOKBACK_HOURS=24
MAX_RETRIES=3
```

## Development

```bash
# Run in development mode (with file watching)
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type check
npm run typecheck

# Lint
npm run lint
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  ERP Adapter │────▶│ Poller       │────▶│ Transformer  │────▶│ Outbox Worker │
│  (ERP-aware) │     │ (ERP-agnostic)│     │ (ERP-agnostic)│     │ (ERP-agnostic)│
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
     │                    │                    │                    │
     │                    │                    │                    │
   Tasy API          sync_state             Ávimus API          Ávimus API
                   + outbox table          (patient/           (step complete)
                                            journey/step)
```

## Data Flow

1. **Cron triggers** every 10 minutes (configurable per ERP)
2. **Poller** reads `last_synced_at` from `sync_state`, calls adapter's `fetchRecentEvents(since)`
3. **Adapter** translates ERP-specific API response to normalized `RawEvent[]`
4. **Transformer** matches patient by CPF, finds active journey, identifies correct step
5. **Outbox** persists transformed payload with status `pendente`
6. **Outbox Worker** picks pending records, delivers to Ávimus API via PATCH
7. **On success**: status → `enviado`. **On failure**: retry up to 3x, then → `falhou`

## Adding a New ERP

1. Create `src/adapters/{name}/index.ts` implementing `ErpAdapter`
2. Add factory to `src/config/erp-registry.ts`
3. Add env vars for the new ERP
4. Set `ERP_NAMES=tasy,{name}` to enable both

No changes to core services required.
