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


## v0.2.0 — 2026-10-21 · Liquid glass + CapCut-class tools
- New liquid-glass UI (floating frosted panels, icon rail with glass tooltips, floating transport pill, orange playhead, violet clips, cyan waveforms), Figma-style custom cursors per tool/target, cursor chips while dragging, on-canvas move/scale/rotate handles with centre snapping, command palette (Ctrl+K).
- Tools: blade/select/hand, copy/paste, freeze frame, reverse, crop/mirror/flip, masks, chroma key, blur background fill, shapes, 10 filter looks + 10 adjustments, 7 transitions, in/out animations, rotation keyframes, text fonts/stroke/shadow presets.
- Audio/AI (all local): Whisper auto captions, flite text-to-speech, noise reduction, voice pitch, extract audio, vid.stab stabilization.
- Export: 480p–4K + custom, 24–60 fps, H.264/HEVC/AV1/VP9/ProRes, CRF or bitrate, GIF, audio-only, PNG still; size estimate.
- Schema v2 with v1→v2 migration. See docs/CAPCUT_RESEARCH.md for the parity matrix.
- Tests: 20 editor-core + 8 render + 19 effects tests (pixel-verified), UI smoke 20+ steps incl. real 4K export.
