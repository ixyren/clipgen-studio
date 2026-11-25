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
  ExternalLink,
  FileJson,
  ClipboardPaste,
  Sliders,
  Equal,
  ChevronUp,
  ChevronDown,
  X,
  AlertCircle,
} from "lucide-react";
import type {
  SavedClipEntry,
  JobState,
  VideoChapter,
  ManualDownloadOptions,
} from "../types";
import { formatTimecode, formatTimeShort, cleanClipTitle } from "../utils/time";
import { Tooltip } from "./Tooltip";

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
  onDismissJob?: (jobId?: string) => void;
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
  onDismissJob,
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
  const [showBatchOptions, setShowBatchOptions] = useState(false);
  const [expandedAdjustId, setExpandedAdjustId] = useState<string | null>(null);

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
  const isError = activeJob?.status === "error";
  const isCancelled = activeJob?.status === "cancelled";

  return (
    <section className="flex h-full w-[30%] flex-col rounded-2xl border border-white/10 bg-[#111114] shadow-2xl overflow-hidden select-none">
      {/* ── 1. Compact Header with Counters, Filter & Collapsible Batch Accordion ── */}
      <div className="flex flex-col gap-2 border-b border-white/10 bg-[#18181C]/50 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400 shrink-0">
              <Layers className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs font-bold tracking-tight text-white">
                  Cola
                </h3>
                <span className="rounded bg-indigo-500/15 border border-indigo-500/25 px-1.5 py-0.2 font-mono text-[10px] font-bold tabular-nums text-indigo-300">
                  {selectedClips.length}/{clips.length}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Tooltip content="Pegar bloque JSON directamente desde el portapapeles">
              <button
                type="button"
                onClick={onOpenPasteJson}
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white smooth-btn"
              >
                <ClipboardPaste className="h-3 w-3 text-indigo-400" />
                <span>Pegar JSON</span>
              </button>
            </Tooltip>

            <Tooltip content="Importar archivo .json o pegar manualmente para editar">
              <button
                type="button"
                onClick={onOpenImportJson}
                className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-[11px] font-medium text-slate-300 hover:bg-white/10 hover:text-white smooth-btn"
              >
                <FileJson className="h-3 w-3 text-indigo-400" />
                <span>JSON</span>
              </button>
            </Tooltip>

            {chapters.length > 0 && onAddAllChapters && (
              <Tooltip content="Importar todos los capítulos detectados del video como clips">
                <button
                  type="button"
                  onClick={onAddAllChapters}
                  className="flex h-7 items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2 text-[11px] font-medium text-indigo-300 hover:bg-indigo-500/20 smooth-btn"
                >
                  <BookmarkPlus className="h-3 w-3" />
                  <span>Capítulos</span>
                </button>
              </Tooltip>
            )}

            {clips.length > 0 && (
              <Tooltip content="Vaciar todos los clips guardados">
                <button
                  type="button"
                  onClick={onClearAll}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-slate-400 hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-400 smooth-btn"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        {/* View Scope Tabs (only shown when a video is loaded) */}
        {clips.length > 0 && hasLoadedVideo && (
          <div className="flex rounded-lg bg-[#09090B] p-0.5 border border-white/10 text-[10px]">
            <button
              type="button"
              onClick={() => setViewScope("current")}
              className={`flex-1 rounded py-1 font-semibold smooth-btn ${
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
              className={`flex-1 rounded py-1 font-semibold smooth-btn ${
                viewScope === "all"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Todos en cola ({clips.length})
            </button>
          </div>
        )}

        {/* Filter input & Select All toggle */}
        <div className="flex items-center gap-1.5">
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

          <Tooltip content={allSelected ? "Deseleccionar clips visibles" : "Seleccionar clips visibles"}>
            <button
              type="button"
              onClick={() =>
                onSelectAll(
                  !allSelected,
                  visibleClips.map((c) => c.id)
                )
              }
              disabled={visibleClips.length === 0}
              className="flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-[11px] font-medium text-slate-300 hover:bg-white/10 smooth-btn disabled:opacity-40 shrink-0"
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
          </Tooltip>
        </div>

        {/* Collapsible Batch Options Accordion: Start Index # + Safety Margins */}
        <div className="rounded-xl border border-white/10 bg-[#141418] overflow-hidden">
          <Tooltip
            className="flex w-full"
            content="Configurar número inicial de la secuencia (#) y márgenes de seguridad extra antes/después de cada clip"
          >
            <button
              type="button"
              onClick={() => setShowBatchOptions((v) => !v)}
              className="flex w-full items-center justify-between px-2.5 py-1.5 text-[11px] hover:bg-white/[0.03] smooth-btn"
            >
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <Sliders className="h-3 w-3 text-indigo-400" />
                <span>Lote y Márgenes</span>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400">
                <span className="rounded bg-indigo-500/15 px-1.5 py-0.2 text-indigo-300 font-bold">
                  #{clipStartIndex}
                </span>
                <span className="rounded bg-black/50 border border-white/10 px-1.5 py-0.2 tabular-nums">
                  -{marginBefore}s / +{marginAfter}s
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${
                    showBatchOptions ? "rotate-180" : ""
                  }`}
                />
              </div>
            </button>
          </Tooltip>

          <AnimatePresence initial={false}>
            {showBatchOptions && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="overflow-hidden border-t border-white/10"
              >
                <div className="p-2.5 space-y-2.5 bg-black/20">
                  {/* Clip Numbering Start / Offset Control */}
                  <div className="flex items-center justify-between text-[11px]">
                    <Tooltip content="Número desde el cual comienza la lista, el timeline y el nombre de archivo exportado">
                      <span className="flex items-center gap-1.5 font-medium text-slate-300 cursor-help">
                        <span className="flex h-4 w-4 items-center justify-center rounded bg-indigo-500/20 text-indigo-400 font-bold font-mono text-[10px]">
                          #
                        </span>
                        <span>Iniciar numeración en</span>
                      </span>
                    </Tooltip>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          onClipStartIndexChange?.(Math.max(1, clipStartIndex - 1))
                        }
                        disabled={clipStartIndex <= 1}
                        className="flex h-5 w-5 items-center justify-center rounded bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-20 smooth-btn"
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
                        className="h-5 w-12 rounded bg-black/60 px-1 text-center font-mono font-bold text-indigo-300 outline-none border border-white/10 focus:border-indigo-500 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          onClipStartIndexChange?.(clipStartIndex + 1)
                        }
                        className="flex h-5 w-5 items-center justify-center rounded bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 smooth-btn"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {/* Safety Margins */}
                  <div className="space-y-1.5 pt-1 border-t border-white/5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-medium text-slate-300">
                        Margen de seguridad al exportar
                      </span>
                      <Tooltip content="Igualar el margen final al valor del margen inicial">
                        <button
                          type="button"
                          onClick={() => onMarginAfterChange(marginBefore)}
                          className="flex items-center gap-1 rounded bg-white/[0.04] border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 hover:text-white smooth-btn"
                        >
                          <Equal className="h-2.5 w-2.5 text-indigo-400" />
                          <span>Igualar</span>
                        </button>
                      </Tooltip>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-slate-400">
                          <span>Antes:</span>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              value={marginBefore}
                              onChange={(e) =>
                                onMarginBeforeChange(Math.max(0, parseInt(e.target.value) || 0))
                              }
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
                              className={`rounded px-1.5 py-0.5 font-mono text-[9px] smooth-btn ${
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

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-slate-400">
                          <span>Después:</span>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              value={marginAfter}
                              onChange={(e) =>
                                onMarginAfterChange(Math.max(0, parseInt(e.target.value) || 0))
                              }
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
                              className={`rounded px-1.5 py-0.5 font-mono text-[9px] smooth-btn ${
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
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── 2. Clean Animated Clip List ── */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 custom-scrollbar">
        {clips.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/[0.03] border border-white/10 text-slate-500 mb-3">
              <Scissors className="h-5 w-5 stroke-[1.5]" />
            </div>
            <h4 className="text-xs font-semibold text-slate-300">
              Cola vacía
            </h4>
            <p className="mt-1 text-[11px] text-slate-500 max-w-[190px] leading-relaxed">
              Marca <span className="text-indigo-400 font-mono">I</span> y{" "}
              <span className="text-indigo-400 font-mono">O</span> en el visor y pulsa{" "}
              <span className="text-indigo-300 font-medium">Añadir</span>.
            </p>
          </div>
        ) : visibleClips.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center space-y-2">
            {filterQuery.trim() ? (
              <p className="text-xs text-slate-500">
                Sin coincidencias para "{filterQuery}"
              </p>
            ) : (
              <>
                <p className="text-xs text-slate-400">
                  Este video aún no tiene clips guardados.
                </p>
                <button
                  type="button"
                  onClick={() => setViewScope("all")}
                  className="rounded-lg border border-indigo-500/30 bg-indigo-500/15 px-3 py-1.5 text-[11px] font-semibold text-indigo-300 hover:bg-indigo-500/25 smooth-btn"
                >
                  Ver todos en cola ({clips.length})
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
              const isAdjustExpanded = expandedAdjustId === clip.id;
              const matchesCurrent = isCurrentVideoClip(clip);

              const clipIndex = clips.findIndex((c) => c.id === clip.id);
              const currentPos = clipIndex >= 0 ? clipIndex : index;
              const currentNum = currentPos + clipStartIndex;
              const maxNum = clips.length + clipStartIndex - 1;
              const displayNum = String(currentNum).padStart(
                maxNum >= 10 ? 2 : 1,
                "0"
              );

              const effStart = Math.max(0, clip.start_time - marginBefore);
              const effEnd =
                clip.video_duration > 0
                  ? Math.min(clip.video_duration, clip.end_time + marginAfter)
                  : clip.end_time + marginAfter;
              const hasMargin = marginBefore > 0 || marginAfter > 0;

              return (
                <motion.div
                  layout
                  key={clip.id}
                  initial={{ opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94, x: 16 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className={`group relative rounded-xl border p-2.5 transition-all shadow-md ${
                    isSelected
                      ? "border-indigo-500/40 bg-[#18181C] hover:border-indigo-500/60 shadow-indigo-500/5"
                      : "border-white/5 bg-[#141418] opacity-75 hover:opacity-100 hover:border-white/15"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {/* Up / Down Reorder buttons */}
                    <div className="flex flex-col gap-0.5 shrink-0 opacity-35 group-hover:opacity-100 transition">
                      <Tooltip side="left" content="Subir en la lista">
                        <button
                          type="button"
                          disabled={currentPos <= 0}
                          onClick={() => onMoveClip?.(clip.id, "up")}
                          className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-15 disabled:hover:bg-transparent smooth-btn"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </button>
                      </Tooltip>
                      <Tooltip side="left" content="Bajar en la lista">
                        <button
                          type="button"
                          disabled={currentPos >= clips.length - 1}
                          onClick={() => onMoveClip?.(clip.id, "down")}
                          className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-15 disabled:hover:bg-transparent smooth-btn"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </Tooltip>
                    </div>

                    {/* Custom Animated Checkbox */}
                    <button
                      type="button"
                      onClick={() => onToggleSelectClip(clip.id)}
                      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border smooth-btn"
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
                      {/* External Video Source Badge (if from another video) */}
                      {!matchesCurrent && (
                        <div className="mb-1 flex items-center justify-between gap-1 text-[10px] text-amber-300/85 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                          <span className="truncate flex-1 font-medium">
                            {clip.video_title || "Otro video"}
                          </span>
                          <Tooltip content="Cargar el video de este clip en el visor">
                            <button
                              type="button"
                              onClick={() => onLoadClipVideo(clip)}
                              className="font-bold text-amber-200 hover:underline shrink-0 flex items-center gap-0.5"
                            >
                              <span>Cargar</span>
                              <ExternalLink className="h-2.5 w-2.5" />
                            </button>
                          </Tooltip>
                        </div>
                      )}

                      {/* Title row with Dynamic Ordinal Badge & Clean Action Toolbar */}
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
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
                              className="h-5 w-11 rounded bg-black/80 px-1 text-center font-mono text-[10px] font-bold text-indigo-300 outline-none ring-1 ring-indigo-500 shrink-0"
                            />
                          ) : (
                            <Tooltip
                              content={
                                onMoveClipToNumber && clips.length > 1
                                  ? `Posición #${currentNum} (clic para cambiar número y reordenar)`
                                  : `Posición #${currentNum}`
                              }
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  if (!onMoveClipToNumber || clips.length <= 1) return;
                                  setMovingNumberId(clip.id);
                                  setMoveNumberValue(String(currentNum));
                                }}
                                className={`flex h-5 min-w-[22px] px-1 items-center justify-center rounded bg-indigo-500/20 border border-indigo-500/40 text-[10px] font-mono font-bold text-indigo-300 tabular-nums shrink-0 select-none ${
                                  onMoveClipToNumber && clips.length > 1
                                    ? "cursor-pointer hover:bg-indigo-500/35 hover:border-indigo-400 smooth-btn"
                                    : "cursor-default"
                                }`}
                              >
                                {displayNum}
                              </button>
                            </Tooltip>
                          )}

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
                              title="Doble clic para renombrar"
                              className="truncate text-xs font-semibold text-slate-200 cursor-pointer hover:text-indigo-300 transition block"
                            >
                              {cleanClipTitle(clip.name)}
                            </span>
                          )}
                        </div>

                        {/* Actions Toolbar */}
                        <div
                          className={`flex items-center gap-0.5 transition shrink-0 ${
                            isAdjustExpanded
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100"
                          }`}
                        >
                          <Tooltip
                            content={
                              matchesCurrent
                                ? "Previsualizar tramo en el visor"
                                : "Cargar video y saltar a este clip"
                            }
                          >
                            <button
                              type="button"
                              onClick={() =>
                                matchesCurrent
                                  ? onPreviewClip(clip)
                                  : onLoadClipVideo(clip)
                              }
                              className="p-1 text-indigo-400 hover:text-indigo-300 rounded hover:bg-indigo-500/15 smooth-btn"
                            >
                              <Play className="h-3 w-3 fill-indigo-400" />
                            </button>
                          </Tooltip>

                          <Tooltip content="Ajuste rápido de tiempos (-15s / -5s / +5s / +15s)">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedAdjustId((prev) =>
                                  prev === clip.id ? null : clip.id
                                )
                              }
                              className={`p-1 rounded smooth-btn ${
                                isAdjustExpanded
                                  ? "bg-indigo-500/25 text-indigo-300"
                                  : "text-slate-400 hover:text-white hover:bg-white/10"
                              }`}
                            >
                              <Sliders className="h-3 w-3" />
                            </button>
                          </Tooltip>

                          <Tooltip content="Renombrar clip">
                            <button
                              type="button"
                              onClick={() => startEditing(clip)}
                              className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/10 smooth-btn"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          </Tooltip>

                          <Tooltip content="Eliminar clip">
                            <button
                              type="button"
                              onClick={() => onRemoveClip(clip.id)}
                              className="p-1 text-slate-400 hover:text-rose-400 rounded hover:bg-rose-500/10 smooth-btn"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </Tooltip>
                        </div>
                      </div>

                      {/* Single Clean Timecode Row */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-indigo-950/50 border border-indigo-500/25 px-1.5 py-0.5 font-mono text-[10px] tabular-nums font-medium text-indigo-300">
                          {formatTimecode(clip.start_time)} → {formatTimecode(clip.end_time)}
                        </span>

                        <span className="rounded bg-white/5 border border-white/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-300">
                          Δ {formatTimeShort(clipDuration)}
                        </span>

                        {hasMargin && (
                          <Tooltip content="Rango efectivo exportado tras aplicar el margen de seguridad">
                            <span className="rounded bg-emerald-950/35 border border-emerald-500/25 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-emerald-400">
                              +{formatTimecode(effStart)} → {formatTimecode(effEnd)}
                            </span>
                          </Tooltip>
                        )}
                      </div>

                      {/* Expandable Fine-Tuning Controls (no redundant timecodes!) */}
                      <AnimatePresence initial={false}>
                        {isAdjustExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.16, ease: "easeOut" }}
                            className="overflow-hidden"
                          >
                            <div className="mt-1.5 flex flex-col gap-1 rounded-lg border border-white/10 bg-black/35 p-1.5 text-[10px]">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-400 font-medium">Inicio:</span>
                                <div className="flex items-center gap-1">
                                  {[-15, -5, 5, 15].map((delta) => (
                                    <button
                                      key={`s-${delta}`}
                                      type="button"
                                      onClick={() => onAdjustClipTimes(clip.id, delta, 0)}
                                      className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-slate-300 hover:bg-indigo-500/30 hover:text-white smooth-btn"
                                    >
                                      {delta > 0 ? `+${delta}s` : `${delta}s`}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-400 font-medium">Fin:</span>
                                <div className="flex items-center gap-1">
                                  {[-15, -5, 5, 15].map((delta) => (
                                    <button
                                      key={`e-${delta}`}
                                      type="button"
                                      onClick={() => onAdjustClipTimes(clip.id, 0, delta)}
                                      className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-slate-300 hover:bg-indigo-500/30 hover:text-white smooth-btn"
                                    >
                                      {delta > 0 ? `+${delta}s` : `${delta}s`}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {/* Notes Badge if any */}
                      {clip.notes && (
                        <Tooltip content={clip.notes}>
                          <div className="mt-1 w-full text-[10px] text-slate-400 italic bg-white/[0.02] px-1.5 py-0.5 rounded border border-white/5 truncate">
                            {clip.notes}
                          </div>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* ── 3. Compact Tooltip-Driven Footer & Dismissible Export Status ── */}
      <div className="flex flex-col gap-2 border-t border-white/10 bg-[#18181C] p-3">
        {/* Metrics summary */}
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-indigo-400" />
            <span>Total:</span>
            <span className="font-mono tabular-nums font-semibold text-slate-200">
              {formatTimecode(totalSelectedSeconds)}
            </span>
          </div>

          <Tooltip content="Tamaño estimado aproximado según duración seleccionada">
            <div className="flex items-center gap-1 cursor-help">
              <HardDrive className="h-3 w-3 text-slate-500" />
              <span className="tabular-nums">~{estimatedMb} MB</span>
            </div>
          </Tooltip>
        </div>

        {/* Quick Toggles: Precise Cut & Merge */}
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <Tooltip content="Recodifica en los bordes para un corte exacto al fotograma. Desactivado = copia directa instantánea sin pérdida">
            <label className="flex w-full items-center gap-2 cursor-pointer rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5 hover:bg-white/[0.05] smooth-btn">
              <input
                type="checkbox"
                checked={preciseCut}
                onChange={(e) => onTogglePreciseCut(e.target.checked)}
                className="accent-indigo-500 h-3.5 w-3.5 rounded"
              />
              <span className="text-slate-300 truncate">Corte Preciso</span>
            </label>
          </Tooltip>

          <Tooltip content="Combina todos los clips seleccionados en un único archivo de video continuo">
            <label className="flex w-full items-center gap-2 cursor-pointer rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5 hover:bg-white/[0.05] smooth-btn">
              <input
                type="checkbox"
                checked={mergeClips}
                onChange={(e) => onToggleMergeClips(e.target.checked)}
                className="accent-indigo-500 h-3.5 w-3.5 rounded"
              />
              <span className="text-slate-300 truncate">Unir en 1 video</span>
            </label>
          </Tooltip>
        </div>

        {/* Compact Output folder indicator */}
        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 rounded-lg border border-white/5 bg-black/40 px-2 py-1.5">
          <Tooltip className="flex flex-1 min-w-0" content={outputDir || "Carpeta de descargas"}>
            <div className="flex flex-1 min-w-0 items-center gap-1.5">
              <Folder className="h-3 w-3 text-indigo-400 shrink-0" />
              <span className="truncate text-slate-300 select-text">
                {outputDir || "Carpeta de descargas"}
              </span>
            </div>
          </Tooltip>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onPickFolder}
              className="text-indigo-400 hover:text-indigo-300 text-[10px] font-semibold smooth-btn"
            >
              Cambiar
            </button>
            {outputDir && (
              <Tooltip content="Abrir carpeta en el Explorador">
                <button
                  type="button"
                  onClick={() => onOpenFolder(outputDir)}
                  className="text-slate-400 hover:text-white smooth-btn"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Export Resolution & Filename Format row */}
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <Tooltip content="Calidad máxima objetivo para el archivo final exportado">
            <select
              value={qualityPreset}
              onChange={(e) =>
                onQualityPresetChange?.(
                  e.target.value as ManualDownloadOptions["quality_preset"]
                )
              }
              className="h-7 w-full rounded-lg bg-black/40 border border-white/10 px-2 font-medium text-[11px] text-indigo-300 outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="best" className="bg-[#111114]">Calidad: Máxima</option>
              <option value="2160" className="bg-[#111114]">Calidad: 4K 2160p</option>
              <option value="1440" className="bg-[#111114]">Calidad: 2K 1440p</option>
              <option value="1080" className="bg-[#111114]">Calidad: 1080p</option>
              <option value="720" className="bg-[#111114]">Calidad: 720p</option>
              <option value="480" className="bg-[#111114]">Calidad: 480p</option>
              <option value="360" className="bg-[#111114]">Calidad: 360p</option>
            </select>
          </Tooltip>

          <div className="flex h-7 rounded-lg bg-black/40 p-0.5 border border-white/10 text-[10px]">
            <Tooltip className="flex-1 flex" content="Nombre corto: 01. Nombre del clip.mp4">
              <button
                type="button"
                onClick={() => onFilenameFormatChange("clean")}
                className={`w-full rounded px-1.5 font-medium smooth-btn ${
                  filenameFormat === "clean"
                    ? "bg-indigo-600 text-white shadow-sm font-semibold"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Limpio
              </button>
            </Tooltip>
            <Tooltip className="flex-1 flex" content="Nombre completo: Título Stream - 01. Nombre.mp4">
              <button
                type="button"
                onClick={() => onFilenameFormatChange("full")}
                className={`w-full rounded px-1.5 font-medium smooth-btn ${
                  filenameFormat === "full"
                    ? "bg-indigo-600 text-white shadow-sm font-semibold"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Con Título
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 🌟 EXPORT PROGRESS, DISMISSIBLE STATUS BANNER & ALWAYS-READY EXPORT CTA 🌟 */}
        {isExporting ? (
          <div className="space-y-2 rounded-xl border border-indigo-500/40 bg-indigo-950/30 p-2.5 shadow-lg shadow-indigo-500/10">
            <div className="flex items-center justify-between text-xs font-semibold text-indigo-200">
              <div className="flex items-center gap-1.5 min-w-0">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400 shrink-0" />
                <span className="truncate">
                  {activeJob?.current_step || "Procesando corte FFmpeg..."}
                </span>
              </div>
              <span className="font-mono tabular-nums text-indigo-300 shrink-0">
                {activeJob?.percent.toFixed(0)}%
              </span>
            </div>

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
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence>
              {(isCompleted || isError || isCancelled) && activeJob && (
                <motion.div
                  key={activeJob.job_id + activeJob.status}
                  initial={{ opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.96 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-xs shadow-md ${
                    isCompleted
                      ? "border-emerald-500/40 bg-emerald-950/35 text-emerald-200"
                      : isError
                      ? "border-rose-500/40 bg-rose-950/35 text-rose-200"
                      : "border-amber-500/35 bg-amber-950/25 text-amber-200"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {isCompleted ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    ) : isError ? (
                      <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
                    )}
                    <span className="truncate font-semibold text-[11px]">
                      {isCompleted
                        ? "¡Exportado correctamente!"
                        : isError
                        ? activeJob.current_step || activeJob.log_line || "Error al exportar"
                        : "Exportación cancelada"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {isCompleted && (
                      <Tooltip content="Abrir carpeta donde se guardaron los clips">
                        <button
                          type="button"
                          onClick={() => {
                            const target = activeJob.output_files[0]
                              ? activeJob.output_files[0].replace(/[/\\][^/\\]+$/, "")
                              : outputDir;
                            onOpenFolder(target);
                          }}
                          className="flex items-center gap-1 rounded-lg bg-emerald-600/85 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500 smooth-btn"
                        >
                          <FolderOpen className="h-3 w-3" />
                          <span>Abrir</span>
                        </button>
                      </Tooltip>
                    )}

                    <Tooltip content="Quitar este aviso">
                      <button
                        type="button"
                        onClick={() => onDismissJob?.(activeJob.job_id)}
                        className="flex h-6 w-6 items-center justify-center rounded-lg text-slate-300 hover:bg-white/15 hover:text-white smooth-btn"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button
              whileHover={{ scale: 1.015 }}
              whileTap={{ scale: 0.985 }}
              type="button"
              onClick={onExportSelected}
              disabled={selectedClips.length === 0}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 text-xs font-bold text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-500 hover:to-violet-500 smooth-btn disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              <span>
                Exportar Seleccionados ({selectedClips.length}/{clips.length})
              </span>
            </motion.button>
          </div>
        )}
      </div>
    </section>
  );
};
