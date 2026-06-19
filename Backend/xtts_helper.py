#!/usr/bin/env python3
"""
Batch XTTS v2 voice cloning helper.
Loads the model once, then synthesises all segments using the speaker reference audio.

Usage: python3 xtts_helper.py <segments_json> <language_code> <speaker_wav>

segments_json: path to a JSON file containing [{text, output}, ...]
language_code: XTTS language code e.g. "es", "fr", "de"
speaker_wav:   path to a WAV file (6-30s) of the original speaker
"""
import sys
import os
import json

# Pre-accept the Coqui CPML non-commercial license so the model downloads
# without an interactive prompt when called from Node.js.
# Full license: https://coqui.ai/cpml
os.environ.setdefault("COQUI_TOS_AGREED", "1")

# PyTorch 2.6 changed torch.load default to weights_only=True, which blocks
# XTTS's custom checkpoint classes. Patch before TTS imports torch.load.
import torch as _torch
_orig_load = _torch.load
_torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, 'weights_only': False})

# The `bangla` package 0.0.5 uses `bool | None` union syntax which is Python 3.10+.
# Pre-register an empty stub so TTS skips its __init__.py entirely on Python 3.9.
from types import ModuleType as _ModuleType
sys.modules.setdefault('bangla', _ModuleType('bangla'))

def main():
    if len(sys.argv) < 4:
        print("Usage: xtts_helper.py <segments_json> <language> <speaker_wav>", file=sys.stderr)
        sys.exit(1)

    segments_file = sys.argv[1]
    language      = sys.argv[2]
    speaker_wav   = sys.argv[3]

    with open(segments_file, 'r', encoding='utf-8') as f:
        segments = json.load(f)

    try:
        import torch
        from TTS.api import TTS
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading XTTS v2 on {device}...", flush=True)
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
        print("Model ready.", flush=True)
    except Exception as e:
        print(f"LOAD_ERROR: {e}", flush=True, file=sys.stderr)
        sys.exit(1)

    for seg in segments:
        text   = seg.get('text', '').strip()
        output = seg['output']
        if not text:
            print(f"SKIP: {output}", flush=True)
            continue
        try:
            tts.tts_to_file(
                text=text,
                language=language,
                speaker_wav=speaker_wav,
                file_path=output,
            )
            print(f"OK: {output}", flush=True)
        except Exception as e:
            print(f"ERR: {output}: {e}", flush=True)

if __name__ == "__main__":
    main()
