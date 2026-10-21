# Security

- BrowserWindow: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`; navigation and new windows blocked (https links open in the OS browser).
- Preload exposes only the typed `MotifApi` (apps/desktop/src/shared/api.ts). No `fs`, `shell`, `ipcRenderer` or process access in the renderer.
- Every IPC handler validates the sender frame URL and parses arguments with zod schemas (projects with the strict `ProjectSchema`).
- `motif-media://asset/<id>` serves only files registered by import/open; `motif-media://derived/<name>` serves only `[\w.-]+` names inside the cache dir (no traversal).
- FFmpeg/ffprobe are spawned with argument arrays, never a shell; user text for titles goes through temp files (`textfile=`), not the filtergraph.
- CSP: `default-src 'self'`, no remote scripts.
- Report vulnerabilities privately to the maintainer (see repository owner).
