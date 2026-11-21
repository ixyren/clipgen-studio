import React, { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Scissors,
  Check,
  CheckSquare,
  Square,
  Search,
  Play,
  Trash2,
  Edit2,
  FolderOpen,
  Folder,
  Layers,
  Loader2,
  CheckCircle2,
  Clock,
  HardDrive,
  Download,
  BookmarkPlus,
  Tv,
  ExternalLink,
  FileJson,
  ClipboardPaste,
  Sparkles,
  Sliders,
  Equal,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type {
  SavedClipEntry,
  JobState,
  VideoChapter,
  ManualDownloadOptions,
} from "../types";
import { formatTimecode, formatTimeShort, cleanClipTitle } from "../utils/time";

interface ClipQueuePanelProps {
  clips: SavedClipEntry[];
  currentVideoId: string | null;
  currentVideoUrl: string | null;
  selectedClipIds: Set<string>;
  onToggleSelectClip: (id: string) => void;
  onSelectAll: (select: boolean, clipIds?: string[]) => void;
  onRenameClip: (id: string, newName: string) => void;
  onRemoveClip: (id: string) => void;
  onClearAll: () => void;
  onPreviewClip: (clip: SavedClipEntry) => void;
  onLoadClipVideo: (clip: SavedClipEntry) => void;
  preciseCut: boolean;
  onTogglePreciseCut: (val: boolean) => void;
  mergeClips: boolean;
  onToggleMergeClips: (val: boolean) => void;
  outputDir: string;
  onPickFolder: () => void;
  onOpenFolder: (path: string) => void;
  onExportSelected: () => void;
  activeJob: JobState | null;
  onCancelJob: (jobId: string) => void;
  chapters?: VideoChapter[];
  onAddAllChapters?: () => void;
  marginBefore: number;
  onMarginBeforeChange: (sec: number) => void;
  marginAfter: number;
  onMarginAfterChange: (sec: number) => void;
  onAdjustClipTimes: (id: string, startDelta: number, endDelta: number) => void;
  onMoveClip?: (id: string, direction: "up" | "down") => void;
  onMoveClipToNumber?: (id: string, targetNumber: number) => void;
  filenameFormat: "clean" | "full";
  onFilenameFormatChange: (fmt: "clean" | "full") => void;
  onOpenImportJson: () => void;
  onOpenPasteJson: () => void;
  onCopyAiPrompt: () => void;
  clipStartIndex?: number;
  onClipStartIndexChange?: (val: number) => void;
  qualityPreset?: ManualDownloadOptions["quality_preset"];
  onQualityPresetChange?: (preset: ManualDownloadOptions["quality_preset"]) => void;
}

export const ClipQueuePanel: React.FC<ClipQueuePanelProps> = ({
  clips,
  currentVideoId,
  currentVideoUrl,
  selectedClipIds,
  onToggleSelectClip,
  onSelectAll,
  onRenameClip,
  onRemoveClip,
  onClearAll,
  onPreviewClip,
  onLoadClipVideo,
  preciseCut,
  onTogglePreciseCut,
  mergeClips,
  onToggleMergeClips,
  outputDir,
  onPickFolder,
  onOpenFolder,
  onExportSelected,
  activeJob,
  onCancelJob,
  chapters = [],
  onAddAllChapters,
  marginBefore,
  onMarginBeforeChange,
  marginAfter,
  onMarginAfterChange,
  onAdjustClipTimes,
  onMoveClip,
  onMoveClipToNumber,
  filenameFormat,
  onFilenameFormatChange,
  onOpenImportJson,
  onOpenPasteJson,
  onCopyAiPrompt,
  clipStartIndex = 1,
  onClipStartIndexChange,
  qualityPreset = "best",
  onQualityPresetChange,
}) => {
  const [filterQuery, setFilterQuery] = useState("");
  const [viewScope, setViewScope] = useState<"current" | "all">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState("");
  const [movingNumberId, setMovingNumberId] = useState<string | null>(null);
  const [moveNumberValue, setMoveNumberValue] = useState("");

  const hasLoadedVideo = Boolean(currentVideoId || currentVideoUrl);

  useEffect(() => {
    if (!hasLoadedVideo && viewScope !== "all") {
      setViewScope("all");
    }
  }, [hasLoadedVideo, viewScope]);

  const isCurrentVideoClip = (clip: SavedClipEntry): boolean => {
    if (!hasLoadedVideo) return false;
    if (currentVideoId && clip.video_id) {
      return clip.video_id === currentVideoId;
    }
    return Boolean(currentVideoUrl && clip.video_url === currentVideoUrl);
  };

  const currentVideoClipsCount = useMemo(() => {
    if (!hasLoadedVideo) return 0;
    return clips.filter(isCurrentVideoClip).length;
  }, [clips, hasLoadedVideo, currentVideoId, currentVideoUrl]);

  // Filtered clips by scope and search
  const visibleClips = useMemo(() => {
    let list = clips;
    if (hasLoadedVideo && viewScope === "current") {
      list = list.filter(isCurrentVideoClip);
    }
    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.video_title && c.video_title.toLowerCase().includes(q))
      );
    }
    return list;
  }, [clips, viewScope, hasLoadedVideo, currentVideoId, currentVideoUrl, filterQuery]);

  const commitMoveNumber = (clipId: string) => {
    const parsed = Number.parseInt(moveNumberValue.trim(), 10);
    if (Number.isFinite(parsed) && onMoveClipToNumber) {
      onMoveClipToNumber(clipId, parsed);
    }
    setMovingNumberId(null);
  };

  const selectedClips = useMemo(() => {
    return clips.filter((c) => selectedClipIds.has(c.id));
  }, [clips, selectedClipIds]);

  const allSelected =
    visibleClips.length > 0 &&
    visibleClips.every((c) => selectedClipIds.has(c.id));

  const totalSelectedSeconds = useMemo(() => {
    return selectedClips.reduce(
      (acc, c) => acc + Math.max(0, c.end_time - c.start_time),
      0
    );
  }, [selectedClips]);

  // Rough estimation: ~1.8 MB per second
  const estimatedMb = (totalSelectedSeconds * 1.8).toFixed(0);

  const startEditing = (clip: SavedClipEntry) => {
    setEditingId(clip.id);
    setEditTitleValue(cleanClipTitle(clip.name));
  };

  const commitEditing = (id: string) => {
    if (editTitleValue.trim()) {
      onRenameClip(id, cleanClipTitle(editTitleValue.trim()));
    }
    setEditingId(null);
  };

  const isExporting =
    activeJob &&
    (activeJob.status === "downloading" ||
      activeJob.status === "cutting" ||
      activeJob.status === "merging" ||
      activeJob.status === "queued");

  const isCompleted = activeJob?.status === "completed";

  return (
    <section className="flex h-full w-[30%] flex-col rounded-2xl border border-white/10 bg-[#111114] shadow-2xl overflow-hidden select-none">
      {/* ── 1. Header with Counters & Filters ── */}
      <div className="flex flex-col gap-2.5 border-b border-white/10 bg-[#18181C]/50 p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold tracking-tight text-white">
                Cola de Clips
              </h3>
              <span className="font-mono text-[11px] tabular-nums text-slate-400">
                <span className="font-semibold text-indigo-400">
                  {selectedClips.length}
                </span>{" "}
                seleccionados de {clips.length}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            <button
              type="button"
              onClick={onOpenImportJson}
              title="Importar clips desde archivo JSON"
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white transition"
            >
              <FileJson className="h-3 w-3 text-indigo-400" />
              <span>Importar JSON</span>
            </button>

            <button
              type="button"
              onClick={onOpenPasteJson}
              title="Pegar bloque JSON directamente"
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white transition"
            >
              <ClipboardPaste className="h-3 w-3 text-indigo-400" />
              <span>Pegar JSON</span>
            </button>

            <button
              type="button"
              onClick={onCopyAiPrompt}
              title="Copiar prompt maestro para IA (ChatGPT / Claude / Gemini)"
              className="flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[11px] font-medium text-indigo-300 hover:bg-indigo-500/20 transition"
            >
              <Sparkles className="h-3 w-3 text-indigo-400" />
              <span>Prompt IA</span>
            </button>

            {chapters.length > 0 && onAddAllChapters && (
              <button
                type="button"
                onClick={onAddAllChapters}
                title="Importar capítulos del video como clips"
                className="flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[11px] font-medium text-indigo-300 hover:bg-indigo-500/20 transition"
              >
                <BookmarkPlus className="h-3 w-3" />
                <span>+ Capítulos</span>
              </button>
            )}

            {clips.length > 0 && (
              <button
                type="button"
                onClick={onClearAll}
                title="Limpiar todos los clips guardados"
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-slate-400 hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-400 transition"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* View Scope Tabs / Global Queue Banner */}
        {clips.length > 0 && hasLoadedVideo && (
          <div className="flex rounded-lg bg-[#09090B] p-0.5 border border-white/10 text-[10px]">
            <button
              type="button"
              onClick={() => setViewScope("current")}
              className={`flex-1 rounded py-1 font-semibold transition ${
                viewScope === "current"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Video Actual ({currentVideoClipsCount})
            </button>
            <button
              type="button"
              onClick={() => setViewScope("all")}
              className={`flex-1 rounded py-1 font-semibold transition ${
                viewScope === "all"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Todos en cola ({clips.length})
            </button>
          </div>
        )}

        {clips.length > 0 && !hasLoadedVideo && (
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-[#09090B] px-2.5 py-1 text-[10px]">
            <span className="font-semibold text-slate-300">
              Cola global · Todos los clips
            </span>
            <span className="font-mono font-bold text-indigo-300 tabular-nums">
              {clips.length} en cola
            </span>
          </div>
        )}

        {/* Filter input & Select All toggle */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-500" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Buscar clips..."
              className="h-7 w-full rounded-lg border border-white/10 bg-[#09090B] pl-7 pr-2 text-[11px] text-white placeholder-slate-500 outline-none focus:border-indigo-500/50 transition"
            />
          </div>

          <button
            type="button"
            onClick={() =>
              onSelectAll(
                !allSelected,
                visibleClips.map((c) => c.id)
              )
            }
            disabled={visibleClips.length === 0}
            className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-[11px] font-medium text-slate-300 hover:bg-white/10 transition disabled:opacity-40 shrink-0"
          >
            {allSelected ? (
              <>
                <CheckSquare className="h-3 w-3 text-indigo-400" />
                <span>Ninguno</span>
              </>
            ) : (
              <>
                <Square className="h-3 w-3 text-slate-400" />
                <span>Todos</span>
              </>
            )}
          </button>
        </div>

        {/* Clip Numbering Start / Offset Control */}
        <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#141418] px-2.5 py-1.5 text-[11px]">
          <div className="flex items-center gap-1.5 font-semibold text-slate-200">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-indigo-500/20 text-indigo-400 font-bold font-mono text-[10px]">
              #
            </span>
            <span>Iniciar numeración en:</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                onClipStartIndexChange?.(Math.max(1, clipStartIndex - 1))
              }
              disabled={clipStartIndex <= 1}
              title="Disminuir número inicial"
              className="flex h-5 w-5 items-center justify-center rounded bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-20 transition"
            >
              -
            </button>
            <input
              type="number"
              min={1}
              max={9999}
              value={clipStartIndex}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                onClipStartIndexChange?.(Math.max(1, isNaN(val) ? 1 : val));
              }}
              title="Número con el que empezará la lista, la línea de tiempo y los nombres de archivos exportados"
              className="h-5 w-12 rounded bg-black/60 px-1 text-center font-mono font-bold text-indigo-300 outline-none border border-white/10 focus:border-indigo-500 text-xs shadow-inner"
            />
            <button
              type="button"
              onClick={() =>
                onClipStartIndexChange?.(clipStartIndex + 1)
              }
              title="Aumentar número inicial"
              className="flex h-5 w-5 items-center justify-center rounded bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition"
            >
              +
            </button>
          </div>
        </div>

        {/* Global Security Margin Controls (Padding inicial y final) */}
        <div className="rounded-xl border border-white/10 bg-[#141418] p-2 space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-1.5 font-semibold text-slate-200">
              <Sliders className="h-3.5 w-3.5 text-indigo-400" />
              <span>Margen Global de Seguridad</span>
            </div>
            <button
              type="button"
              onClick={() => onMarginAfterChange(marginBefore)}
              title="Igualar margen final al margen inicial"
              className="flex items-center gap-1 rounded bg-white/[0.04] border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 hover:text-white transition"
            >
              <Equal className="h-3 w-3 text-indigo-400" />
              <span>Igualar</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[10px]">
            {/* Margin Before */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-slate-400">
                <span>Margen Inicial:</span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    value={marginBefore}
                    onChange={(e) => onMarginBeforeChange(Math.max(0, parseInt(e.target.value) || 0))}
                    className="h-4 w-9 rounded bg-black/60 px-1 text-center font-mono font-bold text-indigo-300 outline-none border border-white/10 focus:border-indigo-500"
                  />
                  <span>s</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {[0, 15, 30, 60, 120].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => onMarginBeforeChange(sec)}
                    className={`rounded px-1.5 py-0.5 font-mono text-[9px] transition ${
                      marginBefore === sec
                        ? "bg-indigo-600 text-white font-bold"
                        : "bg-black/40 text-slate-400 hover:text-white border border-white/5"
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>

            {/* Margin After */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-slate-400">
                <span>Margen Final:</span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    value={marginAfter}
                    onChange={(e) => onMarginAfterChange(Math.max(0, parseInt(e.target.value) || 0))}
                    className="h-4 w-9 rounded bg-black/60 px-1 text-center font-mono font-bold text-indigo-300 outline-none border border-white/10 focus:border-indigo-500"
                  />
                  <span>s</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {[0, 15, 30, 60, 120].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => onMarginAfterChange(sec)}
                    className={`rounded px-1.5 py-0.5 font-mono text-[9px] transition ${
                      marginAfter === sec
                        ? "bg-indigo-600 text-white font-bold"
                        : "bg-black/40 text-slate-400 hover:text-white border border-white/5"
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. Animated Clip List (Framer Motion Butter Layout) ── */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
        {clips.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.03] border border-white/10 text-slate-500 mb-3">
              <Scissors className="h-6 w-6 stroke-[1.5]" />
            </div>
            <h4 className="text-xs font-semibold text-slate-300">
              No hay clips en la cola
            </h4>
            <p className="mt-1 text-[11px] text-slate-500 max-w-[200px] leading-relaxed">
              Marca los puntos de inicio <span className="text-indigo-400 font-mono">[ I ]</span> y fin{" "}
              <span className="text-indigo-400 font-mono">[ O ]</span> en el reproductor y pulsa{" "}
              <span className="text-indigo-300 font-medium">+ Añadir a la lista</span>.
            </p>
          </div>
        ) : visibleClips.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center space-y-2">
            {filterQuery.trim() ? (
              <p className="text-xs text-slate-500">
                No hay clips que coincidan con "{filterQuery}"
              </p>
            ) : (
              <>
                <p className="text-xs text-slate-400">
                  Este video aún no tiene clips guardados.
                </p>
                <button
                  type="button"
                  onClick={() => setViewScope("all")}
                  className="rounded-lg border border-indigo-500/30 bg-indigo-500/15 px-3 py-1.5 text-[11px] font-semibold text-indigo-300 hover:bg-indigo-500/25 transition"
                >
                  Ver todos los clips en cola ({clips.length})
                </button>
              </>
            )}
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {visibleClips.map((clip, index) => {
              const isSelected = selectedClipIds.has(clip.id);
              const clipDuration = Math.max(0, clip.end_time - clip.start_time);
              const isEditingThis = editingId === clip.id;
              const matchesCurrent = isCurrentVideoClip(clip);

              const clipIndex = clips.findIndex((c) => c.id === clip.id);
              const currentPos = clipIndex >= 0 ? clipIndex : index;
              const currentNum = currentPos + clipStartIndex;
              const maxNum = clips.length + clipStartIndex - 1;
              const displayNum = String(currentNum).padStart(
                maxNum >= 10 ? 2 : 1,
                "0"
              );

              return (
                <motion.div
                  layout
                  key={clip.id}
                  initial={{ opacity: 0, y: 15, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.92, x: 20 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className={`group relative rounded-xl border p-2.5 transition-all shadow-md ${
                    isSelected
                      ? "border-indigo-500/40 bg-[#18181C] hover:border-indigo-500/60 shadow-indigo-500/5"
                      : "border-white/5 bg-[#141418] opacity-80 hover:opacity-100 hover:border-white/15"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {/* Up / Down Reorder buttons */}
                    <div className="flex flex-col gap-0.5 shrink-0 opacity-40 group-hover:opacity-100 transition mr-0.5">
                      <button
                        type="button"
                        disabled={currentPos <= 0}
                        onClick={() => onMoveClip?.(clip.id, "up")}
                        title="Subir posición en la lista"
                        className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-15 disabled:hover:bg-transparent transition"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        disabled={currentPos >= clips.length - 1}
                        onClick={() => onMoveClip?.(clip.id, "down")}
                        title="Bajar posición en la lista"
                        className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-15 disabled:hover:bg-transparent transition"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </div>

                    {/* Custom Animated Checkbox */}
                    <button
                      type="button"
                      onClick={() => onToggleSelectClip(clip.id)}
                      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition"
                      style={{
                        backgroundColor: isSelected ? "#6366F1" : "transparent",
                        borderColor: isSelected
                          ? "#6366F1"
                          : "rgba(255, 255, 255, 0.2)",
                      }}
                    >
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          exit={{ scale: 0 }}
                        >
                          <Check className="h-3 w-3 stroke-[3] text-white" />
                        </motion.div>
                      )}
                    </button>

                    {/* Clip Body */}
                    <div className="flex flex-1 flex-col min-w-0">
                      {/* Video Title Source Badge (if from another video) */}
                      {!matchesCurrent && (
                        <div className="mb-1 flex items-center justify-between gap-1 text-[10px] text-amber-300/80 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                          <span className="truncate flex-1 font-medium">
                            📹 {clip.video_title || "Otro video"}
                          </span>
                          <button
                            type="button"
                            onClick={() => onLoadClipVideo(clip)}
                            title="Cargar el video de este clip en el visor"
                            className="font-bold text-amber-200 hover:underline shrink-0 flex items-center gap-0.5"
                          >
                            <span>Cargar video</span>
                            <ExternalLink className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      )}

                      {/* Title row with Dynamic Non-Editable Ordinal Badge */}
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          {/* 🌟 AUTOMATIC DYNAMIC ORDINAL NUMBER BADGE (CLICK TO MOVE TO NUMBER) 🌟 */}
                          {movingNumberId === clip.id ? (
                            <input
                              type="number"
                              autoFocus
                              min={clipStartIndex}
                              max={maxNum}
                              value={moveNumberValue}
                              onChange={(e) => setMoveNumberValue(e.target.value)}
                              onBlur={() => commitMoveNumber(clip.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitMoveNumber(clip.id);
                                if (e.key === "Escape") setMovingNumberId(null);
                              }}
                              title={`Mover a posición (${clipStartIndex}..${maxNum})`}
                              className="h-5 w-11 rounded bg-black/80 px-1 text-center font-mono text-[10px] font-bold text-indigo-300 outline-none ring-1 ring-indigo-500 shrink-0"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                if (!onMoveClipToNumber || clips.length <= 1) return;
                                setMovingNumberId(clip.id);
                                setMoveNumberValue(String(currentNum));
                              }}
                              title={
                                onMoveClipToNumber && clips.length > 1
                                  ? `Posición #${currentNum} (clic para mover a otro número y reordenar)`
                                  : `Posición ordinal #${currentNum}`
                              }
                              className={`flex h-5 min-w-[22px] px-1 items-center justify-center rounded bg-indigo-500/20 border border-indigo-500/40 text-[10px] font-mono font-bold text-indigo-300 tabular-nums shrink-0 select-none shadow-sm ${
                                onMoveClipToNumber && clips.length > 1
                                  ? "cursor-pointer hover:bg-indigo-500/35 hover:border-indigo-400 transition"
                                  : "cursor-default"
                              }`}
                            >
                              {displayNum}
                            </button>
                          )}

                          {/* Editable Title: purely descriptive name */}
                          {isEditingThis ? (
                            <input
                              type="text"
                              autoFocus
                              value={editTitleValue}
                              onChange={(e) => setEditTitleValue(e.target.value)}
                              onBlur={() => commitEditing(clip.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitEditing(clip.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              className="h-5 w-full rounded bg-black/60 px-1.5 font-mono text-xs font-semibold text-white outline-none ring-1 ring-indigo-500"
                            />
                          ) : (
                            <span
                              onDoubleClick={() => startEditing(clip)}
                              title="Doble clic para editar nombre del clip"
                              className="truncate text-xs font-semibold text-slate-200 cursor-pointer hover:text-indigo-300 transition block"
                            >
                              {cleanClipTitle(clip.name)}
                            </span>
                          )}
                        </div>

                        {/* Actions Toolbar */}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                          {/* 🌟 Cargar video en visor button 🌟 */}
                          <button
                            type="button"
                            onClick={() => onLoadClipVideo(clip)}
                            title={
                              matchesCurrent
                                ? "Ir a este clip en el visor"
                                : "Cargar el video original de este clip en el visor"
                            }
                            className="flex items-center gap-1 rounded bg-indigo-500/15 border border-indigo-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300 hover:bg-indigo-500/30 transition"
                          >
                            <Tv className="h-3 w-3" />
                            <span>Cargar video</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => startEditing(clip)}
                            title="Editar nombre"
                            className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/10"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                          
                          <button
                            type="button"
                            onClick={() => onPreviewClip(clip)}
                            title="Previsualizar tramo en el visor"
                            className="p-1 text-indigo-400 hover:text-indigo-300 rounded hover:bg-indigo-500/10"
                          >
                            <Play className="h-3 w-3 fill-indigo-400" />
                          </button>

                          <button
                            type="button"
                            onClick={() => onRemoveClip(clip.id)}
                            title="Eliminar clip"
                            className="p-1 text-slate-400 hover:text-rose-400 rounded hover:bg-rose-500/10"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>

                      {/* Fine-Tuning Controls for Start and End */}
                      <div className="mt-1.5 flex flex-col gap-1 rounded-lg border border-white/5 bg-black/30 p-1.5 text-[10px]">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <span className="text-slate-400 font-medium">Inicio:</span>
                            <span className="font-mono tabular-nums text-indigo-300 font-semibold">
                              {formatTimeShort(clip.start_time)}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, -15, 0)}
                              title="Restar 15s al inicio"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              -15s
                            </button>
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, -5, 0)}
                              title="Restar 5s al inicio"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              -5s
                            </button>
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, 5, 0)}
                              title="Sumar 5s al inicio"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              +5s
                            </button>
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, 15, 0)}
                              title="Sumar 15s al inicio"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              +15s
                            </button>
                          </div>
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <span className="text-slate-400 font-medium">Fin:</span>
                            <span className="font-mono tabular-nums text-indigo-300 font-semibold">
                              {formatTimeShort(clip.end_time)}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, 0, -15)}
                              title="Restar 15s al fin"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              -15s
                            </button>
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, 0, -5)}
                              title="Restar 5s al fin"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              -5s
                            </button>
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, 0, 5)}
                              title="Sumar 5s al fin"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              +5s
                            </button>
                            <button
                              type="button"
                              onClick={() => onAdjustClipTimes(clip.id, 0, 15)}
                              title="Sumar 15s al fin"
                              className="rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-slate-400 hover:bg-white/15 hover:text-white transition"
                            >
                              +15s
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Badges row: Base Time & Range with Global Margin Applied */}
                      {(() => {
                        const effStart = Math.max(0, clip.start_time - marginBefore);
                        const effEnd =
                          clip.video_duration > 0
                            ? Math.min(clip.video_duration, clip.end_time + marginAfter)
                            : clip.end_time + marginAfter;
                        const hasMargin = marginBefore > 0 || marginAfter > 0;

                        return (
                          <div className="mt-1.5 flex flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded bg-indigo-950/50 border border-indigo-500/25 px-1.5 py-0.5 font-mono text-[10px] tabular-nums font-medium text-indigo-300">
                                {formatTimecode(clip.start_time)} → {formatTimecode(clip.end_time)}
                              </span>

                              <span className="rounded bg-white/5 border border-white/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-300">
                                Δ {clipDuration.toFixed(1)}s
                              </span>
                            </div>

                            {hasMargin && (
                              <div className="text-[10px] font-mono text-emerald-400/90 bg-emerald-950/30 border border-emerald-500/25 px-1.5 py-0.5 rounded flex items-center gap-1">
                                <span className="font-sans font-medium text-slate-400 text-[9px]">con margen:</span>
                                <span className="tabular-nums font-semibold">
                                  {formatTimecode(effStart)} → {formatTimecode(effEnd)}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Notes Badge if any */}
                      {clip.notes && (
                        <div className="mt-1 text-[10px] text-slate-400 italic bg-white/[0.02] px-1.5 py-0.5 rounded border border-white/5 truncate">
                          💬 {clip.notes}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* ── 3. Fixed Footer with Metrics, Toggles & Export CTA ── */}
      <div className="flex flex-col gap-2.5 border-t border-white/10 bg-[#18181C] p-3.5">
        {/* Metrics summary */}
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3 text-indigo-400" />
            <span>Duración acumulada:</span>
            <span className="font-mono tabular-nums font-semibold text-slate-200">
              {formatTimecode(totalSelectedSeconds)}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <HardDrive className="h-3 w-3 text-slate-500" />
            <span>~{estimatedMb} MB</span>
          </div>
        </div>

        {/* Quick Toggles: Precise Cut & Merge */}
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-white/5 bg-white/[0.02] p-1.5 hover:bg-white/[0.04] transition">
            <input
              type="checkbox"
              checked={preciseCut}
              onChange={(e) => onTogglePreciseCut(e.target.checked)}
              className="accent-indigo-500 h-3.5 w-3.5 rounded"
            />
            <span className="text-slate-300">Corte Preciso</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-white/5 bg-white/[0.02] p-1.5 hover:bg-white/[0.04] transition">
            <input
              type="checkbox"
              checked={mergeClips}
              onChange={(e) => onToggleMergeClips(e.target.checked)}
              className="accent-indigo-500 h-3.5 w-3.5 rounded"
            />
            <span className="text-slate-300">Unir en 1 video</span>
          </label>
        </div>

        {/* Output folder indicator */}
        <div className="flex items-start justify-between gap-2 text-[11px] text-slate-400 rounded-lg border border-white/5 bg-black/40 px-2.5 py-1.5">
          <div className="flex flex-1 min-w-0 items-start gap-1.5" title={outputDir}>
            <Folder className="mt-0.5 h-3 w-3 text-indigo-400 shrink-0" />
            <span className="break-all leading-snug text-slate-300 select-text">
              {outputDir || "Carpeta de descargas"}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
            <button
              type="button"
              onClick={onPickFolder}
              className="text-indigo-400 hover:text-indigo-300 text-[10px] font-medium"
            >
              Cambiar
            </button>
            {outputDir && (
              <button
                type="button"
                onClick={() => onOpenFolder(outputDir)}
                title="Abrir en explorador"
                className="text-slate-400 hover:text-white"
              >
                <FolderOpen className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Export Resolution Selector */}
        <div className="flex items-center justify-between rounded-lg border border-white/5 bg-black/40 px-2 py-1 text-[11px]">
          <span className="text-slate-400 flex items-center gap-1.5 font-medium">
            <Sliders className="h-3 w-3 text-indigo-400 shrink-0" />
            <span>Resolución de exportación:</span>
          </span>
          <select
            value={qualityPreset}
            onChange={(e) =>
              onQualityPresetChange?.(
                e.target.value as ManualDownloadOptions["quality_preset"]
              )
            }
            className="rounded-md bg-[#111114] border border-white/10 px-2 py-0.5 font-semibold text-[11px] text-indigo-300 outline-none focus:border-indigo-500 cursor-pointer shadow-sm"
          >
            <option value="best">Máxima Calidad (Original)</option>
            <option value="2160">4K (2160p)</option>
            <option value="1440">2K (1440p)</option>
            <option value="1080">1080p FHD</option>
            <option value="720">720p HD</option>
            <option value="480">480p SD</option>
            <option value="360">360p</option>
          </select>
        </div>

        {/* Filename Format Selector */}
        <div className="flex items-center justify-between rounded-lg border border-white/5 bg-black/40 px-2 py-1 text-[11px]">
          <span className="text-slate-400">Formato de nombre:</span>
          <div className="flex rounded-md bg-[#111114] p-0.5 border border-white/10 text-[10px]">
            <button
              type="button"
              onClick={() => onFilenameFormatChange("clean")}
              className={`rounded px-2 py-0.5 font-medium transition ${
                filenameFormat === "clean"
                  ? "bg-indigo-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-white"
              }`}
              title="Modo limpio: 01. Nombre del clip.mp4 (sin título del stream)"
            >
              Limpio (01. Clip)
            </button>
            <button
              type="button"
              onClick={() => onFilenameFormatChange("full")}
              className={`rounded px-2 py-0.5 font-medium transition ${
                filenameFormat === "full"
                  ? "bg-indigo-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-white"
              }`}
              title="Modo completo: Stream - 01. Nombre del clip.mp4"
            >
              Con Título Stream
            </button>
          </div>
        </div>

        {/* 🌟 EXPORT BUTTON OR SMOOTH PROCESSING PROGRESS BAR 🌟 */}
        {isExporting ? (
          <div className="space-y-2 rounded-xl border border-indigo-500/40 bg-indigo-950/30 p-2.5 shadow-lg shadow-indigo-500/10">
            <div className="flex items-center justify-between text-xs font-semibold text-indigo-200">
              <div className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                <span className="truncate max-w-[180px]">
                  {activeJob?.current_step || "Procesando corte FFmpeg..."}
                </span>
              </div>
              <span className="font-mono tabular-nums text-indigo-300">
                {activeJob?.percent.toFixed(0)}%
              </span>
            </div>

            {/* Fluid progress bar */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-black/60">
              <motion.div
                className="h-full bg-gradient-to-r from-indigo-500 to-violet-500"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, activeJob?.percent || 0)}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>

            <div className="flex items-center justify-between text-[10px] text-slate-400">
              <span>{activeJob?.speed || "Calculando..."}</span>
              <button
                type="button"
                onClick={() => activeJob && onCancelJob(activeJob.job_id)}
                className="text-rose-400 hover:text-rose-300 font-semibold"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : isCompleted ? (
          <div className="flex flex-col gap-2 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-2.5 text-center shadow-lg shadow-emerald-500/10">
            <div className="flex items-center justify-center gap-1.5 text-xs font-bold text-emerald-300">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>¡Exportación completada!</span>
            </div>
            <button
              type="button"
              onClick={() => {
                const target = activeJob?.output_files[0]
                  ? activeJob.output_files[0].replace(/[/\\][^/\\]+$/, "")
                  : outputDir;
                onOpenFolder(target);
              }}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600/90 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition shadow-md shadow-emerald-500/20"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>Abrir Carpeta de Destino</span>
            </button>
          </div>
        ) : (
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={onExportSelected}
            disabled={selectedClips.length === 0}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 text-xs font-bold text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-violet-500 transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            <span>
              Exportar Seleccionados ({selectedClips.length}/{clips.length})
            </span>
          </motion.button>
        )}
      </div>
    </section>
  );
};
