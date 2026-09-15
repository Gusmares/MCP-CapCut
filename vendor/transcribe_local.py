#!/usr/bin/env python
"""Local transcription with word-level timestamps: faster-whisper (via WhisperX) + forced alignment.

Invoked by capcut-mcp's capcut_transcribe tool (provider:"local") as a subprocess, with the
venv's own python.exe by absolute path -- never rely on `python`/`python3`/`py` resolved via PATH.

Usage: python transcribe_local.py <audio_file> [--language pt] [--model large-v3] [--no-align]
Prints one JSON object to stdout: {"words": [{"word","start","end","confidence"}], "language", "durationSec", "aligned"}
Anything unexpected goes to stderr and exits non-zero -- stdout is reserved for the JSON result.
"""
import sys
import json
import argparse
import warnings

warnings.filterwarnings('ignore')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('audio')
    ap.add_argument('--language', default='pt', help='ISO 639-1 code, e.g. pt, en')
    ap.add_argument('--model', default='large-v3', help='faster-whisper model name/size')
    ap.add_argument('--no-align', action='store_true', help='skip WhisperX forced alignment, use Whisper\'s own word timestamps')
    args = ap.parse_args()

    import whisperx

    def load_and_transcribe(device, compute_type):
        model = whisperx.load_model(args.model, device, compute_type=compute_type, language=args.language)
        audio = whisperx.load_audio(args.audio)
        result = model.transcribe(audio, batch_size=8, language=args.language)
        return audio, result

    device, compute_type = 'cuda', 'float16'
    try:
        audio, result = load_and_transcribe(device, compute_type)
    except Exception as e:
        sys.stderr.write(f'GPU transcription failed ({e}), falling back to CPU (this will be slower)\n')
        device, compute_type = 'cpu', 'int8'
        audio, result = load_and_transcribe(device, compute_type)

    aligned = False
    if not args.no_align:
        try:
            model_a, metadata = whisperx.load_align_model(language_code=result.get('language', args.language), device=device)
            result = whisperx.align(result['segments'], model_a, metadata, audio, device, return_char_alignments=False)
            aligned = True
        except Exception as e:
            sys.stderr.write(f'forced alignment skipped, using Whisper\'s native word timestamps instead: {e}\n')

    words = []
    for seg in result.get('segments', []):
        for w in seg.get('words', []):
            # whisperx occasionally leaves a token (stray punctuation, an unaligned digit) with no timing --
            # skip it rather than write a caption word with garbage/missing timestamps
            if 'start' not in w or 'end' not in w:
                continue
            words.append({
                'word': w['word'].strip(),
                'start': float(w['start']),
                'end': float(w['end']),
                'confidence': float(w.get('score', 0.0)),
            })

    duration_sec = words[-1]['end'] if words else 0.0
    print(json.dumps({
        'words': words,
        'language': result.get('language', args.language),
        'durationSec': duration_sec,
        'aligned': aligned,
        'device': device,
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        sys.stderr.write(f'transcription failed: {e}\n')
        sys.exit(1)
