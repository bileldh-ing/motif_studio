# Feature matrix

| Area | Feature | Status |
|---|---|---|
| Home | New/open/recent/search/rename/duplicate/remove, demo, recovery prompt | implemented |
| Home | Templates, cloud projects, AI create | planned (disabled in UI) |
| Media | Import (dialog, drag-drop), ffprobe metadata, VFR/rotation detection | implemented |
| Media | Thumbnails, filmstrips, waveforms, favorites, search/sort/filter, dedupe | implemented |
| Media | Missing media + relink | implemented |
| Media | Proxies | partial (engine `makeProxy`; no UI) |
| Media | Bins/folders, tags UI | planned |
| Timeline | Tracks add/remove/rename/hide/mute/solo/lock | implemented |
| Timeline | Move, trim, split, ripple delete, lift, duplicate, speed | implemented |
| Timeline | Snapping, markers, in/out, zoom/fit, virtualization, undo/redo | implemented |
| Timeline | Copy/paste, multi-clip drag, freeze frame, reverse, nested sequences | planned |
| Preview | Canvas compositor, playback + audio, frame step, quality levels | implemented |
| Effects | Transform + keyframes (x, y, scale), rotation, opacity | implemented |
| Effects | Brightness/contrast/saturation | implemented |
| Effects | Crossfade | implemented |
| Effects | Masks, chroma key, blend modes, LUTs, blur | planned |
| Text | Titles, captions, lower third, box, color, size, position | implemented |
| Captions | SRT import/export, burn-in | implemented |
| Captions | Speech-to-text | planned (needs Whisper worker) |
| Audio | Gain, pan, fades, track volume, mute/solo | implemented |
| Audio | Denoise, ducking, EQ | planned |
| AI | Silence detection + remove | implemented (local, FFmpeg) |
| AI | Background removal, reframe, TTS, generation | planned |
| Export | Presets, CRF, speed, fps match, range, progress/ETA, cancel, verify, log | implemented |
| Export | Batch queue, hardware encoders, ProRes UI | planned |
| SaaS | Web app, API, auth, billing, sync, admin | not started |
| Release | electron-builder configs | partial (unsigned) |

## v0.3 additions (Phase 7–8)

| Feature | Status | Acceptance / tests |
|---|---|---|
| Email/password accounts (scrypt), sessions (hashed tokens), logout | Done | api.test identity |
| Desktop device sign-in (browser approval code) | Done | api.test device flow, sync.test |
| Workspaces, owner/editor/viewer roles, seat limits | Done | api.test roles/seats |
| Tenant isolation (404 for non-members) | Done | api.test isolation, sync.test |
| Cloud project versions, optimistic concurrency (409), restore | Done | api.test, sync.test conflict |
| Signed media upload/download (HMAC local, S3 SigV4), SHA-256 integrity, dedupe, quotas | Done (S3 driver not integration-tested) | api.test media, sync.test tamper |
| Plans, entitlements, usage ledger (idempotent) | Done | api.test billing |
| Stripe checkout/portal, signed idempotent webhooks | Done (needs Stripe keys to go live) | api.test webhooks |
| Audit log, admin stats/users/plan override | Done | api.test audit |
| Web app: marketing, auth, projects/history/restore, plan & usage, team, device approval, admin | Done | CI next build |
| Desktop Cloud UI: sign in, upload/sync, conflict dialog, open any version | Done | smoke (signed-out), sync.test (client) |
| Installers: NSIS, appx, dmg/zip, AppImage, deb, snap; bundled FFmpeg | Done (unsigned) | CI package + packaged launch check |
| Auto-update (GitHub Releases), crash log + renderer recovery, diagnostics bundle, single instance, file association | Done | smoke (updater state) |
| Email verification, MFA, account deletion API | Planned | — |
