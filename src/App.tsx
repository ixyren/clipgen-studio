import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Cpu, Film, Layers, Scissors, Sliders } from "lucide-react";

import { HeaderStatus, type UpdateNotice } from "./components/HeaderStatus";
import { UrlAnalyzer, type WorkspaceTab } from "./components/UrlAnalyzer";
import { VideoPreviewStudio } from "./components/VideoPreviewStudio";
import { ClipListManager } from "./components/ClipListManager";
import { DownloadOptionsPanel } from "./components/DownloadOptionsPanel";
import { JobQueueDrawer } from "./components/JobQueueDrawer";

import type {
  BinaryStatus,
  BinaryUpdateProgress,
  ClipExportRequest,
  ClipSegment,
  JobProgressEvent,
  JobState,
  ManualDownloadOptions,
  SavedClipEntry,
  VideoChapter,
  VideoMetadata,
} from "./types";

const STORAGE_OUTPUT_DIR_KEY = "clipgen_output_dir";

const DEFAULT_OPTIONS: ManualDownloadOptions = {
  mode: "video_audio",
  quality_preset: "1080",
  custom_video_format_id: null,
  custom_audio_format_id: null,
  audio_track_id: null,
  audio_format_id: null,
  container: "mp4",
  audio_format: "mp3",
  audio_bitrate: "320K",
  embed_subtitles: false,
  subtitle_lang: "es,en",
  embed_thumbnail: false,
  embed_metadata: true,
  rate_limit: null,
  custom_args: null,
  target_fps: null,
  output_dir: "",
};

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function matchesMetadataVideo(
  entry: SavedClipEntry,
  meta: VideoMetadata | null,
  currentUrl: string
): boolean {
  if (!meta) return false;
  if (meta.id && entry.video_id) {
    return entry.video_id === meta.id;
  }
  const activeUrl = meta.webpage_url || currentUrl;
  return Boolean(activeUrl && entry.video_url === activeUrl);
}

function buildBatchRequests(
  entries: SavedClipEntry[],
  fallbackOutputDir: string
): ClipExportRequest[] {
  const groups = new Map<string, SavedClipEntry[]>();
  for (const entry of entries) {
    const key = entry.video_id || entry.video_url;
    const list = groups.get(key);
    if (list) {
      list.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  return Array.from(groups.values()).map((group) => {
    const first = group[0];
    return {
      url: first.video_url,
      video_title: first.video_title,
      clips: group.map((c) => ({
        id: c.id,
        name: c.name,
        start_time: c.start_time,
        end_time: c.end_time,
      })),
      merge_clips: first.merge_clips && group.length > 1,
      precise_cut: first.precise_cut,
      options: {
        ...first.options,
        output_dir: first.options.output_dir || fallbackOutputDir,
      },
    };
  });
}

export function App() {
  const [binaryStatus, setBinaryStatus] = useState<BinaryStatus | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingBinaries, setUpdatingBinaries] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null);
  const [binaryProgress, setBinaryProgress] = useState<
    Record<string, BinaryUpdateProgress>
  >({});

  const [url, setUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("clipper");

  const [activeStart, setActiveStart] = useState(0);
  const [activeEnd, setActiveEnd] = useState(15);
  const [seekRequest, setSeekRequest] = useState<{
    time: number;
    autoplay?: boolean;
    nonce: number;
  } | null>(null);

  const [savedClips, setSavedClips] = useState<SavedClipEntry[]>([]);
  const [clipsLoaded, setClipsLoaded] = useState(false);
  const [savedClipsPath, setSavedClipsPath] = useState("");
  const [mergeClips, setMergeClips] = useState(false);
  const [preciseCut, setPreciseCut] = useState(true);

  const [options, setOptions] = useState<ManualDownloadOptions>(DEFAULT_OPTIONS);
  const [jobs, setJobs] = useState<JobState[]>([]);

  const currentVideoClips: ClipSegment[] = useMemo(() => {
    if (!metadata) return [];
    return savedClips
      .filter((entry) => matchesMetadataVideo(entry, metadata, url))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        start_time: entry.start_time,
        end_time: entry.end_time,
      }));
  }, [savedClips, metadata, url]);

  const describeStatusNotice = useCallback((status: BinaryStatus): UpdateNotice => {
    const updates: string[] = [];
    if (status.ytdlp_update_available && status.ytdlp_installed) {
      updates.push(
        `yt-dlp (${status.ytdlp_version ?? "?"} → ${status.ytdlp_latest ?? "nueva"})`
      );
    }
    if (status.ffmpeg_update_available && status.ffmpeg_installed) {
      updates.push(
        `FFmpeg (${status.ffmpeg_latest ?? "nueva compilación"})`
      );
    }
    if (updates.length > 0) {
      return {
        kind: "available",
        text: `Hay nuevas versiones disponibles en GitHub: ${updates.join(" y ")}.`,
      };
    }
    return {
      kind: "ok",
      text: `Tienes la última versión instalada (yt-dlp v${status.ytdlp_version ?? "?"} • FFmpeg ${status.ffmpeg_version ?? "?"}). No se requiere descarga.`,
    };
  }, []);

  const installPendingUpdates = useCallback(async () => {
    setUpdatingBinaries(true);
    setUpdateNotice(null);
    try {
      const updated = await invoke<BinaryStatus>("ensure_and_update_binaries", {
        force: false,
      });
      setBinaryStatus(updated);
      setUpdateNotice({
        kind: "ok",
        text: `Motores actualizados y listos (yt-dlp v${updated.ytdlp_version ?? "?"} • FFmpeg ${updated.ffmpeg_version ?? "?"}).`,
      });
    } catch (err) {
      console.error("Error actualizando binarios:", err);
      setUpdateNotice({
        kind: "error",
        text: `Error al descargar actualizaciones: ${String(err)}`,
      });
      try {
        const current = await invoke<BinaryStatus>("check_binaries_status");
        setBinaryStatus(current);
      } catch {
        // Ignore secondary probe failure
      }
    } finally {
      setUpdatingBinaries(false);
    }
  }, []);

  const checkUpdatesOnly = useCallback(
    async (showOkBanner: boolean) => {
      setCheckingUpdates(true);
      try {
        const status = await invoke<BinaryStatus>("check_binaries_status");
        setBinaryStatus(status);

        if (!status.ytdlp_installed || !status.ffmpeg_installed) {
          await installPendingUpdates();
          return;
        }

        const notice = describeStatusNotice(status);
        if (notice.kind === "available" || showOkBanner) {
          setUpdateNotice(notice);
        }
      } catch (err) {
        setUpdateNotice({
          kind: "error",
          text: `No se pudo comprobar actualizaciones en GitHub: ${String(err)}`,
        });
      } finally {
        setCheckingUpdates(false);
      }
    },
    [describeStatusNotice, installPendingUpdates]
  );

  useEffect(() => {
    let unlistenBinary: (() => void) | undefined;
    let unlistenJob: (() => void) | undefined;

    const init = async () => {
      const savedDir =
        typeof localStorage !== "undefined"
          ? localStorage.getItem(STORAGE_OUTPUT_DIR_KEY)?.trim() ?? ""
          : "";
      if (savedDir) {
        setOptions((prev) => ({ ...prev, output_dir: savedDir }));
      } else {
        try {
          const dir = await invoke<string>("get_default_download_dir");
          setOptions((prev) => (prev.output_dir ? prev : { ...prev, output_dir: dir }));
        } catch {
          // Fallback handled if user sets manually
        }
      }

      try {
        const [loadedClips, jsonPath] = await Promise.all([
          invoke<SavedClipEntry[]>("load_persistent_clips"),
          invoke<string>("get_persistent_clips_file_path"),
        ]);
        setSavedClips(Array.isArray(loadedClips) ? loadedClips : []);
        setSavedClipsPath(jsonPath);
      } catch (err) {
        console.error("Error cargando clips persistentes:", err);
      } finally {
        setClipsLoaded(true);
      }

      unlistenBinary = await listen<BinaryUpdateProgress>(
        "binary-update-progress",
        (event) => {
          setBinaryProgress((prev) => ({
            ...prev,
            [event.payload.binary]: event.payload,
          }));
        }
      );

      unlistenJob = await listen<JobProgressEvent>("job-progress", (event) => {
        const payload = event.payload;
        setJobs((prev) => {
          const existingIdx = prev.findIndex((j) => j.job_id === payload.job_id);
          if (existingIdx === -1) {
            const created: JobState = {
              ...payload,
              logs: payload.log_line ? [payload.log_line] : [],
              createdAt: Date.now(),
            };
            return [created, ...prev];
          }

          const next = [...prev];
          const prevJob = next[existingIdx];
          if (prevJob.status === "cancelled" && payload.status !== "cancelled") {
            return prev;
          }

          const isTransitionToCancelled = payload.status === "cancelled";
          const logs = payload.log_line
            ? [...prevJob.logs.slice(-199), payload.log_line]
            : prevJob.logs;
          next[existingIdx] = {
            ...prevJob,
            ...payload,
            percent:
              isTransitionToCancelled && payload.percent === 0
                ? prevJob.percent
                : payload.percent,
            clip_percent: isTransitionToCancelled
              ? payload.clip_percent ?? prevJob.clip_percent ?? null
              : payload.clip_percent ?? null,
            clip_index: payload.clip_index ?? prevJob.clip_index ?? null,
            clip_total: payload.clip_total ?? prevJob.clip_total ?? null,
            clip_name: payload.clip_name ?? prevJob.clip_name ?? null,
            output_files:
              payload.output_files.length > 0
                ? payload.output_files
                : prevJob.output_files,
            logs,
          };
          return next;
        });
      });

      await checkUpdatesOnly(false);
    };

    void init();

    return () => {
      unlistenBinary?.();
      unlistenJob?.();
    };
  }, [checkUpdatesOnly]);

  useEffect(() => {
    if (!clipsLoaded) return;
    void invoke("save_persistent_clips", { clips: savedClips }).catch((err) => {
      console.error("Error guardando clips persistentes:", err);
    });
  }, [savedClips, clipsLoaded]);

  const handleOptionsChange = useCallback(
    (next: ManualDownloadOptions) => {
      setOptions(next);
      if (typeof localStorage !== "undefined" && next.output_dir.trim()) {
        localStorage.setItem(STORAGE_OUTPUT_DIR_KEY, next.output_dir);
      }
      if (metadata) {
        setSavedClips((prev) =>
          prev.map((entry) =>
            matchesMetadataVideo(entry, metadata, url)
              ? { ...entry, options: next }
              : entry
          )
        );
      }
    },
    [metadata, url]
  );

  const handleTogglePreciseCut = useCallback(
    (val: boolean) => {
      setPreciseCut(val);
      setSavedClips((prev) =>
        prev.map((entry) =>
          !metadata || matchesMetadataVideo(entry, metadata, url)
            ? { ...entry, precise_cut: val }
            : entry
        )
      );
    },
    [metadata, url]
  );

  const handleToggleMergeClips = useCallback(
    (val: boolean) => {
      setMergeClips(val);
      setSavedClips((prev) =>
        prev.map((entry) =>
          !metadata || matchesMetadataVideo(entry, metadata, url)
            ? { ...entry, merge_clips: val }
            : entry
        )
      );
    },
    [metadata, url]
  );

  const handlePickFolder = useCallback(async () => {
    try {
      const chosen = await invoke<string | null>("pick_download_folder", {
        initialDir: options.output_dir || null,
      });
      if (chosen) {
        handleOptionsChange({ ...options, output_dir: chosen });
      }
    } catch (err) {
      setAnalyzeError(`No se pudo elegir carpeta: ${String(err)}`);
    }
  }, [options, handleOptionsChange]);

  const handleSelectAudioTrack = useCallback(
    (trackId: string) => {
      const track =
        metadata?.audio_tracks.find((t) => t.track_id === trackId) ?? null;
      handleOptionsChange({
        ...options,
        audio_track_id: track?.track_id ?? null,
        audio_format_id: track?.format_id ?? null,
      });
    },
    [metadata, options, handleOptionsChange]
  );

  const handleAnalyze = async (overrideUrl?: string) => {
    const targetUrl = (overrideUrl ?? url).trim();
    if (!targetUrl) return;
    if (overrideUrl) {
      setUrl(targetUrl);
      setActiveTab("clipper");
    }

    setAnalyzing(true);
    setAnalyzeError(null);

    try {
      const data = await invoke<VideoMetadata>("fetch_video_info", {
        url: targetUrl,
      });
      setMetadata(data);
      const existingForVideo = savedClips.filter((entry) =>
        matchesMetadataVideo(entry, data, targetUrl)
      );
      if (existingForVideo.length > 0) {
        const sample = existingForVideo[0];
        setPreciseCut(sample.precise_cut);
        setMergeClips(sample.merge_clips);
        setOptions((prev) => ({
          ...sample.options,
          output_dir: sample.options.output_dir || prev.output_dir,
        }));
      } else {
        const defaultTrack = data.audio_tracks[0] ?? null;
        setOptions((prev) => ({
          ...prev,
          audio_track_id: defaultTrack?.track_id ?? null,
          audio_format_id: defaultTrack?.format_id ?? null,
        }));
      }
      const dur = Math.max(data.duration || 30, 1);
      setActiveStart(0);
      setActiveEnd(Math.min(15, dur));
      setSeekRequest(null);
    } catch (err) {
      setAnalyzeError(String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleOpenFolder = async (path: string) => {
    if (!path) return;
    try {
      await invoke("open_output_folder", { path });
    } catch (err) {
      console.error("Error abriendo carpeta:", err);
      setAnalyzeError(`No se pudo abrir la ubicación: ${String(err)}`);
    }
  };

  const createSavedEntry = (name: string, start: number, end: number): SavedClipEntry | null => {
    if (!metadata || end <= start) return null;
    return {
      id: makeId(),
      name,
      start_time: start,
      end_time: end,
      video_url: metadata.webpage_url || url,
      video_id: metadata.id,
      video_title: metadata.title,
      video_thumbnail: metadata.thumbnail,
      video_duration: metadata.duration,
      precise_cut: preciseCut,
      merge_clips: mergeClips,
      options: { ...options },
    };
  };

  const handleAddClip = (name: string, start: number, end: number) => {
    const entry = createSavedEntry(name, start, end);
    if (!entry) return;
    setSavedClips((prev) => [...prev, entry]);
  };

  const handlePreviewClip = (clip: ClipSegment) => {
    setActiveStart(clip.start_time);
    setActiveEnd(clip.end_time);
    setSeekRequest({ time: clip.start_time, autoplay: true, nonce: Date.now() });
  };

  const invokeExportRequests = async (requests: ClipExportRequest[]) => {
    if (requests.length === 0) return;
    try {
      if (requests.length === 1) {
        await invoke<string>("export_clips", { request: requests[0] });
      } else {
        await invoke<string>("export_clips_batch", { requests });
      }
    } catch (err) {
      setAnalyzeError(`Error iniciando exportación: ${String(err)}`);
    }
  };

  const startClipExport = async (targetClips: ClipSegment[], shouldMerge: boolean) => {
    if (!metadata || targetClips.length === 0) return;

    const request: ClipExportRequest = {
      url: metadata.webpage_url || url,
      video_title: metadata.title,
      clips: targetClips,
      merge_clips: shouldMerge,
      precise_cut: preciseCut,
      options,
    };

    await invokeExportRequests([request]);
  };

  const handleDownloadSingleSavedClip = async (entry: SavedClipEntry) => {
    const request: ClipExportRequest = {
      url: entry.video_url,
      video_title: entry.video_title,
      clips: [
        {
          id: entry.id,
          name: entry.name,
          start_time: entry.start_time,
          end_time: entry.end_time,
        },
      ],
      merge_clips: false,
      precise_cut: entry.precise_cut,
      options: {
        ...entry.options,
        output_dir: entry.options.output_dir || options.output_dir,
      },
    };
    await invokeExportRequests([request]);
  };

  const handleExportVideoGroup = async (videoKey: string) => {
    const groupEntries = savedClips.filter(
      (entry) => (entry.video_id || entry.video_url) === videoKey
    );
    await invokeExportRequests(buildBatchRequests(groupEntries, options.output_dir));
  };

  const handleExportAllSavedClips = async () => {
    await invokeExportRequests(buildBatchRequests(savedClips, options.output_dir));
  };

  const handleStartFullDownload = async () => {
    if (!metadata) return;
    try {
      await invoke<string>("start_full_download", {
        url: metadata.webpage_url || url,
        videoTitle: metadata.title,
        options,
      });
    } catch (err) {
      setAnalyzeError(`Error iniciando descarga: ${String(err)}`);
    }
  };

  const handleCancelJob = useCallback(async (jobId: string) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.job_id === jobId &&
        j.status !== "completed" &&
        j.status !== "error" &&
        j.status !== "cancelled"
          ? {
              ...j,
              status: "cancelled",
              current_step: "Cancelando descarga...",
            }
          : j
      )
    );
    try {
      await invoke("cancel_job", { jobId });
    } catch (err) {
      setAnalyzeError(`No se pudo cancelar la descarga: ${String(err)}`);
    }
  }, []);

  const handleAddFromChapter = (ch: VideoChapter) => {
    if (ch.end_time <= ch.start_time) return;
    handleAddClip(ch.title, ch.start_time, ch.end_time);
  };

  const handleAddAllChapters = () => {
    if (!metadata) return;
    const valid: SavedClipEntry[] = metadata.chapters
      .filter((ch) => ch.end_time > ch.start_time)
      .map((ch) => createSavedEntry(ch.title, ch.start_time, ch.end_time))
      .filter((entry): entry is SavedClipEntry => entry !== null);
    setSavedClips((prev) => [...prev, ...valid]);
  };

  const renderClipListManager = () => (
    <ClipListManager
      savedClips={savedClips}
      currentVideoId={metadata?.id ?? null}
      currentVideoUrl={metadata ? metadata.webpage_url || url : null}
      chapters={metadata?.chapters ?? []}
      mergeClips={mergeClips}
      preciseCut={preciseCut}
      outputDir={options.output_dir}
      savedClipsFilePath={savedClipsPath}
      onPickFolder={() => void handlePickFolder()}
      onOpenFolder={(p) => void handleOpenFolder(p)}
      onToggleMergeClips={handleToggleMergeClips}
      onTogglePreciseCut={handleTogglePreciseCut}
      onRenameClip={(id, name) =>
        setSavedClips((prev) =>
          prev.map((c) => (c.id === id ? { ...c, name } : c))
        )
      }
      onRemoveClip={(id) =>
        setSavedClips((prev) => prev.filter((c) => c.id !== id))
      }
      onRemoveVideoGroup={(videoKey) =>
        setSavedClips((prev) =>
          prev.filter((c) => (c.video_id || c.video_url) !== videoKey)
        )
      }
      onClearCurrentVideoClips={() =>
        setSavedClips((prev) =>
          prev.filter((c) => !matchesMetadataVideo(c, metadata, url))
        )
      }
      onClearAllSavedClips={() => setSavedClips([])}
      onPreviewClip={(entry) => handlePreviewClip(entry)}
      onDownloadSingleClip={(entry) =>
        void handleDownloadSingleSavedClip(entry)
      }
      onExportCurrentVideo={() =>
        void startClipExport(
          currentVideoClips,
          mergeClips && currentVideoClips.length > 1
        )
      }
      onExportVideoGroup={(videoKey) => void handleExportVideoGroup(videoKey)}
      onExportAllSavedClips={() => void handleExportAllSavedClips()}
      onLoadSavedVideo={(videoUrl) => void handleAnalyze(videoUrl)}
      onAddFromChapter={handleAddFromChapter}
      onAddAllChapters={handleAddAllChapters}
    />
  );

  const enginesReady =
    Boolean(binaryStatus?.ytdlp_installed) &&
    Boolean(binaryStatus?.ffmpeg_installed);

  return (
    <div className="min-h-screen bg-[#090A0F] text-slate-100 flex flex-col">
      {/* Background radial ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-[420px] w-[420px] rounded-full bg-violet-600/12 blur-[120px]" />
        <div className="absolute right-0 top-1/4 h-[380px] w-[380px] rounded-full bg-cyan-500/10 blur-[120px]" />
      </div>

      <HeaderStatus
        status={binaryStatus}
        checking={checkingUpdates}
        updating={updatingBinaries}
        progressMap={binaryProgress}
        notice={updateNotice}
        onCheckUpdates={() => void checkUpdatesOnly(true)}
        onInstallUpdates={() => void installPendingUpdates()}
        onDismissNotice={() => setUpdateNotice(null)}
      />

      <main className="relative z-10 mx-auto w-full max-w-[1600px] flex-1 space-y-5 px-5 py-5">
        <UrlAnalyzer
          url={url}
          onUrlChange={setUrl}
          onAnalyze={handleAnalyze}
          analyzing={analyzing}
          error={analyzeError}
          metadata={metadata}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          enginesReady={enginesReady}
        />

        {!metadata ? (
          /* Welcome Empty State (+ Persistent Saved Clips Queue if present) */
          <div
            className={
              savedClips.length > 0
                ? "grid grid-cols-1 gap-5 xl:grid-cols-12"
                : ""
            }
          >
            <section
              className={`studio-panel rounded-2xl p-8 sm:p-10 ${
                savedClips.length > 0 ? "xl:col-span-7" : ""
              }`}
            >
              <div className="mx-auto max-w-3xl text-center space-y-4">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600/30 to-cyan-500/30 border border-white/10">
                  <Film className="h-7 w-7 text-cyan-300" />
                </div>
                <h2 className="text-xl font-bold text-white sm:text-2xl">
                  Estudio de Descarga y Recorte de Video en Rust
                </h2>
                <p className="text-sm text-slate-400">
                  Pega cualquier enlace de YouTube arriba para analizar sus formatos reales, previsualizar el video en vivo y extraer uno o múltiples clips con precisión de fotograma.
                </p>

                <div className="grid grid-cols-1 gap-4 pt-4 text-left sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-1.5">
                    <Scissors className="h-5 w-5 text-violet-400" />
                    <h3 className="text-xs font-semibold text-white">
                      Vista Previa en Vivo
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Reproductor directo con timeline interactivo, saltos de 100ms y bucle de selección.
                    </p>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-1.5">
                    <Layers className="h-5 w-5 text-cyan-400" />
                    <h3 className="text-xs font-semibold text-white">
                      Multi-Clip &amp; Persistencia
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Guarda clips de varios videos entre sesiones y expórtalos todos en un solo clic.
                    </p>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-1.5">
                    <Sliders className="h-5 w-5 text-emerald-400" />
                    <h3 className="text-xs font-semibold text-white">
                      Control Manual Total
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Elige resolución, format_id exacto, códec, audio MP3/FLAC/WAV, subtítulos y args.
                    </p>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-1.5">
                    <Cpu className="h-5 w-5 text-amber-400" />
                    <h3 className="text-xs font-semibold text-white">
                      Auto-Actualización
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Descarga y mantiene al día yt-dlp y FFmpeg automáticamente desde GitHub Releases.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {savedClips.length > 0 && (
              <div className="xl:col-span-5">{renderClipListManager()}</div>
            )}
          </div>
        ) : activeTab === "clipper" ? (
          /* Live Preview & Multi-Clip Studio */
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <div className="space-y-5 xl:col-span-8">
              <VideoPreviewStudio
                metadata={metadata}
                clips={currentVideoClips}
                activeStart={activeStart}
                activeEnd={activeEnd}
                selectedAudioTrackId={options.audio_track_id}
                onSelectAudioTrack={handleSelectAudioTrack}
                onActiveRangeChange={(s, e) => {
                  setActiveStart(s);
                  setActiveEnd(e);
                }}
                onAddClip={handleAddClip}
                onDownloadSelectionNow={(name, start, end) =>
                  void startClipExport(
                    [{ id: makeId(), name, start_time: start, end_time: end }],
                    false
                  )
                }
                seekRequest={seekRequest}
              />

              <DownloadOptionsPanel
                metadata={metadata}
                options={options}
                onChange={handleOptionsChange}
                onOpenFolder={(p) => void handleOpenFolder(p)}
                onPickFolder={() => void handlePickFolder()}
                compact
              />
            </div>

            <div className="xl:col-span-4">{renderClipListManager()}</div>
          </div>
        ) : (
          /* Full Manual Download Mode */
          <DownloadOptionsPanel
            metadata={metadata}
            options={options}
            onChange={handleOptionsChange}
            onOpenFolder={(p) => void handleOpenFolder(p)}
            onPickFolder={() => void handlePickFolder()}
            onStartFullDownload={() => void handleStartFullDownload()}
            showFullDownloadButton
          />
        )}

        <JobQueueDrawer
          jobs={jobs}
          onOpenFolder={(p) => void handleOpenFolder(p)}
          onCancelJob={(id) => void handleCancelJob(id)}
          onClearFinished={() =>
            setJobs((prev) =>
              prev.filter(
                (j) =>
                  j.status !== "completed" &&
                  j.status !== "error" &&
                  j.status !== "cancelled"
              )
            )
          }
        />

        <footer className="pt-2 pb-4 text-center text-xs text-slate-500">
          ClipGen Studio • Autor: <span className="text-slate-400 font-medium">Javier Medina</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
