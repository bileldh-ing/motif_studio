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
