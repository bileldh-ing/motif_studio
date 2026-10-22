# Project status

_Last updated: 2026-10-22 (v0.3.0)_

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, schema/timebase ADRs, technical spike (2 tracks, overlay, title, crossfade, keyframes, audio, real export, preview-vs-export pixel checks) | **Done** |
| 1 | Electron shell, secure IPC, home/recent/new/open, autosave + recovery, settings, menus, shortcuts | **Done** (light theme, command palette pending) |
| 2 | Media import/probe, thumbnails, filmstrips, waveforms, bin search/sort/favorites, missing media + relink | **Mostly done** (proxy generation exists in engine; UI toggle pending; bins/folders pending) |
| 3 | Timeline model + ops, undo/redo, snapping, markers, virtualization, save/reopen | **Done** (multi-select drag, copy/paste pending) |
| 4 | Render graph, presets, queue/progress/cancel, verification, logs | **Done** (single job at a time; queue UI pending) |
| 5 | Keyframes, transitions, color, audio mix/fades, titles, captions/SRT, speed | **Done** for shipped tools (masks, chroma key, freeze/reverse, crop/flip, shapes); blend modes, LUTs, speed curves pending |
| 6 | Speech/AI | **Done** (local): Whisper captions, TTS, denoise, voice changer, stabilization, silence removal; segmentation/auto-reframe planned |
| 7 | SaaS (web app, API, Postgres, auth, billing, cloud sync) | **Done**: Fastify API + PostgreSQL migrations, auth + device flow, workspaces/roles, versioned cloud projects + conflicts, signed media transfer, Stripe webhooks/entitlements/usage, audit/admin, Next.js web app, desktop sync UI. Email verification, MFA, account deletion endpoint pending |
| 8 | Packaging, signing, auto-update, telemetry opt-in | **Done (unsigned)**: CI builds Win NSIS/appx, macOS dmg/zip, Linux AppImage/deb/snap with bundled FFmpeg; packaged-app launch check; tag release with checksums; auto-update; crash log; diagnostics; no telemetry. Signing activates when certificates are added as secrets |

## Test status

- `pnpm test`: editor-core 20 + render-engine 8 + effects 19 + API 17 + desktop⇄cloud sync 3 (real PostgreSQL, real HTTP, signed storage).
- Desktop smoke (`MOTIF_SMOKE_DIR`): 25+ UI steps incl. Whisper captions, TTS, 4K export, cloud sign-in dialog, updater state.
- CI (GitHub Actions): typecheck, tests on Debian trixie + FFmpeg 7.1 + PostgreSQL 17, web build, API container boot, Electron smoke under Xvfb, installers on Windows/macOS/Linux, CodeQL.
- `tsc` strict: clean for all packages, API, web and the desktop app.

## Known limitations

- Preview colour adjust uses CSS filters; export uses FFmpeg `eq`. Small differences in brightness curve.
- Preview keyframes on text clips evaluate position only; export matches.
- Rotation is static (not keyframable) in this release; opacity keyframes not exposed.
- Only one render at a time; no background queue across app restarts.
- No drop-frame timecode display for 29.97/59.94 (non-drop shown).

## Next actionable steps

1. Code-signing certificates (Windows Authenticode, Apple Developer ID) → add secrets per docs/RELEASE.md.
2. Email verification, MFA, account deletion endpoint; MinIO integration test for the S3 driver.
3. Blend modes, LUT import, speed curves; background segmentation and auto-reframe.
4. Proxy toggle in media bin; render queue UI.


## v0.2.0 — 2026-10-21 · Liquid glass + CapCut-class tools
- New liquid-glass UI (floating frosted panels, icon rail with glass tooltips, floating transport pill, orange playhead, violet clips, cyan waveforms), Figma-style custom cursors per tool/target, cursor chips while dragging, on-canvas move/scale/rotate handles with centre snapping, command palette (Ctrl+K).
- Tools: blade/select/hand, copy/paste, freeze frame, reverse, crop/mirror/flip, masks, chroma key, blur background fill, shapes, 10 filter looks + 10 adjustments, 7 transitions, in/out animations, rotation keyframes, text fonts/stroke/shadow presets.
- Audio/AI (all local): Whisper auto captions, flite text-to-speech, noise reduction, voice pitch, extract audio, vid.stab stabilization.
- Export: 480p–4K + custom, 24–60 fps, H.264/HEVC/AV1/VP9/ProRes, CRF or bitrate, GIF, audio-only, PNG still; size estimate.
- Schema v2 with v1→v2 migration. See docs/CAPCUT_RESEARCH.md for the parity matrix.
- Tests: 20 editor-core + 8 render + 19 effects tests (pixel-verified), UI smoke 20+ steps incl. real 4K export.


## v0.3.0 — 2026-10-22 · Cloud, store-ready packaging, CI/CD
See CHANGELOG.md. Cloud API + web app + desktop sync, release engineering (installers, auto-update, crash recovery, diagnostics), full CI/CD and an automated tutorial-video pipeline (recorded from the real app, narrated offline with Piper, edited and rendered by MOTIF's own engine).
