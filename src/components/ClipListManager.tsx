import React, { useMemo, useState } from "react";
import {
  BookmarkPlus,
  Database,
  Download,
  ExternalLink,
  Film,
  FolderOpen,
  FolderPlus,
  Layers,
  ListVideo,
  Play,
  Scissors,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { SavedClipEntry, VideoChapter } from "../types";
import { formatTimeShort, formatTimecode } from "../utils/time";

export interface SavedVideoGroup {
  videoKey: string;
  videoUrl: string;
  videoTitle: string;
  videoThumbnail: string;
  clips: SavedClipEntry[];
}

interface ClipListManagerProps {
  savedClips: SavedClipEntry[];
  currentVideoId: string | null;
  currentVideoUrl: string | null;
  chapters: VideoChapter[];
  mergeClips: boolean;
  preciseCut: boolean;
  outputDir: string;
  savedClipsFilePath?: string;
  onPickFolder: () => void;
  onOpenFolder: (path: string) => void;
  onToggleMergeClips: (val: boolean) => void;
  onTogglePreciseCut: (val: boolean) => void;
  onRenameClip: (id: string, name: string) => void;
  onRemoveClip: (id: string) => void;
  onRemoveVideoGroup: (videoKey: string) => void;
  onClearCurrentVideoClips: () => void;
  onClearAllSavedClips: () => void;
  onPreviewClip: (clip: SavedClipEntry) => void;
  onDownloadSingleClip: (clip: SavedClipEntry) => void;
  onExportCurrentVideo: () => void;
  onExportVideoGroup: (videoKey: string) => void;
  onExportAllSavedClips: () => void;
  onLoadSavedVideo: (videoUrl: string) => void;
  onAddFromChapter: (chapter: VideoChapter) => void;
  onAddAllChapters: () => void;
}

function entryMatchesActive(
  entry: SavedClipEntry,
  currentVideoId: string | null,
  currentVideoUrl: string | null
): boolean {
  if (!currentVideoId && !currentVideoUrl) return false;
  if (currentVideoId && entry.video_id) {
    return entry.video_id === currentVideoId;
  }
  return Boolean(currentVideoUrl && entry.video_url === currentVideoUrl);
}

function summarizeGroupSettings(sample: SavedClipEntry): string {
  const { options, precise_cut } = sample;
  if (options.mode === "audio_only") {
    return `Audio · ${options.audio_format.toUpperCase()} ${options.audio_bitrate}`;
  }
  const q =
    options.quality_preset === "best"
      ? "Máx"
      : options.quality_preset === "custom"
      ? "Custom"
      : `${options.quality_preset}p`;
  const fps = options.target_fps ? ` · ${options.target_fps} FPS` : "";
  const cut = precise_cut ? " · Preciso" : "";
  return `${q} · ${options.container.toUpperCase()}${fps}${cut}`;
}

export const ClipListManager: React.FC<ClipListManagerProps> = ({
  savedClips,
  currentVideoId,
  currentVideoUrl,
  chapters,
  mergeClips,
  preciseCut,
  outputDir,
  savedClipsFilePath,
  onPickFolder,
  onOpenFolder,
  onToggleMergeClips,
  onTogglePreciseCut,
  onRenameClip,
  onRemoveClip,
  onRemoveVideoGroup,
  onClearCurrentVideoClips,
  onClearAllSavedClips,
  onPreviewClip,
  onDownloadSingleClip,
  onExportCurrentVideo,
  onExportVideoGroup,
  onExportAllSavedClips,
  onLoadSavedVideo,
  onAddFromChapter,
  onAddAllChapters,
}) => {
  const [subTab, setSubTab] = useState<"clips" | "chapters">("clips");

  const hasActiveVideo = Boolean(currentVideoId || currentVideoUrl);

  const { currentClips, otherGroups, allVideoCount } = useMemo(() => {
    const active: SavedClipEntry[] = [];
    const groupsMap = new Map<string, SavedVideoGroup>();
    const allKeys = new Set<string>();

    for (const entry of savedClips) {
      const key = entry.video_id || entry.video_url;
      allKeys.add(key);
      if (entryMatchesActive(entry, currentVideoId, currentVideoUrl)) {
        active.push(entry);
      } else {
        const existing = groupsMap.get(key);
        if (existing) {
          existing.clips.push(entry);
        } else {
          groupsMap.set(key, {
            videoKey: key,
            videoUrl: entry.video_url,
            videoTitle: entry.video_title,
            videoThumbnail: entry.video_thumbnail,
            clips: [entry],
          });
        }
      }
    }

    return {
      currentClips: active,
      otherGroups: Array.from(groupsMap.values()),
      allVideoCount: allKeys.size,
    };
  }, [savedClips, currentVideoId, currentVideoUrl]);

  const totalAllDuration = savedClips.reduce(
    (sum, c) => sum + Math.max(0, c.end_time - c.start_time),
    0
  );
  const currentDuration = currentClips.reduce(
    (sum, c) => sum + Math.max(0, c.end_time - c.start_time),
    0
  );

  return (
    <div className="studio-panel flex h-full flex-col rounded-2xl p-4 sm:p-5 space-y-4">
      {/* Header & Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-[#090A0F] p-1">
          <button
            type="button"
            onClick={() => setSubTab("clips")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              subTab === "clips"
                ? "bg-violet-600/30 text-white"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <Scissors className="h-3.5 w-3.5 text-violet-400" />
            <span>
              Clips ({savedClips.length})
              {allVideoCount > 1 ? ` · ${allVideoCount} vid` : ""}
            </span>
          </button>

          {chapters.length > 0 && (
            <button
              type="button"
              onClick={() => setSubTab("chapters")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                subTab === "chapters"
                  ? "bg-cyan-600/30 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <ListVideo className="h-3.5 w-3.5 text-cyan-400" />
              <span>Capítulos ({chapters.length})</span>
            </button>
          )}
        </div>

        {subTab === "clips" && savedClips.length > 0 && (
          <div className="flex items-center gap-2.5">
            {hasActiveVideo && currentClips.length > 0 && otherGroups.length > 0 && (
              <button
                type="button"
                onClick={onClearCurrentVideoClips}
                className="text-[11px] text-slate-400 hover:text-amber-300 transition"
              >
                Limpiar este video
              </button>
            )}
            <button
              type="button"
              onClick={onClearAllSavedClips}
              className="text-xs text-slate-400 hover:text-rose-400 transition"
            >
              Limpiar todo
            </button>
          </div>
        )}

        {subTab === "chapters" && chapters.length > 0 && (
          <button
            type="button"
            onClick={onAddAllChapters}
            className="flex items-center gap-1 text-xs font-medium text-cyan-300 hover:text-cyan-200"
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            <span>Importar todos</span>
          </button>
        )}
      </div>

      {/* Content Area */}
      <div className="flex-1 space-y-3 overflow-y-auto max-h-[420px] pr-1">
        {subTab === "clips" ? (
          savedClips.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-4 py-10 text-center">
              <Scissors className="mb-2.5 h-8 w-8 text-slate-500" />
              <p className="text-sm font-medium text-slate-300">
                Aún no has agregado clips
              </p>
              <p className="mt-1 max-w-xs text-xs text-slate-500">
                Usa la vista previa y los marcadores Inicio / Fin para guardar clips de uno o varios videos. Se guardan automáticamente entre sesiones.
              </p>
            </div>
          ) : (
            <>
              {/* Active video clips */}
              {hasActiveVideo && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-0.5 text-[11px] font-semibold uppercase tracking-wider text-violet-300/90">
                    <span>Video actual ({currentClips.length})</span>
                    {currentClips.length > 0 && (
                      <span className="font-mono text-cyan-300">
                        {currentDuration.toFixed(1)}s
                      </span>
                    )}
                  </div>

                  {currentClips.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-3 py-4 text-center text-xs text-slate-400">
                      Añade clips de este video en el reproductor; los de otros videos seguirán guardados abajo.
                    </div>
                  ) : (
                    currentClips.map((clip, idx) => {
                      const segDur = Math.max(0, clip.end_time - clip.start_time);
                      return (
                        <div
                          key={clip.id}
                          className="group rounded-xl border border-white/10 bg-[#090A0F]/80 p-3 transition hover:border-violet-500/40"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-500/20 text-[10px] font-bold text-violet-300">
                                {idx + 1}
                              </span>
                              <input
                                type="text"
                                value={clip.name}
                                onChange={(e) => onRenameClip(clip.id, e.target.value)}
                                className="w-full truncate rounded bg-transparent px-1 py-0.5 text-xs font-semibold text-white outline-none focus:bg-white/5 focus:ring-1 focus:ring-violet-500/50"
                              />
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => onPreviewClip(clip)}
                                title="Previsualizar este clip en el reproductor"
                                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-violet-500/20 hover:text-violet-300"
                              >
                                <Play className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => onDownloadSingleClip(clip)}
                                title="Descargar solo este clip"
                                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-cyan-500/20 hover:text-cyan-300"
                              >
                                <Download className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => onRemoveClip(clip.id)}
                                title="Eliminar clip"
                                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-slate-400">
                            <span>
                              {formatTimecode(clip.start_time)} → {formatTimecode(clip.end_time)}
                            </span>
                            <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-cyan-300">
                              {segDur.toFixed(1)}s
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* Saved clips from other / previous videos */}
              {otherGroups.length > 0 && (
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between px-0.5 text-[11px] font-semibold uppercase tracking-wider text-cyan-300/90">
                    <span className="flex items-center gap-1.5">
                      <Film className="h-3.5 w-3.5" />
                      <span>
                        {hasActiveVideo
                          ? `Otros videos guardados (${otherGroups.length})`
                          : `Videos guardados (${otherGroups.length})`}
                      </span>
                    </span>
                  </div>

                  {otherGroups.map((group) => (
                    <div
                      key={group.videoKey}
                      className="rounded-xl border border-cyan-500/20 bg-[#090A0F]/80 p-3 space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {group.videoThumbnail ? (
                            <img
                              src={group.videoThumbnail}
                              alt=""
                              className="h-9 w-16 shrink-0 rounded-md object-cover border border-white/10"
                            />
                          ) : null}
                          <div className="min-w-0">
                            <p
                              title={group.videoTitle}
                              className="truncate text-xs font-semibold text-white"
                            >
                              {group.videoTitle}
                            </p>
                            <p className="mt-0.5 truncate text-[10px] text-cyan-300/90">
                              {group.clips.length} clip{group.clips.length > 1 ? "s" : ""} ·{" "}
                              {summarizeGroupSettings(group.clips[0])}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => onLoadSavedVideo(group.videoUrl)}
                            title="Cargar este video en el reproductor"
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-violet-500/20 hover:text-violet-300"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onExportVideoGroup(group.videoKey)}
                            title="Exportar clips de este video"
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-cyan-500/20 hover:text-cyan-300"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemoveVideoGroup(group.videoKey)}
                            title="Eliminar todos los clips de este video"
                            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1.5 border-t border-white/5 pt-2">
                        {group.clips.map((clip, cIdx) => {
                          const segDur = Math.max(0, clip.end_time - clip.start_time);
                          return (
                            <div
                              key={clip.id}
                              className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.025] px-2 py-1.5 text-[11px]"
                            >
                              <div className="min-w-0 flex-1">
                                <input
                                  type="text"
                                  value={clip.name}
                                  onChange={(e) => onRenameClip(clip.id, e.target.value)}
                                  className="w-full truncate rounded bg-transparent px-1 text-[11px] font-medium text-slate-200 outline-none focus:bg-white/5"
                                />
                                <div className="px-1 font-mono text-[10px] text-slate-400">
                                  #{cIdx + 1} · {formatTimecode(clip.start_time)} →{" "}
                                  {formatTimecode(clip.end_time)} ({segDur.toFixed(1)}s)
                                </div>
                              </div>
                              <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => onDownloadSingleClip(clip)}
                                  title="Descargar solo este clip"
                                  className="rounded p-1 text-slate-400 hover:bg-cyan-500/20 hover:text-cyan-300"
                                >
                                  <Download className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onRemoveClip(clip.id)}
                                  title="Quitar clip"
                                  className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-400"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        ) : (
          chapters.map((ch, idx) => (
            <div
              key={`chap-${idx}`}
              className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#090A0F]/80 p-3 hover:border-cyan-500/40"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-white">
                  {ch.title}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                  {formatTimeShort(ch.start_time)} → {formatTimeShort(ch.end_time)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onAddFromChapter(ch)}
                className="shrink-0 rounded-lg border border-cyan-500/30 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25"
              >
                + Añadir
              </button>
            </div>
          ))
        )}
      </div>

      {/* Export Controls */}
      <div className="space-y-3 border-t border-white/10 pt-3.5">
        {hasActiveVideo && (
          <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                <span>Corte Preciso al Fotograma</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Recodifica bordes con FFmpeg para exactitud al milisegundo
              </p>
            </div>
            <input
              type="checkbox"
              checked={preciseCut}
              onChange={(e) => onTogglePreciseCut(e.target.checked)}
              className="mt-1 h-4 w-4 accent-violet-500"
            />
          </label>
        )}

        {hasActiveVideo && currentClips.length > 1 && (
          <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-2.5">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                <Layers className="h-3.5 w-3.5 text-cyan-400" />
                <span>Unir clips de este video en un solo archivo</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Combina los {currentClips.length} clips en un Highlight Reel con FFmpeg
              </p>
            </div>
            <input
              type="checkbox"
              checked={mergeClips}
              onChange={(e) => onToggleMergeClips(e.target.checked)}
              className="mt-1 h-4 w-4 accent-cyan-500"
            />
          </label>
        )}

        <div className="rounded-xl border border-white/10 bg-[#090A0F]/80 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-slate-400">
              Guardar clips en:
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onPickFolder}
                className="flex items-center gap-1 rounded-md border border-violet-500/35 bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-200 hover:bg-violet-500/25"
              >
                <FolderPlus className="h-3 w-3" />
                <span>Cambiar...</span>
              </button>
              <button
                type="button"
                onClick={() => onOpenFolder(outputDir)}
                className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:bg-white/[0.1]"
              >
                <FolderOpen className="h-3 w-3 text-cyan-400" />
                <span>Abrir</span>
              </button>
            </div>
          </div>
          <p
            title={outputDir}
            className="truncate font-mono text-[11px] text-cyan-200/90"
          >
            {outputDir || "Carpeta predeterminada..."}
          </p>
          {savedClipsFilePath && (
            <div
              title={savedClipsFilePath}
              className="flex items-center gap-1.5 pt-0.5 text-[10px] text-slate-500"
            >
              <Database className="h-3 w-3 shrink-0 text-emerald-400/80" />
              <span className="truncate">
                Persistencia JSON: {savedClipsFilePath}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {hasActiveVideo && currentClips.length > 0 && otherGroups.length > 0 && (
            <button
              type="button"
              onClick={onExportCurrentVideo}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-violet-500/40 bg-violet-600/20 py-2 text-xs font-semibold text-violet-100 transition hover:bg-violet-600/30"
            >
              <Download className="h-3.5 w-3.5" />
              <span>
                {mergeClips && currentClips.length > 1
                  ? `Solo este video: Unir ${currentClips.length} Clips (${currentDuration.toFixed(1)}s)`
                  : `Solo este video: ${currentClips.length} Clip${currentClips.length > 1 ? "s" : ""} (${currentDuration.toFixed(1)}s)`}
              </span>
            </button>
          )}

          <button
            type="button"
            disabled={savedClips.length === 0}
            onClick={
              otherGroups.length === 0 && hasActiveVideo
                ? onExportCurrentVideo
                : onExportAllSavedClips
            }
            className="studio-gradient-btn flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            <span>
              {savedClips.length === 0
                ? "Añade clips para exportar"
                : allVideoCount > 1
                ? `Exportar Todos los Clips (${savedClips.length} clips · ${allVideoCount} videos)`
                : mergeClips && currentClips.length > 1 && hasActiveVideo
                ? `Exportar y Unir ${savedClips.length} Clips (${totalAllDuration.toFixed(1)}s)`
                : `Exportar ${savedClips.length} Clip${savedClips.length > 1 ? "s" : ""} (${totalAllDuration.toFixed(1)}s)`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
