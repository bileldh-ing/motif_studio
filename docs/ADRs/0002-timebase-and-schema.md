# ADR 0002: Integer frames at a rational project rate

Status: accepted

Positions and durations are integers counted in project frames; rates and speeds are reduced rationals. This removes float drift (tested: 200k frames at 30000/1001 round-trip exactly) and makes split/trim arithmetic exact. Seconds appear only when talking to FFmpeg or HTMLMediaElement.
