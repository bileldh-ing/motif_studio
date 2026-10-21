# Licensing notes

- MOTIF Studio code: proprietary (all rights reserved) until a licence is chosen.
- Electron (MIT), React (MIT), zod (MIT), Vite/electron-vite (MIT).
- FFmpeg is **not bundled**; the app uses the system `ffmpeg`/`ffprobe`. A distributable build must ship an LGPL-configured FFmpeg (no `--enable-gpl`/`--enable-nonfree`) with notices, or document the system dependency. libx264 is GPL: shipping it requires a GPL-compatible distribution or a different encoder (e.g. OS hardware encoders).
- Fonts: titles use DejaVu Sans when present (Bitstream Vera licence, redistributable) or `MOTIF_FONT`.
- Demo and test media are generated at runtime by FFmpeg `lavfi` sources; no third-party media is included.
