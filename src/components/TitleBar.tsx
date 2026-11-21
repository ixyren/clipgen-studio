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
} from "lucide-react";
import type { BinaryStatus } from "../types";

interface TitleBarProps {
  url: string;
  onUrlChange: (value: string) => void;
  onAnalyze: (overrideUrl?: string) => void;
  analyzing: boolean;
  binaryStatus: BinaryStatus | null;
  onOpenSettings: () => void;
  error: string | null;
  onDismissError?: () => void;
  onOpenTranscription: () => void;
  onCopyAiPrompt: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  url,
  onUrlChange,
  onAnalyze,
  analyzing,
  binaryStatus,
  onOpenSettings,
  error,
  onDismissError,
  onOpenTranscription,
  onCopyAiPrompt,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [pasteNotice, setPasteNotice] = useState(false);

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
        const cleaned = text.trim();
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

  const enginesReady =
    Boolean(binaryStatus?.ytdlp_installed) &&
    Boolean(binaryStatus?.ffmpeg_installed);

  return (
    <header
      data-tauri-drag-region
      onMouseDown={handleStartDragging}
      onDoubleClick={handleDoubleClick}
      className="relative z-40 flex h-14 w-full select-none items-center justify-between border-b border-white/10 bg-[#09090B]/95 px-3 backdrop-blur-xl cursor-default"
    >
      {/* Left: Brand Identity (Draggable) */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 pr-4 cursor-default shrink-0"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-md shadow-indigo-500/25 pointer-events-none">
          <Scissors className="h-4 w-4 text-white" />
        </div>
        <div className="flex flex-col pointer-events-none">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold tracking-tight text-white">
              ClipGen
            </span>
            <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-indigo-300">
              STUDIO
            </span>
          </div>
        </div>
      </div>

      {/* Center: Command Bar Container (Draggable around form) */}
      <div
        data-tauri-drag-region
        className="flex flex-1 max-w-2xl items-center justify-center px-4 cursor-default"
      >
        <form
          data-no-drag
          onSubmit={handleSubmit}
          className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-[#18181C] p-1.5 pl-3 transition-all focus-within:border-indigo-500/60 focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:shadow-lg focus-within:shadow-indigo-500/10 cursor-auto"
        >
          <Search className="pointer-events-none h-4 w-4 text-slate-400 shrink-0" />
          
          <input
            type="text"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="Pega la URL del stream o VOD (YouTube, Twitch, Kick...)"
            className="flex-1 min-w-0 bg-transparent text-xs text-white placeholder-slate-500 outline-none"
          />

          {/* Paste button: cleanly placed beside input */}
          <button
            type="button"
            onClick={handlePaste}
            title="Pegar enlace del portapapeles"
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white transition shrink-0"
          >
            <ClipboardPaste className="h-3.5 w-3.5 text-indigo-400" />
            <span>{pasteNotice ? "¡Pegado!" : "Pegar"}</span>
          </button>

          {/* Submit / Cargar Button: cleanly placed beside Pegar, says only 'Cargar' */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            type="submit"
            disabled={analyzing || !url.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-500/25 transition disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
          >
            {analyzing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Cargando...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                <span>Cargar</span>
              </>
            )}
          </motion.button>

          {/* Extraer Transcripción button */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={onOpenTranscription}
            disabled={analyzing || !url.trim()}
            title="Extraer transcripción local con timestamps y picos de audio (Whisper GPU)"
            className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/20 hover:text-white transition disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
          >
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            <span>Extraer Transcripción</span>
          </motion.button>
        </form>
      </div>

      {/* Right: Engine status, Settings & Native Window Controls */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 pl-2 shrink-0"
      >
        <button
          type="button"
          onClick={onCopyAiPrompt}
          title="Copiar prompt maestro para IA (ChatGPT / Claude / Gemini)"
          className="hidden md:flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white transition"
        >
          <Copy className="h-3 w-3 text-indigo-400" />
          <span>Prompt IA</span>
        </button>
        {/* Engine status indicator pill */}
        <button
          type="button"
          onClick={onOpenSettings}
          title={
            enginesReady
              ? "yt-dlp y FFmpeg listos para exportar"
              : "Verificando binarios del motor..."
          }
          className="hidden sm:flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#18181C] px-2.5 py-1 text-xs text-slate-300 hover:border-white/20 transition"
        >
          <div
            className={`h-2 w-2 rounded-full ${
              enginesReady ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "bg-amber-400 animate-pulse"
            }`}
          />
          <span className="text-[11px] font-medium text-slate-300">
            {enginesReady ? "Motores OK" : "Config"}
          </span>
        </button>

        {/* Settings button */}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Ajustes de descarga y exportación"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#18181C] text-slate-300 hover:border-white/20 hover:text-white transition"
        >
          <Settings2 className="h-4 w-4" />
        </button>

        {/* Native Window Controls */}
        <div className="flex items-center ml-1 border-l border-white/10 pl-2">
          <button
            type="button"
            onClick={handleMinimize}
            title="Minimizar"
            className="flex h-8 w-9 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleToggleMaximize}
            title={isMaximized ? "Restaurar" : "Maximizar"}
            className="flex h-8 w-9 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-white transition"
          >
            {isMaximized ? (
              <Copy className="h-3.5 w-3.5 rotate-180" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Cerrar"
            className="flex h-8 w-9 items-center justify-center rounded text-slate-400 hover:bg-rose-600 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Floating Error Banner if any */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute left-1/2 top-14 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-rose-500/40 bg-[#18181C] px-4 py-2 text-xs text-rose-200 shadow-2xl backdrop-blur-xl"
          >
            <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
            <span className="truncate max-w-md">{error}</span>
            {onDismissError && (
              <button
                type="button"
                onClick={onDismissError}
                className="ml-2 rounded p-0.5 hover:bg-white/10 text-slate-400 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
};
