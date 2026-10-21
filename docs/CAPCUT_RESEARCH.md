# CapCut desktop feature audit → MOTIF parity (v0.2.0, 2026-10-21)

Sources: capcut.com desktop/AI tool pages, CapCut help (editing & exporting), PCMag CapCut review (Aug 2026),
capcutguide.com feature matrix (May 2026), Primal Video desktop tutorial (Jul 2026). Original implementation only —
no CapCut code, assets, names of proprietary effects, or UI copied.

| CapCut feature | MOTIF v0.2 | How it is implemented / verified |
|---|---|---|
| Split, trim, ripple delete, drag between tracks | ✅ | editor-core ops; unit tests + UI smoke (blade tool) |
| Blade / select / hand tools | ✅ | Timeline tools V/B/H with custom cursors; smoke test |
| Copy / paste / duplicate | ✅ | `copyClips`/`pasteClips`; smoke test |
| Speed (0.25–4×) | ✅ | rational speed, atempo; render tests |
| Reverse | ✅ | FFmpeg `reverse`/`areverse`; pixel test |
| Freeze frame | ✅ | `freezeFrame` ripple insert; pixel test |
| Crop, mirror, flip | ✅ | crop/hflip/vflip; pixel test |
| Keyframes (position, scale, rotation, opacity, volume) with easing | ✅ | shared expressions; rotation keyframe pixel test |
| Transitions (mix, slides, zooms) | ✅ 7 kinds | motion.ts spec → JS + FFmpeg expr; slide pixel test |
| In / out animations | ✅ 7 kinds | fade, zoom in/out, slide ×4; pixel test |
| Filters & adjustments (brightness, contrast, saturation, temperature, hue, sepia, B&W, blur, vignette, invert) | ✅ 10 looks | SVG filter (preview) ↔ eq/hue/colorchannelmixer (export); pixel tests |
| Chroma key | ✅ | chromakey ↔ CPU UV-distance key; pixel test |
| Masks (ellipse/rect, feather, invert) | ✅ | generated mask + alphamerge; pixel test |
| Canvas blur background | ✅ | split→cover→gblur; pixel test |
| Text styles, fonts, stroke, shadow, box | ✅ 9 bundled fonts | same TTF in preview & drawtext; pixel test |
| Shapes / stickers | ✅ rect & circle | colour source + mask; pixel test |
| Auto captions | ✅ local Whisper | faster-whisper worker, word timestamps → cues; test transcribes TTS speech |
| Text to speech | ✅ offline | libflite (4 voices); test |
| Noise reduction | ✅ export | afftdn; render test |
| Voice changer (pitch) | ✅ export | rubberband; render test |
| Extract / detach audio | ✅ | WAV + detachAudio; test |
| Stabilization | ✅ | vid.stab two-pass into a new file; test |
| Silence removal | ✅ | silencedetect → split/ripple |
| SRT import/export, burned-in captions | ✅ | v0.1 |
| Export up to 4K/60, codec & bitrate choice | ✅ | 480p–2160p + custom, H.264/HEVC/AV1/VP9/ProRes, CRF or Mbps, GIF, MP3/WAV/M4A, PNG frame; 4K test |
| Background removal / auto reframe / AI video generation / templates / stock library / cloud space | ❌ planned or out of scope | needs segmentation models or licensed content; disabled with reason in AI tools |
| Speed curves, blend modes, LUT import, colour wheels, multicam, motion tracking | ❌ planned | |
