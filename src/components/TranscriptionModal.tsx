import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  Loader2,
  Copy,
  Check,
  Download,
  AlertCircle,
  X,
  Volume2,
  Cpu,
  Zap,
  Globe,
  Clock,
  HeartPulse,
  Smile,
  StopCircle,
  Terminal,
  ClipboardPaste,
  RotateCcw,
} from "lucide-react";
import { formatTimeShort } from "../utils/time";
import { Tooltip } from "./Tooltip";

interface TranscriptionSegment {
  start: number;
  end: number;
  is_peak: boolean;
  emotion?: string | null;
  events?: string[];
  text: string;
}

interface TranscriptionResult {
  url: string;
  video_title?: string | null;
  duration: number;
  device: string;
  segments: TranscriptionSegment[];
  formatted_text: string;
}

interface TranscriptionProgressEvent {
  stage: string;
  percent: number;
  message: string;
  detail?: string | null;
  log_line?: string | null;
}

interface TranscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  streamUrl: string;
  onStreamUrlChange?: (url: string) => void;
  videoTitle?: string;
  outputDir?: string;
  hasMetadata?: boolean;
  activeStart?: number;
  activeEnd?: number;
}

const STAGE_BADGES: Record<string, string> = {
  starting: "Preparando",
  downloading_audio: "Descargando audio",
  extracting_pcm: "Preparando audio",
  loading_model: "Cargando modelos IA",
  transcribing: "Transcribiendo voz",
  analyzing_emotions: "Analizando emociones y reacciones",
  completed: "Completado",
  cancelled: "Cancelado",
};

export const TranscriptionModal: React.FC<TranscriptionModalProps> = ({
  isOpen,
  onClose,
  streamUrl,
  onStreamUrlChange,
  videoTitle = "",
  outputDir = "",
  hasMetadata = false,
  activeStart,
  activeEnd,
}) => {
  const [targetUrl, setTargetUrl] = useState(streamUrl);
  const [urlPasteNotice, setUrlPasteNotice] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "completed" | "error">("idle");
  const [progress, setProgress] = useState<TranscriptionProgressEvent>({
    percent: 0,
    message: "",
    stage: "",
    detail: null,
    log_line: null,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedAi, setCopiedAi] = useState(false);
  const [savedTxt, setSavedTxt] = useState(false);
  const [savedPathNotice, setSavedPathNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const trimmedTargetUrl = targetUrl.trim();
  const targetMatchesLoaded = Boolean(
    hasMetadata &&
      trimmedTargetUrl &&
      streamUrl.trim() &&
      trimmedTargetUrl === streamUrl.trim()
  );
  const hasRange = Boolean(
    targetMatchesLoaded &&
      activeEnd != null &&
      activeStart != null &&
      activeEnd > activeStart
  );
  const [scope, setScope] = useState<"range" | "full">("full");
  const [selectedLanguage, setSelectedLanguage] = useState<"es" | "auto" | "en">("es");
  const [detectEmotions, setDetectEmotions] = useState(true);
  const [modelSize, setModelSize] = useState<"small" | "medium">("small");

  const logEndRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (status !== "running") {
      setTargetUrl(streamUrl);
    }
  }, [streamUrl, isOpen]);

  useEffect(() => {
    if (!hasRange && scope === "range") {
      setScope("full");
    }
  }, [hasRange, scope]);

  useEffect(() => {
    if (!isOpen) {
      setStatus("idle");
      setScope("full");
      setProgress({ percent: 0, message: "", stage: "", detail: null, log_line: null });
      setLogs([]);
      setResult(null);
      setErrorMessage(null);
      setCopiedText(false);
      setCopiedAi(false);
      setSavedTxt(false);
      setSavedPathNotice(null);
      setSaveError(null);
      setUrlPasteNotice(false);
      setIsCancelling(false);
      return;
    }

    setScope("full");
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<TranscriptionProgressEvent>(
        "transcription-progress",
        (event) => {
          const payload = event.payload;
          setProgress((prev) => ({
            stage: payload.stage || prev.stage,
            percent:
              payload.stage === "cancelled"
                ? 0
                : Math.max(prev.percent, Number.isFinite(payload.percent) ? payload.percent : prev.percent),
            message: payload.message || prev.message,
            detail: payload.detail !== undefined ? payload.detail : prev.detail,
            log_line: payload.log_line ?? null,
          }));
          if (payload.log_line) {
            setLogs((prev) => [...prev.slice(-39), payload.log_line as string]);
          }
        }
      );
    };

    void setupListener();

    return () => {
      unlisten?.();
    };
  }, [isOpen]);

  const handleTargetUrlChange = (nextUrl: string) => {
    setTargetUrl(nextUrl);
    onStreamUrlChange?.(nextUrl);
  };

  const handlePasteTargetUrl = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        handleTargetUrlChange(text.trim());
        setUrlPasteNotice(true);
        setTimeout(() => setUrlPasteNotice(false), 1200);
      }
    } catch {
      // Permission denied
    }
  };

  const handleResetToIdle = () => {
    setStatus("idle");
    setResult(null);
    setErrorMessage(null);
    setLogs([]);
    setCopiedText(false);
    setCopiedAi(false);
    setSavedTxt(false);
    setSavedPathNotice(null);
    setSaveError(null);
    setProgress({ percent: 0, message: "", stage: "", detail: null, log_line: null });
  };

  const handleStart = async () => {
    if (!trimmedTargetUrl) {
      setErrorMessage("Introduce primero una URL válida del stream.");
      setStatus("error");
      return;
    }

    setStatus("running");
    setResult(null);
    setIsCancelling(false);
    setErrorMessage(null);
    setCopiedText(false);
    setCopiedAi(false);
    setSavedTxt(false);
    setSavedPathNotice(null);
    setSaveError(null);
    setLogs([]);
    setProgress({
      percent: 1,
      message: "Iniciando descarga de audio ligera...",
      stage: "downloading_audio",
      detail: null,
      log_line: null,
    });

    try {
      const payload: Record<string, any> = {
        url: trimmedTargetUrl,
        language: selectedLanguage,
        detectEmotions,
        modelSize,
      };
      if (hasRange && scope === "range" && activeEnd != null && activeStart != null) {
        payload.startTime = activeStart;
        payload.endTime = activeEnd;
      }
      const data = await invoke<TranscriptionResult>("start_transcription", payload);
      setResult(data);
      setStatus("completed");
    } catch (err: any) {
      const msg = String(err || "");
      if (msg.includes("__CANCELLED__")) {
        setStatus("idle");
        setIsCancelling(false);
        return;
      }
      setErrorMessage(msg);
      setStatus("error");
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    setProgress((prev) => ({
      ...prev,
      message: "Cancelando procesos y limpiando archivos temporales...",
    }));
    try {
      await invoke("cancel_transcription");
    } catch {
      // Ignore invoke error on cleanup
    }
  };

  const handleRequestClose = () => {
    if (statusRef.current === "running") {
      void invoke("cancel_transcription").catch(() => {});
    }
    onClose();
  };

  const resolvedTitle =
    (result?.video_title || (targetMatchesLoaded ? videoTitle : "") || "").trim() || "Sin título";
  const resolvedUrl = (result?.url || trimmedTargetUrl || "").trim();

  const buildTxtContent = () => {
    if (!result) return "";
    return [
      `Título: ${resolvedTitle}`,
      `URL: ${resolvedUrl}`,
      "",
      result.formatted_text || "",
    ].join("\n");
  };

  const buildAiCopyContent = () => {
    if (!result) return "";
    return [
      "--clipgen",
      `Título: ${resolvedTitle}`,
      `URL: ${resolvedUrl}`,
      "",
      result.formatted_text || "",
    ].join("\n");
  };

  const handleCopyText = async () => {
    const content = buildTxtContent();
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleCopyAi = async () => {
    const content = buildAiCopyContent();
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedAi(true);
      setTimeout(() => setCopiedAi(false), 2200);
    } catch {
      // Fallback
    }
  };

  const handleSaveTxt = async () => {
    const content = buildTxtContent();
    if (!content) return;
    setSaveError(null);
    try {
      const baseName =
        resolvedTitle !== "Sin título"
          ? `transcripcion_${resolvedTitle.slice(0, 60)}`
          : `transcripcion_stream_${Date.now()}`;
      const savedPath = await invoke<string | null>("save_transcription_txt", {
        content,
        defaultFilename: baseName,
        defaultDir: outputDir || null,
      });
      if (savedPath) {
        setSavedTxt(true);
        setSavedPathNotice(savedPath);
        setTimeout(() => setSavedTxt(false), 3000);
      }
    } catch (err: any) {
      setSaveError(String(err || "No se pudo guardar el archivo .txt"));
    }
  };

  const peakCount = result?.segments.filter((s) => s.is_peak).length ?? 0;
  const emotionCount = result?.segments.filter((s) => Boolean(s.emotion)).length ?? 0;
  const reactionCount =
    result?.segments.reduce((acc, s) => acc + (s.events?.length ?? 0), 0) ?? 0;
  const stageBadge = STAGE_BADGES[progress.stage] || "Procesando";

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 select-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={handleRequestClose}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-[#111114] shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#18181C]/80 px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">
                    Transcripción IA
                  </h3>
                  <Tooltip
                    side="bottom"
                    content="Ejecución local en GPU NVIDIA con Faster-Whisper + etiquetado de [RABIA], [ALEGRÍA], [RISA], [SUSPIRO], [GRITO] y [PICO DE AUDIO]"
                  >
                    <span className="flex items-center gap-1 rounded bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-semibold text-indigo-300 cursor-help">
                      <Zap className="h-2.5 w-2.5 text-indigo-400" />
                      Whisper + Emociones
                    </span>
                  </Tooltip>
                </div>
              </div>

              <button
                type="button"
                onClick={handleRequestClose}
                className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white smooth-btn"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar text-xs">
              {status === "idle" && (
                <div className="flex flex-col items-center justify-center py-2 text-center space-y-3.5">
                  <div className="w-full rounded-xl border border-white/10 bg-black/40 p-3 text-left space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                        URL a transcribir
                      </span>
                      {targetMatchesLoaded && videoTitle && (
                        <span
                          className="text-[10px] text-emerald-400 truncate max-w-[260px]"
                          title={videoTitle}
                        >
                          {videoTitle}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={targetUrl}
                        onChange={(e) => handleTargetUrlChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && trimmedTargetUrl) {
                            e.preventDefault();
                            void handleStart();
                          }
                        }}
                        placeholder="Pega aquí la URL del video o stream..."
                        className="h-8 flex-1 min-w-0 rounded-lg border border-white/10 bg-[#09090B] px-2.5 font-mono text-xs text-indigo-300 placeholder-slate-500 outline-none focus:border-indigo-500/60 transition select-text"
                      />
                      {targetUrl && (
                        <Tooltip content="Limpiar URL">
                          <button
                            type="button"
                            onClick={() => handleTargetUrlChange("")}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/10 hover:text-white smooth-btn shrink-0"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content="Pegar URL del portapapeles">
                        <button
                          type="button"
                          onClick={handlePasteTargetUrl}
                          className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white smooth-btn shrink-0"
                        >
                          <ClipboardPaste className="h-3.5 w-3.5 text-indigo-400" />
                          <span>{urlPasteNotice ? "¡Pegado!" : "Pegar"}</span>
                        </button>
                      </Tooltip>
                    </div>
                  </div>

                  {/* Options: Scope, Language, Model & Emotion Detection */}
                  <div className="w-full space-y-2.5">
                    {hasRange && (
                      <div className="rounded-xl border border-white/5 bg-black/40 p-2.5 text-left space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                          <Clock className="h-3.5 w-3.5 text-indigo-400" />
                          <span>Tramo a transcribir</span>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={() => setScope("full")}
                            className={`rounded-lg py-1.5 px-2 text-[11px] font-semibold smooth-btn border ${
                              scope === "full"
                                ? "bg-indigo-600/30 border-indigo-500 text-white shadow-sm"
                                : "bg-white/[0.03] border-white/5 text-slate-400 hover:text-white"
                            }`}
                          >
                            Completo
                          </button>
                          <button
                            type="button"
                            onClick={() => setScope("range")}
                            className={`rounded-lg py-1.5 px-2 text-[11px] font-semibold smooth-btn border ${
                              scope === "range"
                                ? "bg-indigo-600/30 border-indigo-500 text-white shadow-sm"
                                : "bg-white/[0.03] border-white/5 text-slate-400 hover:text-white"
                            }`}
                          >
                            Rango ({formatTimeShort(activeStart || 0)} →{" "}
                            {formatTimeShort(activeEnd || 0)})
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {/* Language Selector */}
                      <Tooltip
                        className="block w-full"
                        content="Fuerza el idioma para mayor velocidad o déjalo en Auto para detección automática"
                      >
                        <div className="rounded-xl border border-white/5 bg-black/40 p-2.5 text-left space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                            <Globe className="h-3.5 w-3.5 text-indigo-400" />
                            <span>Idioma</span>
                          </div>
                          <div className="grid grid-cols-3 gap-1">
                            {[
                              { id: "es", label: "Español" },
                              { id: "auto", label: "Auto" },
                              { id: "en", label: "Inglés" },
                            ].map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setSelectedLanguage(opt.id as "es" | "auto" | "en")}
                                className={`rounded-lg py-1.5 px-1.5 text-[11px] font-semibold smooth-btn border ${
                                  selectedLanguage === opt.id
                                    ? "bg-indigo-600/30 border-indigo-500 text-white shadow-sm"
                                    : "bg-white/[0.03] border-white/5 text-slate-400 hover:text-white"
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </Tooltip>

                      {/* Whisper Model Quality */}
                      <Tooltip
                        className="block w-full"
                        content="Small es más rápido y ligero en VRAM; Medium ofrece mayor precisión en jerga o audio difícil"
                      >
                        <div className="rounded-xl border border-white/5 bg-black/40 p-2.5 text-left space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                            <Cpu className="h-3.5 w-3.5 text-indigo-400" />
                            <span>Modelo Whisper</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => setModelSize("small")}
                              className={`rounded-lg py-1.5 px-2 text-[11px] font-semibold smooth-btn border ${
                                modelSize === "small"
                                  ? "bg-indigo-600/30 border-indigo-500 text-white shadow-sm"
                                  : "bg-white/[0.03] border-white/5 text-slate-400 hover:text-white"
                              }`}
                            >
                              Small (Rápido)
                            </button>
                            <button
                              type="button"
                              onClick={() => setModelSize("medium")}
                              className={`rounded-lg py-1.5 px-2 text-[11px] font-semibold smooth-btn border ${
                                modelSize === "medium"
                                  ? "bg-indigo-600/30 border-indigo-500 text-white shadow-sm"
                                  : "bg-white/[0.03] border-white/5 text-slate-400 hover:text-white"
                              }`}
                            >
                              Medium (Preciso)
                            </button>
                          </div>
                        </div>
                      </Tooltip>
                    </div>

                    {/* Emotion & Paralinguistic Tagging Toggle */}
                    <Tooltip
                      className="block w-full"
                      content="Añade etiquetas [RABIA], [ALEGRÍA], [RISA], [CARCAJADA], [SUSPIRO], [GRITO] y detecta reacciones en pausas"
                    >
                      <button
                        type="button"
                        onClick={() => setDetectEmotions((v) => !v)}
                        className={`flex w-full items-center justify-between rounded-xl border p-2.5 text-left smooth-btn ${
                          detectEmotions
                            ? "border-indigo-500/40 bg-indigo-500/10 text-slate-100"
                            : "border-white/10 bg-black/40 text-slate-400 hover:border-white/20"
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                              detectEmotions
                                ? "bg-indigo-500/25 text-indigo-300"
                                : "bg-white/5 text-slate-500"
                            }`}
                          >
                            <HeartPulse className="h-4 w-4" />
                          </div>
                          <span className="text-xs font-semibold">
                            Detectar emociones y reacciones
                          </span>
                        </div>
                        <div
                          className={`h-5 w-9 rounded-full p-0.5 transition-colors ${
                            detectEmotions ? "bg-indigo-500" : "bg-white/15"
                          }`}
                        >
                          <div
                            className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${
                              detectEmotions ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </div>
                      </button>
                    </Tooltip>
                  </div>

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    type="button"
                    onClick={handleStart}
                    disabled={!trimmedTargetUrl}
                    className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-6 py-2.5 font-bold text-white shadow-lg shadow-indigo-500/25 smooth-btn disabled:opacity-40"
                  >
                    <Sparkles className="h-4 w-4" />
                    <span>Comenzar Transcripción</span>
                  </motion.button>
                </div>
              )}

              {status === "running" && (
                <div className="flex flex-col items-center justify-center py-4 space-y-4 text-center">
                  <div className="relative flex h-14 w-14 items-center justify-center">
                    <Loader2 className="h-11 w-11 animate-spin text-indigo-500" />
                    <Sparkles className="absolute h-4 w-4 text-indigo-300" />
                  </div>

                  <div className="space-y-1.5 w-full max-w-lg">
                    <div className="flex items-center justify-center gap-2">
                      <span className="rounded-full bg-indigo-500/20 border border-indigo-500/35 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-300">
                        {stageBadge}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-indigo-300 font-bold">
                        {progress.percent.toFixed(1)}%
                      </span>
                    </div>

                    <h4 className="text-sm font-bold text-white px-2">
                      {progress.message || "Procesando audio..."}
                    </h4>

                    {progress.detail && (
                      <div className="font-mono text-[11px] tabular-nums text-slate-300 bg-white/[0.04] border border-white/10 rounded-lg px-2.5 py-1 inline-block">
                        {progress.detail}
                      </div>
                    )}
                  </div>

                  {/* Progress bar */}
                  <div className="h-2.5 w-full max-w-lg overflow-hidden rounded-full bg-black/60 border border-white/10">
                    <motion.div
                      className="h-full bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-400"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                      transition={{ duration: 0.25 }}
                    />
                  </div>

                  {/* Live Activity Log */}
                  <div className="w-full max-w-lg rounded-xl border border-white/10 bg-[#09090B] text-left overflow-hidden">
                    <div className="flex items-center justify-between border-b border-white/10 bg-[#18181C]/60 px-3 py-1.5 text-[10px] font-semibold text-slate-400">
                      <span className="flex items-center gap-1.5">
                        <Terminal className="h-3 w-3 text-indigo-400" />
                        Actividad en tiempo real
                      </span>
                      <span className="font-mono text-slate-500">{logs.length} eventos</span>
                    </div>
                    <div className="h-32 overflow-y-auto p-2.5 font-mono text-[10px] text-slate-300 space-y-1 custom-scrollbar select-text">
                      {logs.length === 0 ? (
                        <div className="text-slate-500 italic">Esperando respuesta del motor...</div>
                      ) : (
                        logs.map((line, i) => (
                          <div key={i} className="leading-snug break-words">
                            {line}
                          </div>
                        ))
                      )}
                      <div ref={logEndRef} />
                    </div>
                  </div>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={isCancelling}
                      className="flex items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-white smooth-btn disabled:opacity-50"
                    >
                      <StopCircle className="h-3.5 w-3.5" />
                      <span>{isCancelling ? "Cancelando..." : "Cancelar"}</span>
                    </button>
                  </div>
                </div>
              )}

              {status === "error" && (
                <div className="flex flex-col items-center justify-center py-6 space-y-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400">
                    <AlertCircle className="h-6 w-6" />
                  </div>
                  <h4 className="text-sm font-bold text-rose-300">
                    Error en la transcripción
                  </h4>
                  <div className="max-w-lg max-h-48 overflow-y-auto rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-left font-mono text-[11px] text-rose-200 whitespace-pre-wrap select-text custom-scrollbar">
                    {errorMessage}
                  </div>
                  <button
                    type="button"
                    onClick={handleStart}
                    className="rounded-lg bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/15 smooth-btn"
                  >
                    Reintentar
                  </button>
                </div>
              )}

              {status === "completed" && result && (
                <div className="space-y-3">
                  {/* Stats bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#18181C] p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="flex items-center gap-1 font-mono text-[11px] text-slate-300">
                        <Cpu className="h-3.5 w-3.5 text-indigo-400" />
                        <strong className="text-indigo-300 uppercase">{result.device}</strong>
                      </span>
                      <span className="flex items-center gap-1 font-mono text-[11px] text-slate-300">
                        <Volume2 className="h-3.5 w-3.5 text-amber-400" />
                        Picos: <strong className="text-amber-300">{peakCount}</strong>
                      </span>
                      <span className="flex items-center gap-1 font-mono text-[11px] text-slate-300">
                        <HeartPulse className="h-3.5 w-3.5 text-rose-400" />
                        Emociones: <strong className="text-rose-300">{emotionCount}</strong>
                      </span>
                      <span className="flex items-center gap-1 font-mono text-[11px] text-slate-300">
                        <Smile className="h-3.5 w-3.5 text-emerald-400" />
                        Reacciones: <strong className="text-emerald-300">{reactionCount}</strong>
                      </span>
                      <span className="font-mono text-[11px] text-slate-400">
                        {result.segments.length} segs
                      </span>
                    </div>

                    <Tooltip content="Transcribir otro video o URL">
                      <button
                        type="button"
                        onClick={handleResetToIdle}
                        className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white smooth-btn"
                      >
                        <RotateCcw className="h-3 w-3 text-indigo-400" />
                        <span>Otra URL</span>
                      </button>
                    </Tooltip>
                  </div>

                  {/* Embedded Video Metadata Preview */}
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] space-y-0.5 select-text">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="text-slate-400 shrink-0 font-semibold">Título:</span>
                      <span className="text-slate-200 truncate" title={resolvedTitle}>
                        {resolvedTitle}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="text-slate-400 shrink-0 font-semibold">URL:</span>
                      <span className="text-indigo-300 font-mono text-[10px] truncate" title={resolvedUrl}>
                        {resolvedUrl}
                      </span>
                    </div>
                  </div>

                  {savedPathNotice && (
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-300 select-text">
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate" title={savedPathNotice}>
                        Guardado en: {savedPathNotice}
                      </span>
                    </div>
                  )}

                  {saveError && (
                    <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300 select-text">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate" title={saveError}>
                        {saveError}
                      </span>
                    </div>
                  )}

                  {/* Formatted Text View */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Resultado:</span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        [inicio - fin] [EMOCIÓN] [REACCIÓN] texto
                      </span>
                    </div>
                    <div className="max-h-72 w-full overflow-y-auto rounded-xl border border-white/10 bg-[#09090B] p-3 font-mono text-[11px] text-slate-200 custom-scrollbar whitespace-pre-wrap select-text leading-relaxed">
                      {result.formatted_text || "(No se detectó diálogo ni eventos vocales en este audio.)"}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            {status === "completed" && result && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 bg-[#18181C]/70 px-5 py-3">
                <Tooltip content="Guardar transcripción completa en un archivo .txt">
                  <button
                    type="button"
                    onClick={handleSaveTxt}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium text-slate-200 hover:bg-white/10 smooth-btn"
                  >
                    {savedTxt ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                        <span>¡Guardado .txt!</span>
                      </>
                    ) : (
                      <>
                        <Download className="h-3.5 w-3.5 text-indigo-400" />
                        <span>Guardar .txt</span>
                      </>
                    )}
                  </button>
                </Tooltip>

                <Tooltip content="Copiar título, URL y texto transcrito">
                  <button
                    type="button"
                    onClick={handleCopyText}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 font-semibold text-white hover:bg-white/10 smooth-btn"
                  >
                    {copiedText ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                        <span>¡Copiado!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5 text-indigo-300" />
                        <span>Copiar Texto</span>
                      </>
                    )}
                  </button>
                </Tooltip>

                <Tooltip content="Copia con cabecera --clipgen, título y URL listos para pegar en tu IA">
                  <button
                    type="button"
                    onClick={handleCopyAi}
                    className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-3.5 py-1.5 font-semibold text-white shadow-md shadow-indigo-500/25 hover:from-indigo-400 smooth-btn"
                  >
                    {copiedAi ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        <span>¡Copiado (--clipgen)!</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>Copiar para IA</span>
                      </>
                    )}
                  </button>
                </Tooltip>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
