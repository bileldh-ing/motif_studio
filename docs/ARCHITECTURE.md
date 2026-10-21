# Architecture

```
Renderer (React, sandboxed)  ── window.motif (typed preload bridge) ──►  Main process (Electron)
  Home / Editor / Timeline / Viewer / Inspector                          zod-validated IPC handlers
  EditorSession = History(editor-core) + UI state                        store.ts: .motif files, recent, settings, recovery
  Canvas compositor  ◄── motif-media:// (only imported assets) ──        render-engine: ffprobe/ffmpeg child processes
```

- **Single source of truth**: the immutable `Project` document. Every edit is a pure function in `editor-core/timeline.ts` that validates the result (no overlaps, source bounds, durations) and either returns a new project or throws, so failed edits never corrupt state or history.
- **Timebase**: integer frames at a rational project rate (`{num, den}`); seconds only at the FFmpeg / `<video>` boundary.
- **Shared composition model**: `editor-core/evaluate.ts` defines which layers are visible, crossfade tails and keyframe interpolation. The canvas preview and the FFmpeg graph builder (`render-engine/graph.ts`) both implement it; render tests decode exported frames and check pixels.
- **Heavy work off the UI thread**: probing, thumbnails, peaks, silence detection and renders run in FFmpeg child processes from the main process, with bounded parallelism (import: 4) and AbortSignal cancellation (SIGTERM then SIGKILL).
- **Local-first**: no network calls. Media never leaves the machine.
- **Failure modes**: corrupt project → falls back to `.bak`; crash → recovery slot offered on next open; render failure/cancel → temp `.part` file deleted; missing media → offline badge + relink.
