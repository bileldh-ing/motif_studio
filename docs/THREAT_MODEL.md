# Threat model (v0.3)

| Asset | Threat | Mitigation | Test |
|---|---|---|---|
| Renderer → OS | XSS / remote content gains Node access | contextIsolation, sandbox, no nodeIntegration, typed preload API only, IPC sender check + zod validation, navigation & window.open blocked | smoke test, code review |
| Local media | Renderer reads arbitrary files | `motif-media://` serves only imported/opened assets | smoke |
| Accounts | Credential stuffing | scrypt, constant-work login, rate limits (8/min login, 10/min signup) | api.test "rate-limits" |
| Sessions | Token theft from DB | only SHA-256 of tokens stored; desktop token encrypted via safeStorage | api.test "token hashes" |
| Tenancy | Cross-workspace access by guessed IDs | membership enforced in SQL on every query; 404 for non-members | api.test "isolates tenants" |
| Media transfer | Link sharing / tampering | HMAC or SigV4 signed URLs, 15 min expiry, signed size; SHA-256 verified on complete and on download | api.test, sync.test "tampered" |
| Billing | Forged webhooks / replays | Stripe signature verification, idempotent `webhook_events` | api.test "billing" |
| Concurrency | Lost updates across devices | optimistic versioning, row lock, explicit overwrite | api.test, sync.test |
| Supply chain | Malicious deps | lockfile, Dependabot, CodeQL, bundled FFmpeg from pinned 7.1 builds | CI |
| Updates | Malicious update | electron-updater sha512 manifest + code signature verification (Windows/macOS when signed) | release checklist |

Open items: signed installers need certificates; MFA and email verification are planned; S3 driver should get an integration test against MinIO.
