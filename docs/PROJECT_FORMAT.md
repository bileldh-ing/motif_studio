# Project format (`.motif`, schema v1)

UTF-8 JSON, keys sorted, 2-space indent (deterministic, diff-friendly). Validated by `ProjectSchema` (zod, strict: unknown fields rejected) plus semantic checks (`semanticProblems`).

- `profile`: `width`, `height`, `fps {num, den}` (e.g. 30000/1001), `sampleRate`, `background`.
- `assets[]`: `id`, `kind`, `path` (absolute, never modified), `fingerprint` (sha1 of size + first/last 64 KiB), probed `meta`, optional proxy/thumbnail paths, `favorite`, `tags`, `bin`, `provenance`.
- `tracks[]` (index 0 = bottom layer): `kind` video|text|audio, `hidden/muted/solo/locked`, `volumeDb`, `clips[]`.
- `clips[]`: `start`, `duration`, `sourceIn` (integer frames at project rate), `speed {num, den}`, `transform`, `keyframes{x|y|scale|opacity|rotation|volume: [{frame, value, easing}]}` (frames local to the clip), `audio`, `color`, `text`, `transitionIn {crossfade, frames}`.
- `markers[]`, `inPoint`, `outPoint`, `ui` (playhead/zoom; never affects export).

Source time for a timeline frame: `(sourceIn + (frame - start) * speed) / fps`.

Migrations: `MIGRATIONS[n]` upgrades n → n+1. v0 (pre-release, float fps, no `ui`) → v1 maps 23.976/29.97/59.94 to exact rationals. Files from a newer schema are refused with a clear message rather than truncated.
