# Backend

The optional Fastify + Postgres service for wallet-signature auth, profiles and
settings storage, and IPFS image and metadata pinning. The dApp runs without
it; the frontend calls the service only for those features.

## Setup

1. Copy the environment template and set the required values:

   ```bash
   cp .env.template .env
   ```

   `SESSION_SECRET` must be at least 32 bytes. Generate one with
   `openssl rand -hex 32`. The server rejects a missing value, a known
   placeholder, or a value shorter than 32 bytes at startup.

   `APP_DOMAIN` and `APP_URI` must match the frontend origin exactly. Wallets
   hash the domain into the ARC-60 signing input.

2. Start Postgres and apply the migrations:

   ```bash
   docker compose up -d
   npm run db:migrate
   ```

3. Start the service:

   ```bash
   npm run dev
   ```

   The API listens on `http://127.0.0.1:3001` by default. Set `PORT` to change
   it.

## Checks

Run the checks from this directory:

```bash
npm run check-types
npm run lint
npm run format
npm run test:coverage
```

The tests create and migrate a throwaway `kasakame_test` database, so
`DATABASE_URL` must point at a running Postgres instance.

## Related docs

- [`../../docs/architecture.md`](../../docs/architecture.md) describes the
  service's role in the protocol.
- [`../../docs/frontend.md`](../../docs/frontend.md) covers the frontend
  integration.
