import React, { useState } from "react";
import {
  ClipboardPaste,
  Download,
  Film,
  Loader2,
  Scissors,
  Search,
  Sparkles,
  User,
  Clock,
  Eye,
  AlertCircle,
} from "lucide-react";
import type { VideoMetadata } from "../types";
import { formatTimeShort, formatViews } from "../utils/time";

export type WorkspaceTab = "clipper" | "full_download";

interface UrlAnalyzerProps {
  url: string;
  onUrlChange: (val: string) => void;
  onAnalyze: (targetUrl?: string) => void;
  analyzing: boolean;
  error: string | null;
  metadata: VideoMetadata | null;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  enginesReady: boolean;
}

export const UrlAnalyzer: React.FC<UrlAnalyzerProps> = ({
  url,
  onUrlChange,
  onAnalyze,
  analyzing,
  error,
  metadata,
  activeTab,
  onTabChange,
  enginesReady,
}) => {
  const [pasteNotice, setPasteNotice] = useState(false);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onUrlChange(text.trim());
        setPasteNotice(true);
        setTimeout(() => setPasteNotice(false), 1200);
      }
    } catch {
      // Clipboard access denied by user/webview
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAnalyze();
  };

  const maxHeight = metadata?.formats.reduce(
    (max, f) => (f.height && f.height > max ? f.height : max),
    0
  );

  return (
    <section className="space-y-4">
      {/* URL Search Bar */}
      <form
        onSubmit={handleSubmit}
        className="studio-panel rounded-2xl p-3 sm:p-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute left-3.5 h-4.5 w-4.5 text-slate-400" />
            <input
              type="text"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              placeholder="Pega la URL de YouTube (ej. https://www.youtube.com/watch?v=...)"
              className="w-full rounded-xl border border-white/10 bg-[#090A0F]/90 py-3 pl-11 pr-24 text-sm text-white placeholder-slate-500 outline-none transition focus:border-violet-500/60 focus:ring-2 focus:ring-violet-500/20"
            />
            <button
              type="button"
              onClick={handlePaste}
              className="absolute right-2 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/[0.1] hover:text-white"
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
              <span>{pasteNotice ? "Pegado" : "Pegar"}</span>
            </button>
          </div>

          <button
            type="submit"
            disabled={analyzing || !url.trim() || !enginesReady}
            className="studio-gradient-btn flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {analyzing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Analizando...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                <span>Analizar Video</span>
              </>
            )}
          </button>
        </div>

        {!enginesReady && (
          <p className="mt-2.5 text-xs text-amber-300/90">
            Esperando a que yt-dlp y FFmpeg terminen de descargarse e inicializarse...
          </p>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}
      </form>

      {/* Video Metadata Summary + Mode Switcher */}
      {metadata && (
        <div className="studio-panel flex flex-col justify-between gap-4 rounded-2xl p-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-4 min-w-0">
            {metadata.thumbnail ? (
              <img
                src={metadata.thumbnail}
                alt={metadata.title}
                className="h-16 w-28 shrink-0 rounded-xl border border-white/10 object-cover"
              />
            ) : (
              <div className="flex h-16 w-28 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5">
                <Film className="h-6 w-6 text-slate-500" />
              </div>
            )}

            <div className="min-w-0 space-y-1">
              <h2 className="truncate text-base font-semibold text-white">
                {metadata.title}
              </h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <User className="h-3.5 w-3.5 text-violet-400" />
                  {metadata.uploader}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-cyan-400" />
                  {formatTimeShort(metadata.duration)}
                </span>
                {metadata.view_count != null && (
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5 text-slate-400" />
                    {formatViews(metadata.view_count)}
                  </span>
                )}
                {maxHeight ? (
                  <span className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-300">
                    Hasta {maxHeight}p
                  </span>
                ) : null}
                {metadata.chapters.length > 0 && (
                  <span className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-300">
                    {metadata.chapters.length} capítulos
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Mode Tabs */}
          <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-[#090A0F]/80 p-1">
            <button
              type="button"
              onClick={() => onTabChange("clipper")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${
                activeTab === "clipper"
                  ? "bg-gradient-to-r from-violet-600 to-cyan-500 text-white shadow-md"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Scissors className="h-3.5 w-3.5" />
              <span>Estudio de Clips (En Vivo)</span>
            </button>
            <button
              type="button"
              onClick={() => onTabChange("full_download")}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${
                activeTab === "full_download"
                  ? "bg-gradient-to-r from-violet-600 to-cyan-500 text-white shadow-md"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Download className="h-3.5 w-3.5" />
              <span>Descarga Completa Manual</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
