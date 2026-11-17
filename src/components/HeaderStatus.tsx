import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  DownloadCloud,
  RefreshCw,
  Scissors,
  Sparkles,
} from "lucide-react";
import type { BinaryStatus, BinaryUpdateProgress } from "../types";

export interface UpdateNotice {
  kind: "ok" | "available" | "error";
  text: string;
}

interface HeaderStatusProps {
  status: BinaryStatus | null;
  checking: boolean;
  updating: boolean;
  progressMap: Record<string, BinaryUpdateProgress>;
  notice: UpdateNotice | null;
  onCheckUpdates: () => void;
  onInstallUpdates: () => void;
  onDismissNotice: () => void;
}

export const HeaderStatus: React.FC<HeaderStatusProps> = ({
  status,
  checking,
  updating,
  progressMap,
  notice,
  onCheckUpdates,
  onInstallUpdates,
  onDismissNotice,
}) => {
  const ytdlpProg = progressMap["yt-dlp"];
  const ffmpegProg = progressMap["ffmpeg"];
  const activeProg = [ytdlpProg, ffmpegProg].find(
    (p) =>
      p &&
      (p.stage === "checking" ||
        p.stage === "downloading" ||
        p.stage === "extracting")
  );

  const ytdlpReady = Boolean(status?.ytdlp_installed);
  const ffmpegReady = Boolean(status?.ffmpeg_installed);
  const ytdlpHasUpdate = Boolean(status?.ytdlp_update_available);
  const ffmpegHasUpdate = Boolean(status?.ffmpeg_update_available);
  const hasUpdates = ytdlpHasUpdate || ffmpegHasUpdate;
  const missingAny = status ? !ytdlpReady || !ffmpegReady : false;

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#090A0F]/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-5 py-3.5">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-cyan-500 shadow-lg shadow-violet-600/25">
            <Scissors className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-white">
                ClipGen Studio
              </h1>
            </div>
            <p className="text-xs text-slate-400">
              Descarga avanzada y estudio multi-clip con vista previa en vivo
            </p>
          </div>
        </div>

        {/* Engine Status Pills & Update Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* yt-dlp pill */}
          <div
            className={`flex items-center gap-2.5 rounded-xl border px-3 py-1.5 text-xs ${
              ytdlpHasUpdate
                ? "border-amber-500/35 bg-amber-500/10"
                : "border-white/10 bg-white/[0.03]"
            }`}
          >
            <DownloadCloud
              className={`h-4 w-4 ${
                !ytdlpReady || ytdlpHasUpdate
                  ? "text-amber-400"
                  : "text-emerald-400"
              }`}
            />
            <div className="leading-tight">
              <div className="flex items-center gap-1.5 font-medium text-slate-200">
                <span>yt-dlp</span>
                {ytdlpReady && !ytdlpHasUpdate ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                )}
              </div>
              <div className="text-[11px] text-slate-400">
                {ytdlpProg &&
                (ytdlpProg.stage === "downloading" || ytdlpProg.stage === "checking")
                  ? ytdlpProg.stage === "downloading"
                    ? `Descargando ${ytdlpProg.percent.toFixed(0)}%`
                    : "Comprobando..."
                  : status?.ytdlp_version
                  ? ytdlpHasUpdate && status.ytdlp_latest
                    ? `v${status.ytdlp_version} → v${status.ytdlp_latest}`
                    : `v${status.ytdlp_version} (Al día)`
                  : "No instalado"}
              </div>
            </div>
          </div>

          {/* FFmpeg pill */}
          <div
            className={`flex items-center gap-2.5 rounded-xl border px-3 py-1.5 text-xs ${
              ffmpegHasUpdate
                ? "border-amber-500/35 bg-amber-500/10"
                : "border-white/10 bg-white/[0.03]"
            }`}
          >
            <Cpu
              className={`h-4 w-4 ${
                !ffmpegReady || ffmpegHasUpdate
                  ? "text-amber-400"
                  : "text-cyan-400"
              }`}
            />
            <div className="leading-tight">
              <div className="flex items-center gap-1.5 font-medium text-slate-200">
                <span>FFmpeg</span>
                {ffmpegReady && !ffmpegHasUpdate ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-cyan-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                )}
              </div>
              <div className="max-w-[200px] truncate text-[11px] text-slate-400">
                {ffmpegProg &&
                (ffmpegProg.stage === "downloading" ||
                  ffmpegProg.stage === "extracting" ||
                  ffmpegProg.stage === "checking")
                  ? ffmpegProg.stage === "downloading"
                    ? `Descargando ${ffmpegProg.percent.toFixed(0)}%`
                    : ffmpegProg.stage === "extracting"
                    ? "Extrayendo..."
                    : "Comprobando..."
                  : status?.ffmpeg_version
                  ? ffmpegHasUpdate && status.ffmpeg_latest
                    ? `Nueva build (${status.ffmpeg_latest})`
                    : `${status.ffmpeg_version} (Al día)`
                  : "No instalado"}
              </div>
            </div>
          </div>

          {/* Check updates button (never downloads unnecessarily) */}
          <button
            type="button"
            onClick={onCheckUpdates}
            disabled={checking || updating}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:border-violet-500/40 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                checking ? "animate-spin text-cyan-400" : ""
              }`}
            />
            <span>
              {checking ? "Comprobando..." : "Comprobar actualizaciones"}
            </span>
          </button>

          {/* Install update button (only shown when missing or update actually exists) */}
          {(hasUpdates || missingAny) && (
            <button
              type="button"
              onClick={onInstallUpdates}
              disabled={updating || checking}
              className="studio-gradient-btn flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Download className="h-3.5 w-3.5" />
              <span>
                {updating
                  ? "Actualizando..."
                  : missingAny
                  ? "Instalar motores"
                  : "Descargar actualización"}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Update check notification banner */}
      {notice && !activeProg && (
        <div
          className={`border-t px-5 py-2 text-xs ${
            notice.kind === "ok"
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
              : notice.kind === "available"
              ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
              : "border-rose-500/25 bg-rose-500/10 text-rose-200"
          }`}
        >
          <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {notice.kind === "ok" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : notice.kind === "available" ? (
                <Sparkles className="h-4 w-4 shrink-0 text-amber-400" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
              )}
              <span>{notice.text}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {notice.kind === "available" && (
                <button
                  type="button"
                  onClick={onInstallUpdates}
                  disabled={updating}
                  className="rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-amber-400"
                >
                  Actualizar ahora
                </button>
              )}
              <button
                type="button"
                onClick={onDismissNotice}
                className="text-[11px] opacity-75 hover:opacity-100"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live download/extraction progress banner */}
      {activeProg && (
        <div className="border-t border-white/5 bg-[#0D101A] px-5 py-2">
          <div className="mx-auto flex max-w-[1600px] items-center gap-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-cyan-300">
              {activeProg.binary}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all duration-200"
                style={{
                  width: `${Math.min(100, Math.max(4, activeProg.percent))}%`,
                }}
              />
            </div>
            <span className="text-xs text-slate-300">{activeProg.message}</span>
          </div>
        </div>
      )}
    </header>
  );
};
