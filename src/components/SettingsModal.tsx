import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Settings2,
  Folder,
  FolderOpen,
  DownloadCloud,
  CheckCircle2,
  RefreshCw,
  Film,
  Info,
  Loader2,
  AlertCircle,
} from "lucide-react";
import type {
  BinaryStatus,
  BinaryUpdateProgress,
  ManualDownloadOptions,
  VideoMetadata,
} from "../types";
import { Tooltip } from "./Tooltip";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  options: ManualDownloadOptions;
  onOptionsChange: (options: ManualDownloadOptions) => void;
  onPickFolder: () => void;
  onOpenFolder: (path: string) => void;
  binaryStatus: BinaryStatus | null;
  checkingUpdates: boolean;
  updatingBinaries: boolean;
  onCheckUpdates: () => void;
  onInstallUpdates: () => void;
  binaryProgress?: Record<string, BinaryUpdateProgress>;
  metadata?: VideoMetadata | null;
  initialTab?: "export" | "engines";
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  options,
  onOptionsChange,
  onPickFolder,
  onOpenFolder,
  binaryStatus,
  checkingUpdates,
  updatingBinaries,
  onCheckUpdates,
  onInstallUpdates,
  binaryProgress = {},
  initialTab = "export",
}) => {
  const [activeTab, setActiveTab] = useState<"export" | "engines">(initialTab);

  useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  const ytdlpReady = Boolean(binaryStatus?.ytdlp_installed);
  const ffmpegReady = Boolean(binaryStatus?.ffmpeg_installed);
  const hasUpdates =
    Boolean(binaryStatus?.ytdlp_update_available) ||
    Boolean(binaryStatus?.ffmpeg_update_available);

  const ytdlpProg = binaryProgress["yt-dlp"];
  const ffmpegProg = binaryProgress["ffmpeg"];

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/70 backdrop-blur-md"
          />

          {/* Modal Window */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="relative z-10 w-full max-w-lg rounded-2xl border border-white/10 bg-[#111114] p-5 shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-400">
                  <Settings2 className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">Ajustes</h3>
                  <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-400">
                    v0.2.1
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white smooth-btn"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Subtabs */}
            <div className="flex gap-1.5 border-b border-white/10 pt-3 pb-2.5 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab("export")}
                className={`rounded-lg px-3 py-1 font-semibold smooth-btn ${
                  activeTab === "export"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white hover:bg-white/[0.04]"
                }`}
              >
                Exportación
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("engines")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1 font-semibold smooth-btn ${
                  activeTab === "engines"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white hover:bg-white/[0.04]"
                }`}
              >
                <span>Motores</span>
                {hasUpdates && (
                  <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
                )}
              </button>
            </div>

            {/* Content */}
            <div className="py-4 space-y-3.5 max-h-[60vh] overflow-y-auto custom-scrollbar pr-1">
              {activeTab === "export" ? (
                <>
                  {/* Destination folder */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300">
                      Carpeta de exportación
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="flex flex-1 min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-slate-300">
                        <Folder className="h-4 w-4 text-indigo-400 shrink-0" />
                        <span className="truncate">
                          {options.output_dir || "Sin asignar"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={onPickFolder}
                        className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 smooth-btn"
                      >
                        Examinar
                      </button>
                      {options.output_dir && (
                        <Tooltip content="Abrir carpeta en el Explorador">
                          <button
                            type="button"
                            onClick={() => onOpenFolder(options.output_dir)}
                            className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-slate-300 hover:bg-white/10 smooth-btn"
                          >
                            <FolderOpen className="h-4 w-4" />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </div>

                  {/* Quality preset & Container */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs font-semibold text-slate-300">
                          Calidad
                        </label>
                        <Tooltip content="Resolución máxima objetivo para las exportaciones">
                          <Info className="h-3 w-3 text-slate-500 cursor-help" />
                        </Tooltip>
                      </div>
                      <select
                        value={options.quality_preset}
                        onChange={(e) =>
                          onOptionsChange({
                            ...options,
                            quality_preset: e.target.value as any,
                          })
                        }
                        className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500 cursor-pointer"
                      >
                        <option value="best" className="bg-[#18181C] text-white">Máxima (Original)</option>
                        <option value="2160" className="bg-[#18181C] text-white">4K UHD (2160p)</option>
                        <option value="1440" className="bg-[#18181C] text-white">2K QHD (1440p)</option>
                        <option value="1080" className="bg-[#18181C] text-white">1080p FHD</option>
                        <option value="720" className="bg-[#18181C] text-white">720p HD</option>
                        <option value="480" className="bg-[#18181C] text-white">480p</option>
                        <option value="360" className="bg-[#18181C] text-white">360p</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs font-semibold text-slate-300">
                          Contenedor
                        </label>
                        <Tooltip content="MP4 ofrece la mejor compatibilidad con editores y redes">
                          <Info className="h-3 w-3 text-slate-500 cursor-help" />
                        </Tooltip>
                      </div>
                      <select
                        value={options.container}
                        onChange={(e) =>
                          onOptionsChange({
                            ...options,
                            container: e.target.value as any,
                          })
                        }
                        className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500 cursor-pointer"
                      >
                        <option value="mp4" className="bg-[#18181C] text-white">MP4 (Recomendado)</option>
                        <option value="mkv" className="bg-[#18181C] text-white">MKV (Matroska)</option>
                        <option value="webm" className="bg-[#18181C] text-white">WebM</option>
                        <option value="mov" className="bg-[#18181C] text-white">MOV (QuickTime)</option>
                      </select>
                    </div>
                  </div>

                  {/* Mode & Audio Bitrate */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs font-semibold text-slate-300">
                          Pistas
                        </label>
                        <Tooltip content="Elige exportar video con audio, solo audio o solo imagen">
                          <Info className="h-3 w-3 text-slate-500 cursor-help" />
                        </Tooltip>
                      </div>
                      <select
                        value={options.mode}
                        onChange={(e) =>
                          onOptionsChange({
                            ...options,
                            mode: e.target.value as any,
                          })
                        }
                        className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500 cursor-pointer"
                      >
                        <option value="video_audio" className="bg-[#18181C] text-white">Video + Audio</option>
                        <option value="audio_only" className="bg-[#18181C] text-white">Solo Audio</option>
                        <option value="video_only" className="bg-[#18181C] text-white">Solo Video</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <label className="text-xs font-semibold text-slate-300">
                          Bitrate Audio
                        </label>
                        <Tooltip content="Fidelidad del audio exportado en kbps">
                          <Info className="h-3 w-3 text-slate-500 cursor-help" />
                        </Tooltip>
                      </div>
                      <select
                        value={options.audio_bitrate}
                        onChange={(e) =>
                          onOptionsChange({
                            ...options,
                            audio_bitrate: e.target.value as any,
                          })
                        }
                        className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500 cursor-pointer"
                      >
                        <option value="320K" className="bg-[#18181C] text-white">320 kbps (Máximo)</option>
                        <option value="192K" className="bg-[#18181C] text-white">192 kbps (Estándar)</option>
                        <option value="128K" className="bg-[#18181C] text-white">128 kbps (Compacto)</option>
                      </select>
                    </div>
                  </div>
                </>
              ) : (
                /* Compact Engines status with live update badges & progress */
                <div className="space-y-2.5">
                  <Tooltip
                    className="block w-full"
                    content="Extractor de streams de alto rendimiento para YouTube, Twitch y otras plataformas"
                  >
                    <div className="rounded-xl border border-white/10 bg-[#18181C] px-3.5 py-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <DownloadCloud className="h-4 w-4 text-indigo-400" />
                          <span className="text-xs font-bold text-white">yt-dlp</span>
                        </div>
                        {ytdlpReady ? (
                          <div className="flex items-center gap-2">
                            <span className="flex items-center gap-1 font-mono text-[11px] font-semibold text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              v{binaryStatus?.ytdlp_version || "Listo"}
                            </span>
                            {binaryStatus?.ytdlp_update_available &&
                              binaryStatus.ytdlp_latest && (
                                <span className="rounded bg-sky-500/20 border border-sky-400/35 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300">
                                  → v{binaryStatus.ytdlp_latest}
                                </span>
                              )}
                          </div>
                        ) : (
                          <span className="text-[11px] font-semibold text-amber-400">
                            No instalado
                          </span>
                        )}
                      </div>

                      {ytdlpProg &&
                        ytdlpProg.stage !== "ready" && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-slate-400">
                              <span className="flex items-center gap-1 truncate">
                                {ytdlpProg.stage === "error" ? (
                                  <AlertCircle className="h-3 w-3 text-rose-400 shrink-0" />
                                ) : (
                                  <Loader2 className="h-3 w-3 animate-spin text-indigo-400 shrink-0" />
                                )}
                                {ytdlpProg.message}
                              </span>
                              <span className="font-mono tabular-nums text-indigo-300 shrink-0">
                                {Math.round(ytdlpProg.percent)}%
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/60">
                              <div
                                className={`h-full transition-all duration-200 ${
                                  ytdlpProg.stage === "error"
                                    ? "bg-rose-500"
                                    : "bg-indigo-500"
                                }`}
                                style={{
                                  width: `${Math.max(0, Math.min(100, ytdlpProg.percent))}%`,
                                }}
                              />
                            </div>
                          </div>
                        )}
                    </div>
                  </Tooltip>

                  <Tooltip
                    className="block w-full"
                    content="Motor de recorte de fotograma preciso, unión de clips y remuxing en caliente"
                  >
                    <div className="rounded-xl border border-white/10 bg-[#18181C] px-3.5 py-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <Film className="h-4 w-4 text-violet-400" />
                          <span className="text-xs font-bold text-white">FFmpeg</span>
                        </div>
                        {ffmpegReady ? (
                          <div className="flex items-center gap-2">
                            <span className="flex items-center gap-1 font-mono text-[11px] font-semibold text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              {binaryStatus?.ffmpeg_version || "Listo"}
                            </span>
                            {binaryStatus?.ffmpeg_update_available &&
                              binaryStatus.ffmpeg_latest && (
                                <span className="rounded bg-sky-500/20 border border-sky-400/35 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300">
                                  → {binaryStatus.ffmpeg_latest}
                                </span>
                              )}
                          </div>
                        ) : (
                          <span className="text-[11px] font-semibold text-amber-400">
                            No instalado
                          </span>
                        )}
                      </div>

                      {ffmpegProg &&
                        ffmpegProg.stage !== "ready" && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-slate-400">
                              <span className="flex items-center gap-1 truncate">
                                {ffmpegProg.stage === "error" ? (
                                  <AlertCircle className="h-3 w-3 text-rose-400 shrink-0" />
                                ) : (
                                  <Loader2 className="h-3 w-3 animate-spin text-violet-400 shrink-0" />
                                )}
                                {ffmpegProg.message}
                              </span>
                              <span className="font-mono tabular-nums text-violet-300 shrink-0">
                                {Math.round(ffmpegProg.percent)}%
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/60">
                              <div
                                className={`h-full transition-all duration-200 ${
                                  ffmpegProg.stage === "error"
                                    ? "bg-rose-500"
                                    : "bg-violet-500"
                                }`}
                                style={{
                                  width: `${Math.max(0, Math.min(100, ffmpegProg.percent))}%`,
                                }}
                              />
                            </div>
                          </div>
                        )}
                    </div>
                  </Tooltip>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={onCheckUpdates}
                      disabled={checkingUpdates || updatingBinaries}
                      className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 smooth-btn disabled:opacity-40"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${checkingUpdates ? "animate-spin" : ""}`}
                      />
                      <span>Comprobar</span>
                    </button>

                    <button
                      type="button"
                      onClick={onInstallUpdates}
                      disabled={updatingBinaries}
                      className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 smooth-btn shadow-md shadow-indigo-500/25 disabled:opacity-40"
                    >
                      {updatingBinaries && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      <span>
                        {updatingBinaries
                          ? "Actualizando..."
                          : hasUpdates
                          ? "Instalar actualización"
                          : "Actualizar / Reinstalar"}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end border-t border-white/10 pt-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-white/10 px-4 py-1.5 text-xs font-semibold text-white hover:bg-white/15 smooth-btn"
              >
                Listo
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
