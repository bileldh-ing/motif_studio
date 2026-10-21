# Project status

_Last updated: 2026-10-21_

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, schema/timebase ADRs, technical spike (2 tracks, overlay, title, crossfade, keyframes, audio, real export, preview-vs-export pixel checks) | **Done** |
| 1 | Electron shell, secure IPC, home/recent/new/open, autosave + recovery, settings, menus, shortcuts | **Done** (light theme, command palette pending) |
| 2 | Media import/probe, thumbnails, filmstrips, waveforms, bin search/sort/favorites, missing media + relink | **Mostly done** (proxy generation exists in engine; UI toggle pending; bins/folders pending) |
| 3 | Timeline model + ops, undo/redo, snapping, markers, virtualization, save/reopen | **Done** (multi-select drag, copy/paste pending) |
| 4 | Render graph, presets, queue/progress/cancel, verification, logs | **Done** (single job at a time; queue UI pending) |
| 5 | Keyframes, transitions, color, audio mix/fades, titles, captions/SRT, speed | **Partial**: shipped tools listed in README; masks, chroma key, blend modes, LUTs, freeze/reverse pending |
| 6 | Speech/AI | **Started**: local silence detection shipped; Whisper STT worker, segmentation planned |
| 7 | SaaS (web app, API, Postgres, auth, billing, cloud sync) | **Not started** |
| 8 | Packaging, signing, auto-update, telemetry opt-in | **Partial**: electron-builder configs for linux/win/mac; unsigned; not smoke-tested on Win/mac |

## Test status (this machine: Linux arm64, 2 vCPU, FFmpeg 7.1.5)

- `pnpm test`: 28 tests (editor-core 20, render-engine 8), all passing.
- Desktop smoke (`MOTIF_SMOKE_DIR`): 10/10 steps passing, including an export through IPC that verifies.
- `tsc` strict: clean for all packages and the desktop app.

## Known limitations

- Preview colour adjust uses CSS filters; export uses FFmpeg `eq`. Small differences in brightness curve.
- Preview keyframes on text clips evaluate position only; export matches.
- Rotation is static (not keyframable) in this release; opacity keyframes not exposed.
- Only one render at a time; no background queue across app restarts.
- No drop-frame timecode display for 29.97/59.94 (non-drop shown).

## Next actionable steps

1. Proxy toggle in media bin + use proxies in preview.
2. Whisper (faster-whisper) local worker behind an optional Python service, wired to Captions tab.
3. Masks/chroma key/blend modes with render parity tests.
4. Phase 7: Fastify API + Postgres (Drizzle) + S3 storage + Stripe test-mode, Next.js account app.
