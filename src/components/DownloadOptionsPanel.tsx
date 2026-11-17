import React, { useState } from "react";
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Download,
  Film,
  FolderOpen,
  FolderPlus,
  Settings2,
  Sliders,
  VideoOff,
} from "lucide-react";
import type { ManualDownloadOptions, VideoMetadata } from "../types";
import { formatBytes } from "../utils/time";

interface DownloadOptionsPanelProps {
  metadata: VideoMetadata | null;
  options: ManualDownloadOptions;
  onChange: (next: ManualDownloadOptions) => void;
  onOpenFolder: (path: string) => void;
  onPickFolder: () => void;
  onStartFullDownload?: () => void;
  showFullDownloadButton?: boolean;
  compact?: boolean;
}

const QUALITY_PRESETS: Array<{ value: ManualDownloadOptions["quality_preset"]; label: string }> = [
  { value: "best", label: "Mejor Auto" },
  { value: "2160", label: "4K (2160p)" },
  { value: "1440", label: "2K (1440p)" },
  { value: "1080", label: "1080p FHD" },
  { value: "720", label: "720p HD" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
  { value: "custom", label: "Manual (Format ID)" },
];

const FPS_PRESETS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Original (Auto)" },
  { value: 60, label: "60 FPS" },
  { value: 50, label: "50 FPS" },
  { value: 48, label: "48 FPS" },
  { value: 30, label: "30 FPS" },
  { value: 25, label: "25 FPS" },
  { value: 24, label: "24 FPS (Cine)" },
  { value: 15, label: "15 FPS" },
];

export const DownloadOptionsPanel: React.FC<DownloadOptionsPanelProps> = ({
  metadata,
  options,
  onChange,
  onOpenFolder,
  onPickFolder,
  onStartFullDownload,
  showFullDownloadButton = false,
  compact = false,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(!compact);

  const update = <K extends keyof ManualDownloadOptions>(
    key: K,
    val: ManualDownloadOptions[K]
  ) => {
    onChange({ ...options, [key]: val });
  };

  const handleAudioTrackSelect = (trackId: string) => {
    const track = metadata?.audio_tracks.find((t) => t.track_id === trackId);
    onChange({
      ...options,
      audio_track_id: track?.track_id ?? (trackId || null),
      audio_format_id: track?.format_id ?? null,
    });
  };

  const videoFormats = metadata?.formats.filter((f) => f.has_video) ?? [];
  const audioFormats = metadata?.formats.filter((f) => f.has_audio && !f.has_video) ?? [];
  const audioTracks = metadata?.audio_tracks ?? [];

  return (
    <div className="studio-panel rounded-2xl p-4 sm:p-5 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300">
            <Sliders className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">
              Opciones Manuales de Descarga y Formato
            </h3>
            <p className="text-xs text-slate-400">
              Configura resolución, códec exacto, formato y metadatos
            </p>
          </div>
        </div>

        {compact && (
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/[0.08]"
          >
            <span>{showAdvanced ? "Ocultar detalles" : "Configurar calidad"}</span>
            {showAdvanced ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Download Mode Selector */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => update("mode", "video_audio")}
          className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-xs transition ${
            options.mode === "video_audio"
              ? "border-violet-500/60 bg-violet-500/15 text-white"
              : "border-white/10 bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200"
          }`}
        >
          <Film className="h-4 w-4 text-violet-400 shrink-0" />
          <div>
            <div className="font-semibold">Video + Audio</div>
            <div className="text-[11px] opacity-75">Combinación completa</div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => update("mode", "audio_only")}
          className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-xs transition ${
            options.mode === "audio_only"
              ? "border-cyan-500/60 bg-cyan-500/15 text-white"
              : "border-white/10 bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200"
          }`}
        >
          <AudioLines className="h-4 w-4 text-cyan-400 shrink-0" />
          <div>
            <div className="font-semibold">Solo Audio</div>
            <div className="text-[11px] opacity-75">MP3, WAV, FLAC, M4A</div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => update("mode", "video_only")}
          className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-xs transition ${
            options.mode === "video_only"
              ? "border-indigo-500/60 bg-indigo-500/15 text-white"
              : "border-white/10 bg-white/[0.02] text-slate-400 hover:border-white/20 hover:text-slate-200"
          }`}
        >
          <VideoOff className="h-4 w-4 text-indigo-400 shrink-0" />
          <div>
            <div className="font-semibold">Solo Video</div>
            <div className="text-[11px] opacity-75">Sin pista de audio</div>
          </div>
        </button>
      </div>

      {/* Always-visible Audio Track / Language & Destination Folder */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {options.mode !== "video_only" && audioTracks.length > 0 && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-medium text-cyan-200">
              <AudioLines className="h-3.5 w-3.5 text-cyan-400" />
              <span>Pista de Audio / Idioma (YouTube)</span>
            </label>
            <select
              value={options.audio_track_id ?? audioTracks[0]?.track_id ?? ""}
              onChange={(e) => handleAudioTrackSelect(e.target.value)}
              className="w-full rounded-xl border border-cyan-500/30 bg-[#090A0F] px-3 py-2 text-xs text-white outline-none focus:border-cyan-400"
            >
              {audioTracks.map((track) => (
                <option key={track.track_id} value={track.track_id}>
                  {track.label} • [{track.format_id}] {track.ext.toUpperCase()}
                  {track.tbr ? ` (${Math.round(track.tbr)}kbps)` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div
          className={`space-y-1.5 ${
            options.mode === "video_only" || audioTracks.length === 0
              ? "lg:col-span-2"
              : ""
          }`}
        >
          <label className="block text-xs font-medium text-slate-300">
            Carpeta de Descargas
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={options.output_dir}
              onChange={(e) => update("output_dir", e.target.value)}
              className="min-w-[180px] flex-1 rounded-xl border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-slate-200 outline-none focus:border-violet-500"
            />
            <button
              type="button"
              onClick={onPickFolder}
              className="flex items-center gap-1.5 rounded-xl border border-violet-500/35 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-200 transition hover:bg-violet-500/25"
            >
              <FolderPlus className="h-4 w-4 text-violet-300" />
              <span>Elegir carpeta...</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenFolder(options.output_dir)}
              className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-slate-200 transition hover:bg-white/[0.1]"
            >
              <FolderOpen className="h-4 w-4 text-cyan-400" />
              <span>Abrir carpeta</span>
            </button>
          </div>
        </div>
      </div>

      {/* Video FPS Selector (always visible when video is included) */}
      {options.mode !== "audio_only" && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-medium text-slate-300">
              FPS del Video (Fotogramas por segundo)
            </label>
            <span className="text-[11px] text-slate-400">
              {options.target_fps
                ? `Conversión exacta a ${options.target_fps} FPS si el stream difiere`
                : "Conserva los FPS nativos del video original"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FPS_PRESETS.map((preset) => (
              <button
                key={preset.value ?? "auto"}
                type="button"
                onClick={() => update("target_fps", preset.value)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                  options.target_fps === preset.value
                    ? "border-violet-400/60 bg-violet-500/20 text-violet-200"
                    : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-white"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {showAdvanced && (
        <div className="space-y-5">
          {/* Quality / Resolution */}
          {options.mode !== "audio_only" && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-300">
                Calidad / Resolución
              </label>
              <div className="flex flex-wrap gap-1.5">
                {QUALITY_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => update("quality_preset", preset.value)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      options.quality_preset === preset.value
                        ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-200"
                        : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-white"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Custom format_id manual selectors */}
          {options.mode !== "audio_only" && options.quality_preset === "custom" && (
            <div className="grid grid-cols-1 gap-4 rounded-xl border border-violet-500/25 bg-violet-500/[0.04] p-3.5 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-violet-200">
                  Stream de Video (format_id)
                </label>
                <select
                  value={options.custom_video_format_id ?? ""}
                  onChange={(e) =>
                    update("custom_video_format_id", e.target.value || null)
                  }
                  className="w-full rounded-lg border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-slate-200 outline-none focus:border-violet-500"
                >
                  <option value="">Automático (mejor video)</option>
                  {videoFormats.map((f) => (
                    <option key={f.format_id} value={f.format_id}>
                      [{f.format_id}] {f.resolution} {f.fps ? `${f.fps}fps` : ""} •{" "}
                      {f.ext.toUpperCase()} • {f.vcodec.split(".")[0]} •{" "}
                      {f.tbr ? `${Math.round(f.tbr)}kbps` : ""} ({formatBytes(f.filesize)})
                      {f.has_audio ? " [Video+Audio]" : ""}
                    </option>
                  ))}
                </select>
              </div>

              {options.mode === "video_audio" && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-cyan-200">
                    Stream de Audio (format_id)
                  </label>
                  <select
                    value={options.custom_audio_format_id ?? ""}
                    onChange={(e) =>
                      update("custom_audio_format_id", e.target.value || null)
                    }
                    className="w-full rounded-lg border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-slate-200 outline-none focus:border-cyan-500"
                  >
                    <option value="">Automático (mejor audio)</option>
                    {audioFormats.map((f) => (
                      <option key={f.format_id} value={f.format_id}>
                        [{f.format_id}] {f.ext.toUpperCase()} • {f.acodec} •{" "}
                        {f.tbr ? `${Math.round(f.tbr)}kbps` : ""} ({formatBytes(f.filesize)})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Container / Audio format settings */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {options.mode !== "audio_only" ? (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Formato Contenedor
                </label>
                <select
                  value={options.container}
                  onChange={(e) =>
                    update(
                      "container",
                      e.target.value as ManualDownloadOptions["container"]
                    )
                  }
                  className="w-full rounded-xl border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-white outline-none focus:border-violet-500"
                >
                  <option value="mp4">MP4 (Universal)</option>
                  <option value="mkv">MKV (Matroska)</option>
                  <option value="webm">WebM</option>
                  <option value="mov">MOV (QuickTime)</option>
                </select>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    Formato de Audio
                  </label>
                  <select
                    value={options.audio_format}
                    onChange={(e) =>
                      update(
                        "audio_format",
                        e.target.value as ManualDownloadOptions["audio_format"]
                      )
                    }
                    className="w-full rounded-xl border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-white outline-none focus:border-cyan-500"
                  >
                    <option value="mp3">MP3</option>
                    <option value="m4a">M4A (AAC)</option>
                    <option value="wav">WAV (Sin pérdida)</option>
                    <option value="flac">FLAC (Lossless)</option>
                    <option value="opus">OPUS</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    Calidad de Audio
                  </label>
                  <select
                    value={options.audio_bitrate}
                    onChange={(e) =>
                      update(
                        "audio_bitrate",
                        e.target.value as ManualDownloadOptions["audio_bitrate"]
                      )
                    }
                    className="w-full rounded-xl border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-white outline-none focus:border-cyan-500"
                  >
                    <option value="320K">320 kbps (Máxima)</option>
                    <option value="192K">192 kbps (Estándar)</option>
                    <option value="128K">128 kbps (Compacto)</option>
                  </select>
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Límite de Velocidad (opcional)
              </label>
              <input
                type="text"
                value={options.rate_limit ?? ""}
                onChange={(e) => update("rate_limit", e.target.value || null)}
                placeholder="Ej: 10M o 500K"
                className="w-full rounded-xl border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-violet-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Args personalizados yt-dlp
              </label>
              <input
                type="text"
                value={options.custom_args ?? ""}
                onChange={(e) => update("custom_args", e.target.value || null)}
                placeholder="Ej: --cookies-from-browser chrome"
                className="w-full rounded-xl border border-white/10 bg-[#090A0F] px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-violet-500"
              />
            </div>
          </div>

          {/* Toggles: subtitles, thumbnail, metadata */}
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            {options.mode !== "audio_only" && (
              <div className="flex items-center gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    checked={options.embed_subtitles}
                    onChange={(e) => update("embed_subtitles", e.target.checked)}
                    className="h-4 w-4 rounded border-white/20 bg-[#090A0F] accent-violet-500"
                  />
                  <span>Incrustar Subtítulos</span>
                </label>
                {options.embed_subtitles && (
                  <input
                    type="text"
                    value={options.subtitle_lang}
                    onChange={(e) => update("subtitle_lang", e.target.value)}
                    placeholder="es,en"
                    title={
                      metadata?.subtitles.length
                        ? `Disponibles: ${metadata.subtitles.slice(0, 12).join(", ")}`
                        : "Idiomas separados por coma"
                    }
                    className="w-24 rounded-lg border border-white/10 bg-[#090A0F] px-2 py-1 text-xs text-white outline-none focus:border-violet-500"
                  />
                )}
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                checked={options.embed_thumbnail}
                onChange={(e) => update("embed_thumbnail", e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-[#090A0F] accent-violet-500"
              />
              <span>Incrustar Miniatura</span>
            </label>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                checked={options.embed_metadata}
                onChange={(e) => update("embed_metadata", e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-[#090A0F] accent-violet-500"
              />
              <span>Incrustar Metadatos y Capítulos</span>
            </label>
          </div>

          {/* Full format table preview in full download mode */}
          {!compact && metadata && metadata.formats.length > 0 && (
            <details className="rounded-xl border border-white/10 bg-[#090A0F]/60 p-3">
              <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-300 hover:text-white">
                <Settings2 className="h-3.5 w-3.5 text-violet-400" />
                <span>
                  Ver todos los streams detectados ({metadata.formats.length} formatos)
                </span>
              </summary>
              <div className="mt-3 max-h-56 overflow-y-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-[#0D101A] text-slate-400">
                    <tr>
                      <th className="px-2 py-1.5">ID</th>
                      <th className="px-2 py-1.5">Tipo</th>
                      <th className="px-2 py-1.5">Resolución</th>
                      <th className="px-2 py-1.5">FPS</th>
                      <th className="px-2 py-1.5">Ext</th>
                      <th className="px-2 py-1.5">Códec</th>
                      <th className="px-2 py-1.5">Bitrate</th>
                      <th className="px-2 py-1.5">Tamaño</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-slate-300">
                    {metadata.formats.map((f) => (
                      <tr key={f.format_id} className="hover:bg-white/[0.03]">
                        <td className="px-2 py-1 font-mono text-cyan-300">{f.format_id}</td>
                        <td className="px-2 py-1">
                          {f.has_video && f.has_audio
                            ? "Video+Audio"
                            : f.has_video
                            ? "Video"
                            : "Audio"}
                        </td>
                        <td className="px-2 py-1">{f.resolution}</td>
                        <td className="px-2 py-1">{f.fps ?? "—"}</td>
                        <td className="px-2 py-1 uppercase">{f.ext}</td>
                        <td className="px-2 py-1 font-mono truncate max-w-[140px]">
                          {f.has_video ? f.vcodec : f.acodec}
                        </td>
                        <td className="px-2 py-1">
                          {f.tbr ? `${Math.round(f.tbr)} kbps` : "—"}
                        </td>
                        <td className="px-2 py-1">{formatBytes(f.filesize)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {showFullDownloadButton && onStartFullDownload && (
        <button
          type="button"
          onClick={onStartFullDownload}
          className="studio-gradient-btn flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-white"
        >
          <Download className="h-4 w-4" />
          <span>Iniciar Descarga Completa</span>
        </button>
      )}
    </div>
  );
};
