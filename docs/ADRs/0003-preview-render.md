# ADR 0003: Canvas 2D preview + FFmpeg filtergraph export

Status: accepted for v0.1, revisit for GPU effects

Spike results (Linux arm64, 2 vCPU, software only): the 4-second two-layer test composition (image overlay, title, crossfade, keyframed position, faded audio) exports at 320×180 in ~2 s; a 10 s 720p demo exports in ~8.6 s. Pixel probes on decoded output frames confirm layer order, overlay position, crossfade mixing and keyframe motion match the timeline.

Preview draws pooled `<video>`/`<img>` elements onto a canvas using the shared composition model; export builds one FFmpeg `filter_complex` (color base → per-clip trim/setpts/scale/eq/rotate/fade → overlay chain; per-clip audio atempo/volume/pan/afade/adelay → amix). Long graphs are passed via `-/filter_complex` script files.

Known parity gaps: CSS filter vs `eq` colour curves; Canvas text vs `drawtext` glyph metrics. Future: WebGL compositor for preview effects with the same parameter definitions.
