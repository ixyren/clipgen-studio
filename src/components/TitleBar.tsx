import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion, AnimatePresence } from "framer-motion";
import {
  Scissors,
  Search,
  ClipboardPaste,
  Loader2,
  Minus,
  Square,
  Copy,
  X,
  Settings2,
  AlertTriangle,
  Sparkles,
  Check,
  ArrowRight,
} from "lucide-react";
import type { BinaryStatus } from "../types";
import { Tooltip } from "./Tooltip";

interface TitleBarProps {
  url: string;
  onUrlChange: (value: string) => void;
  onAnalyze: (overrideUrl?: string) => void;
  analyzing: boolean;
  binaryStatus: BinaryStatus | null;
  onOpenSettings: () => void;
  onOpenEngines?: () => void;
  error: string | null;
  onDismissError?: () => void;
  onOpenTranscription: () => void;
  onCopyAiPrompt: () => void;
}

function sanitizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/https?:\/\/\S+/);
  const candidate = match ? match[0] : trimmed;
  return candidate.replace(/^["'<(\[]+|[)"'>\],;]+$/g, "");
}

export const TitleBar: React.FC<TitleBarProps> = ({
  url,
  onUrlChange,
  onAnalyze,
  analyzing,
  binaryStatus,
  onOpenSettings,
  onOpenEngines,
  error,
  onDismissError,
  onOpenTranscription,
  onCopyAiPrompt,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [pasteNotice, setPasteNotice] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const checkState = async () => {
      try {
        const isMax = await invoke<boolean>("app_is_maximized");
        setIsMaximized(isMax);
      } catch {
        try {
          const appWindow = getCurrentWindow();
          setIsMaximized(await appWindow.isMaximized());
        } catch {
          // Non-tauri browser mode
        }
      }

      try {
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onResized(async () => {
          try {
            setIsMaximized(await invoke<boolean>("app_is_maximized"));
          } catch {
            setIsMaximized(await appWindow.isMaximized());
          }
        });
      } catch {
        // Fallback
      }
    };

    void checkState();
    return () => {
      unlisten?.();
    };
  }, []);

  const handleStartDragging = (e: React.MouseEvent) => {
    // Only drag with left mouse button
    if (e.button !== 0) return;

    // Do not initiate drag if user clicked on buttons, inputs, forms or elements marked data-no-drag
    const target = e.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("form") ||
      target.closest("select") ||
      target.closest("textarea") ||
      target.closest("[data-no-drag]")
    ) {
      return;
    }

    if (e.detail === 2) {
      void handleToggleMaximize();
      return;
    }

    try {
      void getCurrentWindow().startDragging();
    } catch {
      void invoke("app_start_dragging");
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("form") ||
      target.closest("[data-no-drag]")
    ) {
      return;
    }
    void handleToggleMaximize();
  };

  const handleMinimize = async () => {
    try {
      await invoke("app_minimize");
    } catch {
      try {
        await getCurrentWindow().minimize();
      } catch (err) {
        console.warn("Minimize error:", err);
      }
    }
  };

  const handleToggleMaximize = async () => {
    try {
      const isMax = await invoke<boolean>("app_toggle_maximize");
      setIsMaximized(isMax);
    } catch {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.toggleMaximize();
        setIsMaximized(await appWindow.isMaximized());
      } catch (err) {
        console.warn("Maximize error:", err);
      }
    }
  };

  const handleClose = async () => {
    try {
      await invoke("app_close");
    } catch {
      try {
        await getCurrentWindow().close();
      } catch (err) {
        console.warn("Close error:", err);
      }
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const cleaned = sanitizeUrlInput(text);
        if (!cleaned) return;
        onUrlChange(cleaned);
        setPasteNotice(true);
        setTimeout(() => setPasteNotice(false), 1200);
        if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
          onAnalyze(cleaned);
        }
      }
    } catch {
      // Permission denied
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim() && !analyzing) {
      onAnalyze();
    }
  };

  const handleCopyPrompt = () => {
    onCopyAiPrompt();
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 1500);
  };

  const enginesReady =
    Boolean(binaryStatus?.ytdlp_installed) &&
    Boolean(binaryStatus?.ffmpeg_installed);
  const hasUpdates =
    Boolean(binaryStatus?.ytdlp_update_available) ||
    Boolean(binaryStatus?.ffmpeg_update_available);

  return (
    <header
      data-tauri-drag-region
      onMouseDown={handleStartDragging}
      onDoubleClick={handleDoubleClick}
      className="relative z-40 flex h-13 w-full select-none items-center justify-between border-b border-white/10 bg-[#09090B]/95 px-3 backdrop-blur-xl cursor-default"
    >
      {/* Left: Brand Identity (Draggable) */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2.5 pr-3 cursor-default shrink-0"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-md shadow-indigo-500/25 pointer-events-none">
          <Scissors className="h-4 w-4 text-white" />
        </div>
        <div className="flex items-center gap-1.5 pointer-events-none">
          <span className="text-sm font-bold tracking-tight text-white">
            ClipGen
          </span>
          <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-indigo-300">
            STUDIO
          </span>
          <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-400">
            v0.2.1
          </span>
        </div>
      </div>

      {/* Center: Command Bar Container (Draggable around form) */}
      <div
        data-tauri-drag-region
        className="flex flex-1 max-w-2xl items-center justify-center px-3 cursor-default"
      >
        <form
          data-no-drag
          onSubmit={handleSubmit}
          className="flex w-full items-center gap-1.5 rounded-xl border border-white/10 bg-[#18181C] p-1 pl-3 transition-all focus-within:border-indigo-500/60 focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:shadow-lg focus-within:shadow-indigo-500/10 cursor-auto"
        >
          <Search className="pointer-events-none h-3.5 w-3.5 text-slate-400 shrink-0" />

          <input
            type="text"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="Pega URL de YouTube, Twitch o Kick..."
            className="flex-1 min-w-0 bg-transparent text-xs text-white placeholder-slate-500 outline-none"
          />

          <Tooltip side="bottom" content="Pegar enlace del portapapeles y cargar">
            <button
              type="button"
              onClick={handlePaste}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white smooth-btn shrink-0"
            >
              <ClipboardPaste className="h-3.5 w-3.5 text-indigo-400" />
              <span>{pasteNotice ? "¡Pegado!" : "Pegar"}</span>
            </button>
          </Tooltip>

          <Tooltip side="bottom" content="Cargar video en el visor">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="submit"
              disabled={analyzing || !url.trim()}
              className="flex items-center gap-1 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-3 py-1 text-xs font-semibold text-white shadow-md shadow-indigo-500/25 smooth-btn disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
            >
              {analyzing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Cargando</span>
                </>
              ) : (
                <>
                  <span>Cargar</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </motion.button>
          </Tooltip>

          <Tooltip
            side="bottom"
            content="Transcribir audio en GPU local con timestamps, emociones y picos de volumen"
          >
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="button"
              onClick={onOpenTranscription}
              disabled={analyzing}
              className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/20 hover:text-white smooth-btn disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
            >
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              <span>Transcribir</span>
            </motion.button>
          </Tooltip>
        </form>
      </div>

      {/* Right: Prompt IA, Unified Settings+Status & Window Controls */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 pl-2 shrink-0"
      >
        <Tooltip
          side="bottom"
          content="Copiar prompt maestro para generar clips JSON con IA (ChatGPT / Claude / Gemini)"
        >
          <button
            type="button"
            onClick={handleCopyPrompt}
            className={`hidden md:flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium smooth-btn ${
              promptCopied
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            {promptCopied ? (
              <Check className="h-3 w-3 text-emerald-400" />
            ) : (
              <Copy className="h-3 w-3 text-indigo-400" />
            )}
            <span>{promptCopied ? "¡Copiado!" : "Prompt IA"}</span>
          </button>
        </Tooltip>

        <Tooltip
          side="bottom"
          content={
            !enginesReady
              ? "Ajustes · Verificando o instalando motores..."
              : hasUpdates
              ? "Actualización disponible para yt-dlp / FFmpeg (clic para instalar)"
              : "Ajustes de exportación · Motores yt-dlp y FFmpeg al día"
          }
        >
          <button
            type="button"
            onClick={hasUpdates && onOpenEngines ? onOpenEngines : onOpenSettings}
            className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-[#18181C] px-2.5 text-slate-300 hover:border-white/20 hover:text-white smooth-btn"
          >
            <div
              className={`h-2 w-2 rounded-full ${
                !enginesReady
                  ? "bg-amber-400 animate-pulse"
                  : hasUpdates
                  ? "bg-sky-400 animate-pulse shadow-[0_0_8px_rgba(56,189,248,0.85)]"
                  : "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
              }`}
            />
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>

        {/* Native Window Controls */}
        <div className="flex items-center ml-1 border-l border-white/10 pl-2">
          <Tooltip side="bottom" content="Minimizar">
            <button
              type="button"
              onClick={handleMinimize}
              className="flex h-8 w-8 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white smooth-btn"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip side="bottom" content={isMaximized ? "Restaurar" : "Maximizar"}>
            <button
              type="button"
              onClick={handleToggleMaximize}
              className="flex h-8 w-8 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white smooth-btn"
            >
              {isMaximized ? (
                <Copy className="h-3.5 w-3.5 rotate-180" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
          <Tooltip side="bottom" content="Cerrar">
            <button
              type="button"
              onClick={handleClose}
              className="flex h-8 w-8 items-center justify-center rounded text-slate-400 hover:bg-rose-600 hover:text-white smooth-btn"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Floating Error Banner if any */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute left-1/2 top-14 z-50 flex w-max max-w-xl items-start gap-2.5 -translate-x-1/2 rounded-xl border border-rose-500/40 bg-[#18181C]/95 px-4 py-2.5 text-xs text-rose-200 shadow-2xl backdrop-blur-xl"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 text-rose-400 shrink-0" />
            <span className="flex-1 leading-relaxed select-text break-words">
              {error}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {(hasUpdates ||
                /yt-dlp|extractor|signature|nsig/i.test(error)) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (onOpenEngines) onOpenEngines();
                      else onOpenSettings();
                    }}
                    className="flex items-center gap-1 rounded-lg border border-sky-500/30 bg-sky-500/15 px-2 py-1 text-[10px] font-semibold text-sky-300 hover:bg-sky-500/25 hover:text-white smooth-btn"
                  >
                    <span>Actualizar motores</span>
                    <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              <Tooltip
                side="bottom"
                content={errorCopied ? "Copiado" : "Copiar detalle del error"}
              >
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(error);
                      setErrorCopied(true);
                      setTimeout(() => setErrorCopied(false), 1500);
                    } catch {
                      // Clipboard unavailable
                    }
                  }}
                  className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white smooth-btn"
                >
                  {errorCopied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </Tooltip>
              {onDismissError && (
                <button
                  type="button"
                  onClick={onDismissError}
                  className="rounded p-1 hover:bg-white/10 text-slate-400 hover:text-white smooth-btn"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
};
