# Third-party notices

MOTIF Studio © 2026 Bilel Dhahri. This product includes or uses the following third-party software. Exact versions are pinned in `pnpm-lock.yaml`.

## Bundled in the desktop app
- **Electron**, Chromium, Node.js — MIT / BSD-style (see the Electron LICENSES.chromium.html shipped with the app).
- **React**, **react-dom** — MIT. **zod** — MIT. **electron-updater** — MIT.
- **Fonts** (apps/desktop/src/renderer/public/fonts): Poppins, Bebas Neue, Anton, Playfair Display, Lobster, Pacifico — SIL Open Font License 1.1 (OFL texts included); DejaVu — Bitstream Vera / public-domain-style license.
- **FFmpeg / FFprobe 7.1** (release builds, `resources/ffmpeg/`) — static builds from BtbN/FFmpeg-Builds (Windows/Linux, GPLv3 configuration) and evermeet.cx (macOS). MOTIF runs them as separate programs and does not link them. Source code: https://ffmpeg.org/download.html and https://github.com/BtbN/FFmpeg-Builds. The FFmpeg license text is shipped as `FFMPEG_LICENSE.txt` next to the binaries.

## Optional, installed by the user
- **faster-whisper** / CTranslate2 (MIT) and OpenAI Whisper model weights (MIT) for auto captions.
- **Piper** TTS (MIT) and its voices (per-voice licenses; the tutorial uses `en_US-ryan-high`, CC BY-SA 4.0 dataset terms) — used only by the tutorial-video pipeline.

## Cloud API & web
- **Fastify**, @fastify/cors, @fastify/rate-limit — MIT. **drizzle-orm** — Apache-2.0. **pg** — MIT. **stripe** — MIT. **AWS SDK for JavaScript v3** — Apache-2.0. **Next.js** — MIT. **PostgreSQL** (server, not bundled) — PostgreSQL License. **embedded-postgres** (tests only) — MIT.

## Build & test tooling
TypeScript (Apache-2.0), Vite, electron-vite, @vitejs/plugin-react, vitest, electron-builder (MIT).
