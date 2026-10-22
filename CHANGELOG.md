# Changelog

## [0.3.0] - 2026-10-22
### Added
- **MOTIF Cloud API** (`apps/api`): Fastify + PostgreSQL (Drizzle, forward-only SQL migrations), scrypt passwords, hashed session tokens, desktop device sign-in, workspaces with owner/editor/viewer roles, versioned cloud projects with optimistic concurrency (409 conflicts), restore, signed + expiring media transfer (local HMAC or S3/R2/MinIO SigV4) with SHA-256 integrity and dedupe, plan entitlements and quotas, usage ledger, Stripe checkout/portal and signature-verified idempotent webhooks, audit log, admin endpoints, rate limiting, health/readiness, Docker image and compose stack.
- **Web app** (`apps/web`, Next.js static export): marketing, pricing, downloads, sign up/in, cloud projects with version history and restore, plan & usage, team members, desktop device approval, admin.
- **Desktop cloud sync**: sign in with browser (device code) or email, token encrypted with the OS keychain, upload/sync with version notes, conflict dialog (keep both / overwrite), open any cloud version, honest local-only mode when signed out.
- **Release operations**: electron-builder targets for Windows (NSIS, Microsoft Store appx), macOS (dmg/zip, hardened runtime, notarization hook, MAS entitlements) and Linux (AppImage, deb, snap); bundled FFmpeg 7.1; auto-update from GitHub Releases; crash logging and renderer recovery; diagnostic bundle; single-instance lock; `.motif` file association; app icon.
- **CI/CD**: typecheck, full test suite on Debian trixie + PostgreSQL 17 + Whisper, web build, API container boot test, Electron UI smoke test under Xvfb, unsigned installers for 3 OSes with packaged-app launch check, tag-driven signed releases with checksums and store packages, CodeQL, Dependabot.
- Tutorial/demo video pipeline (`scripts/demo-video`).

## [0.2.0] - 2026-10-21
- Liquid-glass UI, Figma-style tools & cursors, on-canvas transforms, command palette, CapCut-class effects, local AI (Whisper captions, TTS, stabilization, denoise, voice changer), export 480p–4K with H.264/HEVC/AV1/VP9/ProRes, GIF, audio-only and PNG.

## [0.1.0] - 2026-10-21
- Project schema, editor core, FFmpeg render engine with verified exports, Electron shell.
