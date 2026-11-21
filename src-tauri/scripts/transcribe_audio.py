import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import wave
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")

# Configure Windows DLL search paths for NVIDIA CUDA / cuDNN / cuFFT / cuRAND before importing ORT or CTranslate2
if sys.platform == "win32":
    try:
        import site
        sp_dirs = []
        if hasattr(site, "getsitepackages"):
            sp_dirs.extend(site.getsitepackages())
        if hasattr(site, "getusersitepackages"):
            sp_dirs.append(site.getusersitepackages())
        for sp in sp_dirs:
            if not sp or not os.path.isdir(sp):
                continue
            nvidia_base = os.path.join(sp, "nvidia")
            if os.path.isdir(nvidia_base):
                for sub in os.listdir(nvidia_base):
                    bin_dir = os.path.join(nvidia_base, sub, "bin")
                    if os.path.isdir(bin_dir):
                        try:
                            os.add_dll_directory(bin_dir)
                        except Exception:
                            pass
                        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


_LAST_EMITTED_PCT = 0.0


def emit_progress(stage, percent, message, detail=None, log_line=None):
    global _LAST_EMITTED_PCT
    if stage in ("completed", "error", "cancelled"):
        clamped = float(percent)
    else:
        clamped = min(98.5, max(_LAST_EMITTED_PCT, float(percent)))
        _LAST_EMITTED_PCT = clamped

    payload = {
        "type": "progress",
        "stage": stage,
        "percent": round(clamped, 2),
        "message": message,
    }
    if detail:
        payload["detail"] = detail
    if log_line:
        payload["log_line"] = log_line
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def fmt_hms(seconds):
    total = max(0, int(round(seconds)))
    s = total % 60
    m = (total // 60) % 60
    h = total // 3600
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def find_ffmpeg():
    candidate = "ffmpeg"
    creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        subprocess.run(
            [candidate, "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
        return candidate
    except Exception:
        pass
    local_appdata = os.environ.get("LOCALAPPDATA", "")
    known_paths = [
        os.path.join(local_appdata, "ClipGen", "bin", "ffmpeg.exe"),
        os.path.join(local_appdata, "Programs", "ffmpeg", "bin", "ffmpeg.exe"),
    ]
    for p in known_paths:
        if os.path.isfile(p):
            return p
    return "ffmpeg"


def is_wav_16k_mono_s16(path):
    if not path.lower().endswith(".wav"):
        return False
    try:
        with wave.open(path, "rb") as wf:
            return (
                wf.getnchannels() == 1
                and wf.getsampwidth() == 2
                and wf.getframerate() == 16000
                and wf.getnframes() > 0
            )
    except Exception:
        return False


def convert_to_wav_16k(input_audio, output_wav, ffmpeg_bin):
    creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input_audio,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        output_wav,
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        creationflags=creation_flags,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "FFmpeg failed").strip())


def compute_streaming_dbfs(wav_path):
    """Computes 0.5s RMS dBFS chunks in O(1) RAM by streaming 60s blocks from 16kHz mono s16 WAV."""
    try:
        with wave.open(wav_path, "rb") as wf:
            sr = wf.getframerate()
            total_frames = wf.getnframes()
            duration = total_frames / float(sr) if sr > 0 else 0.0
            chunk_frames = int(sr * 0.5)
            batch_chunks = 120  # 60 seconds per read
            batch_frames = chunk_frames * batch_chunks

            dbfs_blocks = []
            while True:
                raw = wf.readframes(batch_frames)
                if not raw:
                    break
                samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
                n_chunks = len(samples) // chunk_frames
                if n_chunks == 0:
                    continue
                reshaped = samples[: n_chunks * chunk_frames].reshape(n_chunks, chunk_frames)
                rms = np.sqrt(np.mean(reshaped ** 2, axis=1) + 1e-9)
                dbfs = 20.0 * np.log10(rms / 32768.0 + 1e-9)
                dbfs_blocks.append(dbfs)

        if not dbfs_blocks:
            return duration, np.array([], dtype=np.float32), -16.0

        dbfs_all = np.concatenate(dbfs_blocks)
        speech_chunks = dbfs_all[dbfs_all > -45.0]
        if len(speech_chunks) > 0:
            mean_dbfs = float(np.mean(speech_chunks))
            std_dbfs = float(np.std(speech_chunks))
        else:
            mean_dbfs = -28.0
            std_dbfs = 5.0

        spike_threshold = max(-16.0, mean_dbfs + max(5.0, 1.4 * std_dbfs))
        return duration, dbfs_all, spike_threshold
    except Exception as e:
        sys.stderr.write(f"Error analizando picos de audio: {e}\n")
        return 0.0, np.array([], dtype=np.float32), -16.0


def read_wav_slice(wf, sr, total_frames, start_s, end_s, max_sec=10.0, dbfs_arr=None):
    dur = max(0.0, end_s - start_s)
    if dur > max_sec and dbfs_arr is not None and len(dbfs_arr) > 0:
        c0 = min(max(0, int(start_s / 0.5)), len(dbfs_arr) - 1)
        c1 = min(len(dbfs_arr), max(c0 + 1, int(np.ceil(end_s / 0.5))))
        if c1 > c0:
            best_c = c0 + int(np.argmax(dbfs_arr[c0:c1]))
            peak_center = (best_c + 0.5) * 0.5
            start_s = max(start_s, min(end_s - max_sec, peak_center - max_sec * 0.5))
            end_s = min(end_s, start_s + max_sec)
    elif dur > max_sec:
        end_s = start_s + max_sec

    f_start = max(0, min(total_frames, int(start_s * sr)))
    f_end = max(f_start, min(total_frames, int(end_s * sr)))
    if f_end <= f_start:
        return np.array([], dtype=np.float32)

    wf.setpos(f_start)
    raw = wf.readframes(f_end - f_start)
    if not raw:
        return np.array([], dtype=np.float32)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


EVENT_THRESHOLDS = {
    "Belly laugh": ("CARCAJADA", 0.22),
    "Laughter": ("RISA", 0.25),
    "Giggle": ("RISA", 0.25),
    "Snicker": ("RISA", 0.25),
    "Chuckle, chortle": ("RISA", 0.25),
    "Sigh": ("SUSPIRO", 0.20),
    "Gasp": ("ASOMBRO", 0.22),
    "Pant": ("JADEO", 0.28),
    "Screaming": ("GRITO", 0.25),
    "Shout": ("GRITO", 0.25),
    "Yell": ("GRITO", 0.25),
    "Bellow": ("GRITO", 0.25),
    "Battle cry": ("GRITO", 0.25),
    "Whoop": ("GRITO", 0.25),
    "Crying, sobbing": ("LLANTO", 0.25),
    "Whimper": ("LLANTO", 0.25),
    "Wail, moan": ("LLANTO", 0.25),
    "Groan": ("QUEJIDO", 0.24),
    "Grunt": ("QUEJIDO", 0.24),
    "Snort": ("RESOPLIDO", 0.28),
    "Whispering": ("SUSURRO", 0.28),
    "Applause": ("APLAUSOS", 0.30),
    "Clapping": ("APLAUSOS", 0.30),
    "Cheering": ("APLAUSOS", 0.30),
    "Cough": ("TOS", 0.32),
    "Throat clearing": ("TOS", 0.32),
    "Sneeze": ("TOS", 0.32),
}

GAP_ELIGIBLE_TAGS = {
    "CARCAJADA",
    "RISA",
    "SUSPIRO",
    "ASOMBRO",
    "GRITO",
    "LLANTO",
    "QUEJIDO",
    "APLAUSOS",
}

E2V_LABELS = [
    "angry",
    "disgusted",
    "fearful",
    "happy",
    "neutral",
    "other",
    "sad",
    "surprised",
    "unknown",
]

E2V_TO_ES = {
    "angry": "RABIA",
    "happy": "ALEGRÍA",
    "sad": "TRISTEZA",
    "fearful": "MIEDO/TENSIÓN",
    "surprised": "SORPRESA",
    "disgusted": "DISGUSTO",
}

W2V_LABELS = ["ANG", "CAL", "DIS", "FEA", "HAP", "NEU", "SAD", "SUR"]

W2V_TO_ES = {
    "ANG": "RABIA",
    "HAP": "ALEGRÍA",
    "SAD": "TRISTEZA",
    "FEA": "MIEDO/TENSIÓN",
    "SUR": "SORPRESA",
    "DIS": "DISGUSTO",
}


def init_audio_tagger():
    from huggingface_hub import hf_hub_download
    import sherpa_onnx

    repo = "k2-fsa/sherpa-onnx-ced-mini-audio-tagging-2024-04-19"
    emit_progress(
        "analyzing_emotions",
        78.5,
        "Preparando detector de risas, suspiros y reacciones...",
        "Modelo AudioSet CED-Mini INT8",
        "🎭 Verificando modelo de eventos vocales (CED-Mini)...",
    )
    model_path = hf_hub_download(repo, "model.int8.onnx")
    labels_path = hf_hub_download(repo, "class_labels_indices.csv")
    threads = min(8, os.cpu_count() or 4)
    cfg = sherpa_onnx.AudioTaggingConfig(
        model=sherpa_onnx.AudioTaggingModelConfig(
            ced=model_path,
            num_threads=threads,
            provider="cpu",
        ),
        labels=labels_path,
        top_k=5,
    )
    return sherpa_onnx.AudioTagging(cfg)


def init_emotion_recognizer():
    from huggingface_hub import hf_hub_download
    import onnxruntime as ort

    if hasattr(ort, "set_default_logger_severity"):
        try:
            ort.set_default_logger_severity(3)
        except Exception:
            pass
    if hasattr(ort, "preload_dlls"):
        try:
            ort.preload_dlls()
        except Exception:
            pass

    so = ort.SessionOptions()
    so.log_severity_level = 3

    available = ort.get_available_providers()
    if "CUDAExecutionProvider" in available:
        try:
            emit_progress(
                "analyzing_emotions",
                80.0,
                "Cargando modelo emocional en GPU NVIDIA (emotion2vec+)...",
                "CUDAExecutionProvider",
                "🧠 Cargando emotion2vec+ Large en GPU CUDA...",
            )
            e2v_path = hf_hub_download("Voldorn/emotion2vec-plus-large-onnx", "emotion2vec_plus_large.onnx")
            sess = ort.InferenceSession(e2v_path, sess_options=so, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
            if "CUDAExecutionProvider" in sess.get_providers():
                inp_name = sess.get_inputs()[0].name
                out_name = sess.get_outputs()[0].name
                # Quick warmup pass so first utterance is fast
                sess.run([out_name], {inp_name: np.zeros((1, 16000), dtype=np.float32)})
                return ("e2v", sess, inp_name, out_name)
        except Exception as e:
            sys.stderr.write(f"Aviso: emotion2vec GPU no disponible ({e}), usando fallback CPU INT8...\n")

    emit_progress(
        "analyzing_emotions",
        80.0,
        "Cargando detector emocional ligero en CPU...",
        "Speech-Emotion-Classification INT8",
        "🧠 Cargando detector de emociones en CPU (INT8)...",
    )
    w2v_path = hf_hub_download("onnx-community/Speech-Emotion-Classification-ONNX", "onnx/model_int8.onnx")
    sess = ort.InferenceSession(w2v_path, sess_options=so, providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    return ("w2v", sess, inp_name, out_name)


def detect_events_for_slice(tagger, samples, min_override=None, max_tags=2):
    if tagger is None or len(samples) < 4800:  # >= 0.3s
        return []
    stream = tagger.create_stream()
    stream.accept_waveform(16000, samples)
    raw_events = tagger.compute(stream)

    best_by_tag = {}
    for ev in raw_events:
        entry = EVENT_THRESHOLDS.get(ev.name)
        if not entry:
            continue
        es_tag, thr = entry
        eff_thr = max(thr, min_override) if min_override is not None else thr
        if ev.prob >= eff_thr:
            prev = best_by_tag.get(es_tag, 0.0)
            if ev.prob > prev:
                best_by_tag[es_tag] = float(ev.prob)

    if "CARCAJADA" in best_by_tag and "RISA" in best_by_tag:
        del best_by_tag["RISA"]

    sorted_tags = sorted(best_by_tag.items(), key=lambda kv: kv[1], reverse=True)
    return sorted_tags[:max_tags]


def detect_emotion_for_slice(ser_ctx, samples):
    if ser_ctx is None or len(samples) < 5600:  # >= 0.35s
        return None
    kind, sess, inp_name, out_name = ser_ctx
    arr = np.asarray(samples, dtype=np.float32)
    if arr.ndim == 1:
        arr = np.expand_dims(arr, axis=0)

    if kind == "e2v":
        scores = sess.run([out_name], {inp_name: arr})[0][0]
        idx = int(np.argmax(scores))
        raw_lbl = E2V_LABELS[idx] if idx < len(E2V_LABELS) else "unknown"
        prob = float(scores[idx])
        if prob >= 0.48 and raw_lbl in E2V_TO_ES:
            return E2V_TO_ES[raw_lbl]
        return None

    # Wav2Vec2 CPU fallback: layer norm per utterance + softmax
    mean = float(np.mean(arr))
    var = float(np.var(arr))
    norm = (arr - mean) / np.sqrt(var + 1e-7)
    logits = sess.run([out_name], {inp_name: norm})[0][0]
    exp_l = np.exp(logits - np.max(logits))
    probs = exp_l / np.sum(exp_l)
    idx = int(np.argmax(probs))
    raw_lbl = W2V_LABELS[idx] if idx < len(W2V_LABELS) else "NEU"
    prob = float(probs[idx])
    if prob >= 0.52 and raw_lbl in W2V_TO_ES:
        return W2V_TO_ES[raw_lbl]
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, help="Ruta al archivo de audio")
    parser.add_argument("--language", default="es", help="Idioma (es, en, auto)")
    parser.add_argument("--model", default="small", help="Modelo whisper (tiny, base, small, medium)")
    parser.add_argument("--output", default="", help="Ruta de salida JSON (opcional)")
    parser.add_argument("--ffmpeg", default="", help="Ruta a ffmpeg (opcional)")
    parser.add_argument("--time-offset", type=float, default=0.0, help="Desplazamiento inicial en segundos")
    parser.add_argument(
        "--detect-emotions",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Detectar emociones y reacciones no verbales",
    )
    args = parser.parse_args()

    audio_path = os.path.abspath(args.audio)
    if not os.path.isfile(audio_path):
        emit_progress("error", 0, f"No existe el archivo de audio: {audio_path}")
        sys.exit(1)

    ffmpeg_bin = args.ffmpeg if args.ffmpeg and os.path.exists(args.ffmpeg) else find_ffmpeg()
    time_offset = max(0.0, float(args.time_offset or 0.0))

    temp_wav_to_delete = None
    wav_path = audio_path

    try:
        # 1. Stage 2 (35% -> 42%): Extract / normalize 16kHz mono WAV + streaming dBFS
        if is_wav_16k_mono_s16(audio_path):
            emit_progress(
                "extracting_pcm",
                37.0,
                "Analizando picos de volumen en pista WAV...",
                "16 kHz mono PCM listo",
                "🎚 Analizando niveles de volumen y energía de picos...",
            )
        else:
            emit_progress(
                "extracting_pcm",
                36.0,
                "Convirtiendo audio a formato óptimo 16 kHz PCM...",
                os.path.basename(audio_path),
                "🎚 Preparando pista de audio a 16 kHz para Whisper + IA emocional...",
            )
            fd, generated_wav = tempfile.mkstemp(prefix="clipgen_pcm_", suffix=".wav")
            os.close(fd)
            temp_wav_to_delete = generated_wav
            wav_path = generated_wav
            convert_to_wav_16k(audio_path, wav_path, ffmpeg_bin)

        duration, dbfs_arr, spike_threshold = compute_streaming_dbfs(wav_path)
        emit_progress(
            "extracting_pcm",
            42.0,
            "Análisis de volumen completado.",
            f"Duración: {fmt_hms(duration)}",
        )

        # 2. Stage 3 (42% -> 48%): Load faster-whisper + BatchedInferencePipeline
        emit_progress(
            "loading_model",
            43.0,
            f"Cargando modelo Whisper ({args.model})...",
            None,
            f"⚙ Cargando modelo de voz Whisper ({args.model})...",
        )
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        model = None
        device = "cpu"
        try:
            probe_model = WhisperModel(args.model, device="cuda", compute_type="float16")
            dummy_feat = np.zeros((1, 80, 3000), dtype=np.float32)
            probe_model.encode(dummy_feat)
            model = probe_model
            device = "cuda"
        except Exception as e:
            sys.stderr.write(f"Aviso GPU Whisper ({e}), usando CPU INT8.\n")
            model = WhisperModel(
                args.model,
                device="cpu",
                compute_type="int8",
                cpu_threads=min(8, os.cpu_count() or 4),
            )
            device = "cpu"

        device_label = "GPU (CUDA)" if device == "cuda" else "CPU (int8)"
        batch_size = 16 if device == "cuda" else 4
        batched_model = BatchedInferencePipeline(model=model)

        emit_progress(
            "loading_model",
            48.0,
            f"Whisper listo en {device_label}.",
            f"Batch size {batch_size}",
            f"✓ Whisper inicializado en {device_label} (pipeline por lotes x{batch_size}).",
        )

        # 3. Stage 4 (48% -> 78%): Streaming transcription
        transcribe_kwargs = {"beam_size": 5}
        if args.language and args.language.lower() != "auto":
            transcribe_kwargs["language"] = args.language.lower()

        total_duration = duration if duration > 0 else 1.0
        speech_items = []
        detected_language = args.language
        last_emit_t = 0.0

        def consume_stream(seg_gen, info_obj):
            nonlocal total_duration, detected_language, last_emit_t
            if info_obj is not None:
                if getattr(info_obj, "duration", 0) and info_obj.duration > 0:
                    total_duration = float(info_obj.duration)
                if getattr(info_obj, "language", None):
                    detected_language = info_obj.language

            count = 0
            for seg in seg_gen:
                text = seg.text.strip()
                if not text:
                    continue
                count += 1
                s_raw = float(seg.start)
                e_raw = max(s_raw + 0.2, float(seg.end))
                is_peak = False
                if len(dbfs_arr) > 0:
                    c_start = max(0, int(s_raw / 0.5))
                    c_end = min(len(dbfs_arr), max(c_start + 1, int(np.ceil(e_raw / 0.5))))
                    if np.any(dbfs_arr[c_start:c_end] >= spike_threshold):
                        is_peak = True

                speech_items.append(
                    {
                        "s_raw": s_raw,
                        "e_raw": e_raw,
                        "is_peak": is_peak,
                        "text": text,
                        "emotion": None,
                        "events": [],
                    }
                )

                now_t = time.monotonic()
                if now_t - last_emit_t >= 0.2 or count == 1:
                    last_emit_t = now_t
                    pct = 48.0 + min(1.0, e_raw / max(0.1, total_duration)) * 30.0
                    emit_progress(
                        "transcribing",
                        pct,
                        f"Transcribiendo: «{text[:48]}{'…' if len(text) > 48 else ''}»",
                        f"{fmt_hms(e_raw + time_offset)} / {fmt_hms(total_duration + time_offset)} · {device_label}",
                    )
            return count

        try:
            segments_gen, info = batched_model.transcribe(
                wav_path,
                batch_size=batch_size,
                vad_filter=True,
                without_timestamps=False,
                **transcribe_kwargs,
            )
            n_items = consume_stream(segments_gen, info)
            if n_items == 0:
                emit_progress(
                    "transcribing",
                    52.0,
                    "Reintentando transcripción sin filtro de silencio...",
                    device_label,
                    "↪ VAD no detectó habla clara; escaneando audio completo sin filtro...",
                )
                segments_gen2, info2 = model.transcribe(wav_path, vad_filter=False, **transcribe_kwargs)
                consume_stream(segments_gen2, info2)
        except Exception as e:
            sys.stderr.write(f"Batched fallback a transcribe directo ({e})\n")
            speech_items.clear()
            segments_gen2, info2 = model.transcribe(wav_path, vad_filter=False, **transcribe_kwargs)
            consume_stream(segments_gen2, info2)

        emit_progress(
            "transcribing",
            78.0,
            f"Transcripción de voz completada ({len(speech_items)} frases).",
            f"{fmt_hms(total_duration + time_offset)} · {device_label}",
            f"✓ Voz transcrita: {len(speech_items)} segmentos de diálogo.",
        )

        # Free Whisper model cleanly before loading SER
        batched_model = None
        model = None
        import gc
        gc.collect()

        # 4. Stage 5 (78% -> 98%): Non-verbal reactions + Speech Emotion Recognition
        extra_nonverbal_items = []
        if args.detect_emotions:
            tagger = None
            ser_ctx = None
            try:
                tagger = init_audio_tagger()
            except Exception as e:
                sys.stderr.write(f"Aviso AudioTagging no disponible: {e}\n")
                emit_progress(
                    "analyzing_emotions",
                    79.5,
                    "Omitiendo detector de risas/suspiros (sin caché o error).",
                    None,
                    f"⚠ Detector CED de risas/suspiros omitido: {str(e)[:80]}",
                )

            try:
                ser_ctx = init_emotion_recognizer()
            except Exception as e:
                sys.stderr.write(f"Aviso SER no disponible: {e}\n")
                emit_progress(
                    "analyzing_emotions",
                    80.5,
                    "Omitiendo detector de emociones faciales/tonales.",
                    None,
                    f"⚠ Detector emocional SER omitido: {str(e)[:80]}",
                )

            if tagger is not None or ser_ctx is not None:
                with wave.open(wav_path, "rb") as wf:
                    sr = wf.getframerate()
                    total_frames = wf.getnframes()

                    # Build list of energetic gaps (>= 1.2s) between speech segments
                    gaps = []
                    prev_end = 0.0
                    for it in speech_items:
                        if it["s_raw"] - prev_end >= 1.2:
                            gaps.append((prev_end, it["s_raw"]))
                        prev_end = max(prev_end, it["e_raw"])
                    if total_duration - prev_end >= 1.2:
                        gaps.append((prev_end, total_duration))

                    # Pre-generate energetic 2.5s windows inside gaps
                    gap_windows = []
                    if tagger is not None:
                        for gs, ge in gaps:
                            w_s = gs
                            while w_s + 0.9 <= ge:
                                w_e = min(ge, w_s + 2.5)
                                has_energy = True
                                if len(dbfs_arr) > 0:
                                    c0 = min(max(0, int(w_s / 0.5)), len(dbfs_arr) - 1)
                                    c1 = min(len(dbfs_arr), max(c0 + 1, int(np.ceil(w_e / 0.5))))
                                    if c1 > c0 and float(np.max(dbfs_arr[c0:c1])) <= -42.0:
                                        has_energy = False
                                if has_energy:
                                    gap_windows.append((w_s, w_e))
                                w_s += 1.5

                    total_ops = max(1, len(speech_items) + len(gap_windows))
                    done_ops = 0
                    last_emo_emit = 0.0

                    # Classify each speech segment
                    for idx_seg, item in enumerate(speech_items):
                        s_raw = item["s_raw"]
                        e_raw = item["e_raw"]

                        if tagger is not None and (e_raw - s_raw) >= 0.3:
                            ev_samples = read_wav_slice(wf, sr, total_frames, s_raw, e_raw, max_sec=10.0, dbfs_arr=dbfs_arr)
                            found_evs = detect_events_for_slice(tagger, ev_samples, max_tags=2)
                            item["events"] = [tag for tag, _ in found_evs]

                        if ser_ctx is not None and (e_raw - s_raw) >= 0.35:
                            ser_samples = read_wav_slice(wf, sr, total_frames, s_raw, e_raw, max_sec=4.0, dbfs_arr=dbfs_arr)
                            item["emotion"] = detect_emotion_for_slice(ser_ctx, ser_samples)

                        done_ops += 1
                        now_t = time.monotonic()
                        if now_t - last_emo_emit >= 0.2 or idx_seg == len(speech_items) - 1:
                            last_emo_emit = now_t
                            pct = 81.0 + (done_ops / total_ops) * 16.5
                            emit_progress(
                                "analyzing_emotions",
                                pct,
                                "Detectando emociones, risas y reacciones vocales...",
                                f"Frase {idx_seg + 1} / {len(speech_items)}",
                            )

                    # Scan energetic gaps for non-verbal reactions
                    raw_gap_hits = []
                    for w_s, w_e in gap_windows:
                        ev_samples = read_wav_slice(wf, sr, total_frames, w_s, w_e, max_sec=2.5)
                        hits = detect_events_for_slice(tagger, ev_samples, min_override=0.30, max_tags=2)
                        filtered = [(tag, prob) for tag, prob in hits if tag in GAP_ELIGIBLE_TAGS]
                        if filtered:
                            is_peak = False
                            if len(dbfs_arr) > 0:
                                c0 = min(max(0, int(w_s / 0.5)), len(dbfs_arr) - 1)
                                c1 = min(len(dbfs_arr), max(c0 + 1, int(np.ceil(w_e / 0.5))))
                                if c1 > c0 and np.any(dbfs_arr[c0:c1] >= spike_threshold):
                                    is_peak = True
                            raw_gap_hits.append(
                                {
                                    "s_raw": w_s,
                                    "e_raw": w_e,
                                    "events": [t for t, _ in filtered],
                                    "is_peak": is_peak,
                                }
                            )
                        done_ops += 1
                        now_t = time.monotonic()
                        if now_t - last_emo_emit >= 0.2 or done_ops == total_ops:
                            last_emo_emit = now_t
                            pct = 81.0 + (done_ops / total_ops) * 16.5
                            emit_progress(
                                "analyzing_emotions",
                                pct,
                                "Buscando risas, suspiros y reacciones entre silencios...",
                                f"Análisis {done_ops} / {total_ops}",
                            )

                    # Merge adjacent/overlapping gap hits sharing the same primary reaction tag
                    for gh in raw_gap_hits:
                        if (
                            extra_nonverbal_items
                            and gh["s_raw"] <= extra_nonverbal_items[-1]["e_raw"] + 0.6
                            and extra_nonverbal_items[-1]["events"][0] == gh["events"][0]
                        ):
                            prev = extra_nonverbal_items[-1]
                            prev["e_raw"] = max(prev["e_raw"], gh["e_raw"])
                            prev["is_peak"] = prev["is_peak"] or gh["is_peak"]
                            for ev_tag in gh["events"]:
                                if ev_tag not in prev["events"] and len(prev["events"]) < 2:
                                    prev["events"].append(ev_tag)
                        else:
                            extra_nonverbal_items.append(
                                {
                                    "s_raw": gh["s_raw"],
                                    "e_raw": gh["e_raw"],
                                    "is_peak": gh["is_peak"],
                                    "text": "(reacción no verbal)",
                                    "emotion": None,
                                    "events": gh["events"],
                                }
                            )

                emit_progress(
                    "analyzing_emotions",
                    98.0,
                    "Análisis emocional finalizado.",
                    f"+{len(extra_nonverbal_items)} reacciones no verbales detectadas",
                    f"✓ Emociones y eventos vocales detectados ({len(extra_nonverbal_items)} reacciones en pausas).",
                )

        # Combine, offset timestamps, and sort chronologically
        all_items = speech_items + extra_nonverbal_items
        segments_list = []
        for it in all_items:
            start_sec = round(it["s_raw"] + time_offset)
            end_sec = max(start_sec + 1, round(it["e_raw"] + time_offset))
            segments_list.append(
                {
                    "start": int(start_sec),
                    "end": int(end_sec),
                    "is_peak": bool(it["is_peak"]),
                    "emotion": it.get("emotion"),
                    "events": list(it.get("events") or []),
                    "text": it["text"],
                }
            )

        segments_list.sort(key=lambda s: (s["start"], s["end"]))

        text_lines = []
        for seg in segments_list:
            tags = []
            if seg["emotion"]:
                tags.append(f"[{seg['emotion']}]")
            for ev in seg["events"]:
                tags.append(f"[{ev}]")
            if seg["is_peak"]:
                tags.append("[PICO DE AUDIO]")
            tag_prefix = (" ".join(tags) + " ") if tags else ""
            text_lines.append(f"[{seg['start']} - {seg['end']}] {tag_prefix}{seg['text']}")

        full_text = "\n".join(text_lines)

        result = {
            "type": "result",
            "device": device,
            "language": detected_language,
            "duration": total_duration,
            "segments": segments_list,
            "formatted_text": full_text,
        }

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

        print(json.dumps(result, ensure_ascii=True), flush=True)

    finally:
        if temp_wav_to_delete and os.path.exists(temp_wav_to_delete):
            try:
                os.remove(temp_wav_to_delete)
            except Exception:
                pass


if __name__ == "__main__":
    main()
