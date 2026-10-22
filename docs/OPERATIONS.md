# Operating MOTIF Cloud

`docker compose up` starts PostgreSQL and the API on :8787. Configure with env vars:

| Var | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (migrations run on boot, advisory-locked) |
| `PUBLIC_URL` | Public base URL of the API (used in signed local-storage links) |
| `WEB_URL`, `CORS_ORIGINS` | Web app origin(s) |
| `STORAGE_DIR` + `STORAGE_SIGNING_SECRET` | Local object storage (default) |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3-compatible storage instead |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` | Billing (disabled and reported as such when unset) |

Web app: `NEXT_PUBLIC_API_URL=https://api.example.com pnpm --filter @motif/web build` → deploy `apps/web/out` to any static host.
Desktop: set the server in Cloud → Server, or `MOTIF_CLOUD_URL`.
Health: `/healthz` (process), `/readyz` (database). Stripe webhook endpoint: `POST /v1/billing/webhook` (events: checkout.session.completed, customer.subscription.updated/deleted).
Backups: PostgreSQL dumps + object store versioning. Make a user admin: `update users set is_admin=true where email=...`.
