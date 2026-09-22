import os
import re
import subprocess
import sys
import tempfile

import requests
from flask import Flask, render_template, request, jsonify
from faster_whisper import WhisperModel

app = Flask(__name__)

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

SENTENCE_PUNCT = re.compile(r"[.!?]+")
SPACES = re.compile(r"\s+")

TERM_CORRECTIONS = [
    (re.compile(r"\bnoosh\w*\b", re.IGNORECASE), "Notion"),
    (re.compile(r"но\s*уж\w*", re.IGNORECASE), "Notion"),
    (re.compile(r"ноуш\w*", re.IGNORECASE), "Notion"),
    (re.compile(r"нош[еэ]н", re.IGNORECASE), "Notion"),
    (re.compile(r"нейшн", re.IGNORECASE), "Notion"),
    (re.compile(r"гит\s*хаб", re.IGNORECASE), "GitHub"),
    (re.compile(r"фигма", re.IGNORECASE), "Figma"),
    (re.compile(r"докер", re.IGNORECASE), "Docker"),
    (re.compile(r"\bdocker\b", re.IGNORECASE), "Docker"),
]


def apply_corrections(text: str) -> str:
    for pattern, replacement in TERM_CORRECTIONS:
        text = pattern.sub(replacement, text)
    return text


def clean_text(raw_text: str) -> str:
    text = raw_text.strip()
    if not text:
        return ""
    text = SENTENCE_PUNCT.sub("", text)
    text = SPACES.sub(" ", text).strip()
    if text:
        text = text[0].lower() + text[1:]
    text = apply_corrections(text)
    return text


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def to_wav(src_path: str) -> str:
    wav_path = src_path + ".wav"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", src_path,
            "-ar", "16000", "-ac", "1",
            "-af", "dynaudnorm=f=150:g=15",
            wav_path,
        ],
        check=True,
        capture_output=True,
    )
    return wav_path


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/transcribe", methods=["POST"])
def transcribe():
    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify({"text": ""}), 400

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        audio_file.save(tmp.name)
        src_path = tmp.name

    src_size = os.path.getsize(src_path)
    log(f"[transcribe] received {src_size} bytes")

    wav_path = None
    try:
        wav_path = to_wav(src_path)
        wav_size = os.path.getsize(wav_path)
        log(f"[transcribe] converted to wav: {wav_size} bytes")

        segments, info = model.transcribe(
            wav_path,
            language="ru",
            beam_size=3,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=300, threshold=0.35),
            no_speech_threshold=0.4,
            condition_on_previous_text=False,
        )
        segments = list(segments)
        raw_text = "".join(segment.text for segment in segments)
        log(f"[transcribe] segments={len(segments)} raw_text={raw_text!r}")
        text = clean_text(raw_text)
    except Exception as e:
        log(f"[transcribe] ERROR: {e}")
        raise
    finally:
        os.remove(src_path)
        if wav_path and os.path.exists(wav_path):
            os.remove(wav_path)

    return jsonify({"text": text})


@app.route("/chat", methods=["POST"])
def chat():
    if not GEMINI_API_KEY:
        return jsonify({"reply": "", "error": "no_key"})

    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"reply": ""}), 400

    try:
        resp = requests.post(
            GEMINI_URL,
            headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
            json={
                "contents": [{"parts": [{"text": message}]}],
                "systemInstruction": {
                    "parts": [{"text": "Отвечай кратко и по-русски, как голосовой ассистент."}]
                },
            },
            timeout=30,
        )
        resp.raise_for_status()
        payload = resp.json()
        reply = payload["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        return jsonify({"reply": "", "error": str(e)})

    return jsonify({"reply": reply.strip()})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
