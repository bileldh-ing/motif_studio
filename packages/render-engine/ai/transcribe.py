#!/usr/bin/env python3
"""MOTIF local speech-to-text worker (faster-whisper, runs on CPU).

Usage: transcribe.py <media> [--model tiny|base|small] [--language xx]
Decodes audio with ffmpeg (16 kHz mono float), prints JSON lines:
  {"type":"info","language":"en","duration":12.3}
  {"type":"segment","start":0.0,"end":2.1,"text":"...","words":[{"start":..,"end":..,"word":".."}]}
  {"type":"done"}
Errors: {"type":"error","message":"..."} and exit code 1.
Nothing leaves the machine except the one-time model download from Hugging Face.
"""
import json, subprocess, sys, argparse, os

def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--model", default="base")
    ap.add_argument("--language", default=None)
    ap.add_argument("--ffmpeg", default=os.environ.get("MOTIF_FFMPEG", "ffmpeg"))
    a = ap.parse_args()
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": f"faster-whisper is not installed ({e}). Run: pip install faster-whisper"})
        return 1
    try:
        pcm = subprocess.run([a.ffmpeg, "-v", "error", "-nostdin", "-i", a.media, "-vn", "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
    except subprocess.CalledProcessError as e:
        emit({"type": "error", "message": "could not decode audio: " + e.stderr.decode(errors="ignore")[-300:]})
        return 1
    audio = np.frombuffer(pcm, dtype=np.float32)
    if audio.size == 0:
        emit({"type": "error", "message": "this media has no audio"})
        return 1
    model = WhisperModel(a.model, device="cpu", compute_type="int8")
    segs, info = model.transcribe(audio, language=a.language, word_timestamps=True, vad_filter=False)
    emit({"type": "info", "language": info.language, "duration": info.duration})
    for s in segs:
        emit({"type": "segment", "start": s.start, "end": s.end, "text": s.text.strip(),
              "words": [{"start": w.start, "end": w.end, "word": w.word} for w in (s.words or [])]})
    emit({"type": "done"})
    return 0

if __name__ == "__main__":
    sys.exit(main())
