#!/usr/bin/env python3
"""Narration for the tutorial video: neural TTS with Piper (offline), falling
back to FFmpeg's libflite. Writes narration/<chapter>.wav and durations.json."""
import json, os, subprocess, sys, wave

out_dir = sys.argv[1]
script = json.load(open(sys.argv[2]))
voice = os.environ.get("PIPER_VOICE", "")
os.makedirs(os.path.join(out_dir, "narration"), exist_ok=True)

def duration(path):
    with wave.open(path) as w:
        return w.getnframes() / float(w.getframerate())

def piper(text, path):
    from piper import PiperVoice  # piper-tts >= 1.3
    v = PiperVoice.load(voice)
    with wave.open(path, "wb") as w:
        try:
            from piper import SynthesisConfig
            v.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=1.02))
        except ImportError:
            v.synthesize(text, w)

def flite(text, path):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"flite=text='{text.replace(chr(39), '')}':voice=slt", "-ar", "48000", path], check=True)

items = [(c["id"], c["narration"]) for c in script["chapters"]] + [("outro", script["outro"])]
durs = {}
engine = "piper"
for cid, text in items:
    raw = os.path.join(out_dir, "narration", f"{cid}.raw.wav")
    final = os.path.join(out_dir, "narration", f"{cid}.wav")
    try:
        if not voice:
            raise RuntimeError("no PIPER_VOICE")
        piper(text, raw)
    except Exception as e:  # noqa: BLE001
        engine = "flite"
        print(f"piper unavailable for {cid} ({e}); using flite", file=sys.stderr)
        flite(text, raw)
    # broadcast-style polish: high-pass, gentle compression, loudness normalisation, 48 kHz stereo
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-af",
                    "highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,loudnorm=I=-16:TP=-1.5:LRA=7",
                    "-ar", "48000", "-ac", "2", final], check=True)
    os.remove(raw)
    durs[cid] = round(duration(final), 3)
json.dump(durs, open(os.path.join(out_dir, "narration", "durations.json"), "w"), indent=2)
print(json.dumps({"engine": engine, "durations": durs}))
