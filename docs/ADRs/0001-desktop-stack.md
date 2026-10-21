# ADR 0001: Electron + React + TypeScript, pnpm monorepo

Status: accepted (2026-10-21)

Electron gives a mature multi-panel UI, H.264/AAC-capable `<video>` for preview, and first-class packaging (electron-builder) on Windows/macOS/Linux. Tauri was considered; its system webviews differ per OS in codec support (WebKitGTK on Linux), which would make preview behaviour inconsistent. Versions pinned via lockfile: Electron 44, electron-vite 6, Vite 7, React 19, TypeScript 5.9, Vitest 3, zod 3.
