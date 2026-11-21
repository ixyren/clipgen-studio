import React, { useState } from "react";
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
} from "lucide-react";
import type {
  BinaryStatus,
  BinaryUpdateProgress,
  ManualDownloadOptions,
  VideoMetadata,
} from "../types";

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
}) => {
  const [activeTab, setActiveTab] = useState<"export" | "engines">("export");

  if (!isOpen) return null;

  const ytdlpReady = Boolean(binaryStatus?.ytdlp_installed);
  const ffmpegReady = Boolean(binaryStatus?.ffmpeg_installed);
  const hasUpdates =
    Boolean(binaryStatus?.ytdlp_update_available) ||
    Boolean(binaryStatus?.ffmpeg_update_available);

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/70 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="relative z-10 w-full max-w-xl rounded-2xl border border-white/10 bg-[#111114] p-5 shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-400">
                <Settings2 className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">
                  Ajustes de ClipGen Studio
                </h3>
                <p className="text-[11px] text-slate-400">
                  Configura la calidad de corte, contenedor y motores de Rust
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Subtabs */}
          <div className="flex gap-2 border-b border-white/10 pt-3 pb-2 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("export")}
              className={`rounded-lg px-3 py-1 font-semibold transition ${
                activeTab === "export"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Parámetros de Exportación
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("engines")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1 font-semibold transition ${
                activeTab === "engines"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <span>Motores yt-dlp &amp; FFmpeg</span>
              {hasUpdates && (
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              )}
            </button>
          </div>

          {/* Content */}
          <div className="py-4 space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar pr-1">
            {activeTab === "export" ? (
              <>
                {/* Destination folder */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-300">
                    Carpeta de Descargas / Exportación
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="flex flex-1 items-center gap-2 rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-slate-300">
                      <Folder className="h-4 w-4 text-indigo-400 shrink-0" />
                      <span className="truncate">{options.output_dir || "Sin asignar"}</span>
                    </div>
                    <button
                      type="button"
                      onClick={onPickFolder}
                      className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10"
                    >
                      Examinar
                    </button>
                    {options.output_dir && (
                      <button
                        type="button"
                        onClick={() => onOpenFolder(options.output_dir)}
                        className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-slate-300 hover:bg-white/10"
                        title="Abrir carpeta"
                      >
                        <FolderOpen className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Quality preset & Container */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300">
                      Resolución / Calidad
                    </label>
                    <select
                      value={options.quality_preset}
                      onChange={(e) =>
                        onOptionsChange({
                          ...options,
                          quality_preset: e.target.value as any,
                        })
                      }
                      className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                    >
                      <option value="best">Máxima Calidad (Original)</option>
                      <option value="2160">4K UHD (2160p)</option>
                      <option value="1440">2K QHD (1440p)</option>
                      <option value="1080">1080p FHD</option>
                      <option value="720">720p HD</option>
                      <option value="480">480p</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300">
                      Contenedor de Video
                    </label>
                    <select
                      value={options.container}
                      onChange={(e) =>
                        onOptionsChange({
                          ...options,
                          container: e.target.value as any,
                        })
                      }
                      className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                    >
                      <option value="mp4">MP4 (Recomendado)</option>
                      <option value="mkv">MKV (Matroska)</option>
                      <option value="webm">WebM</option>
                      <option value="mov">MOV (QuickTime)</option>
                    </select>
                  </div>
                </div>

                {/* Audio only toggle & Bitrate */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300">
                      Modo de Exportación
                    </label>
                    <select
                      value={options.mode}
                      onChange={(e) =>
                        onOptionsChange({
                          ...options,
                          mode: e.target.value as any,
                        })
                      }
                      className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                    >
                      <option value="video_audio">Video + Audio</option>
                      <option value="audio_only">Solo Audio (MP3/FLAC)</option>
                      <option value="video_only">Solo Video (Mudo)</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-slate-300">
                      Bitrate de Audio
                    </label>
                    <select
                      value={options.audio_bitrate}
                      onChange={(e) =>
                        onOptionsChange({
                          ...options,
                          audio_bitrate: e.target.value as any,
                        })
                      }
                      className="w-full rounded-xl border border-white/10 bg-[#18181C] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                    >
                      <option value="320K">320 kbps (Máxima fidelidad)</option>
                      <option value="192K">192 kbps (Estándar)</option>
                      <option value="128K">128 kbps (Compacto)</option>
                    </select>
                  </div>
                </div>
              </>
            ) : (
              /* Engines status */
              <div className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-[#18181C] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <DownloadCloud className="h-4 w-4 text-indigo-400" />
                      <span className="text-xs font-bold text-white">yt-dlp</span>
                    </div>
                    {ytdlpReady ? (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        v{binaryStatus?.ytdlp_version || "Instalado"}
                      </span>
                    ) : (
                      <span className="text-[11px] font-semibold text-amber-400">
                        No instalado
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Extractor de streams de alto rendimiento para YouTube y cientos de plataformas.
                  </p>
                </div>

                <div className="rounded-xl border border-white/10 bg-[#18181C] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Film className="h-4 w-4 text-violet-400" />
                      <span className="text-xs font-bold text-white">FFmpeg</span>
                    </div>
                    {ffmpegReady ? (
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {binaryStatus?.ffmpeg_version || "Listo"}
                      </span>
                    ) : (
                      <span className="text-[11px] font-semibold text-amber-400">
                        No instalado
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Motor de recorte ultra rápido con precisión de fotograma y remuxing en caliente.
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={onCheckUpdates}
                    disabled={checkingUpdates || updatingBinaries}
                    className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-40"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${checkingUpdates ? "animate-spin" : ""}`} />
                    <span>Buscar actualizaciones</span>
                  </button>

                  <button
                    type="button"
                    onClick={onInstallUpdates}
                    disabled={updatingBinaries}
                    className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition shadow-md shadow-indigo-500/25 disabled:opacity-40"
                  >
                    <span>Actualizar / Reinstalar Motores</span>
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
              className="rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15 transition"
            >
              Listo
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
