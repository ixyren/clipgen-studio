import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { TitleBar } from "./components/TitleBar";
import { VisorPanel } from "./components/VisorPanel";
import { ClipQueuePanel } from "./components/ClipQueuePanel";
import { SettingsModal } from "./components/SettingsModal";
import { ImportJsonModal } from "./components/ImportJsonModal";
import { TranscriptionModal } from "./components/TranscriptionModal";
import { PasteConfirmModal } from "./components/PasteConfirmModal";
import { parseClipGenJson, type ParsedClip } from "./utils/jsonParser";
import { cleanClipTitle } from "./utils/time";

import type {
  BinaryStatus,
  BinaryUpdateProgress,
  ClipExportRequest,
  JobProgressEvent,
  JobState,
  ManualDownloadOptions,
  SavedClipEntry,
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

function isUrlMatchingMetadata(rawUrl: string, meta: VideoMetadata | null): boolean {
  if (!meta) return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return true;
  if (meta.webpage_url && trimmed === meta.webpage_url.trim()) {
    return true;
  }
  if (meta.id && trimmed.includes(meta.id)) {
    return true;
  }
  return false;
}

const AI_PROMPT_TEMPLATE = `Actúa como un editor de video y creador de contenido profesional para YouTube Shorts, TikTok y Reels.

Analiza la siguiente transcripción con marcas de tiempo (timestamps) y picos de audio de un stream de YouTube. Tu objetivo es seleccionar los mejores momentos y clips más virales, entretenidos, graciosos o de mayor tensión de todo el directo.

Genera ÚNICAMENTE un bloque de código JSON válido con la siguiente especificación exacta para importarlo directamente en ClipGen Studio:

{
  "stream_url": "URL_DEL_STREAM_AQUI",
  "clips": [
    {
      "title": "Título descriptivo y atractivo del clip",
      "start": 1420,
      "end": 1465,
      "notes": "Motivo del corte y momento destacado"
    }
  ]
}

Reglas:
1. "start" y "end" deben ser números en segundos o marcas en formato "HH:MM:SS".
2. "end" debe ser estrictamente mayor que "start".
3. Incluye unos 2 a 5 segundos de contexto previo antes del momento cumbre y 2 a 4 segundos de reacción posterior.
4. Presta atención a las etiquetas emocionales y reacciones paralingüísticas cuando aparezcan en la transcripción ([RABIA], [ALEGRÍA], [RISA], [CARCAJADA], [SUSPIRO], [GRITO], [SORPRESA], [MIEDO/TENSIÓN], [TRISTEZA], [ASOMBRO], [LLANTO], [SUSURRO], [QUEJIDO], [APLAUSOS] y [PICO DE AUDIO]) para detectar dónde ocurren momentos de humor, tensión, enfado o clímax emocional.
5. No inventes marcas de tiempo fuera del rango de la transcripción.
6. Devuelve EXCLUSIVAMENTE el JSON dentro de un bloque \`\`\`json \`\`\` sin explicaciones adicionales.

Transcripción del stream (con timestamps, emociones y reacciones):
[PEGA AQUÍ TU TRANSCRIPCIÓN CON TIMESTAMPS Y EMOCIONES]`;

function buildBatchRequests(
  entries: SavedClipEntry[],
  fallbackOutputDir: string,
  marginBefore: number,
  marginAfter: number,
  filenameFormat: "clean" | "full",
  clipStartIndex: number = 1,
  preciseCut: boolean = false,
  mergeClips: boolean = false,
  activeOptions?: ManualDownloadOptions
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
      clips: group.map((c) => {
        const effStart = Math.max(0, c.start_time - marginBefore);
        const effEnd =
          c.video_duration > 0
            ? Math.min(c.video_duration, c.end_time + marginAfter)
            : c.end_time + marginAfter;
        return {
          id: c.id,
          name: c.name,
          start_time: effStart,
          end_time: effEnd,
          notes: c.notes,
        };
      }),
      merge_clips: mergeClips && group.length > 1,
      precise_cut: preciseCut,
      options: {
        ...first.options,
        ...(activeOptions
          ? {
              quality_preset: activeOptions.quality_preset,
              container: activeOptions.container,
              mode: activeOptions.mode,
              audio_bitrate: activeOptions.audio_bitrate,
            }
          : {}),
        filename_format: filenameFormat,
        clip_start_index: clipStartIndex,
        output_dir: fallbackOutputDir || first.options.output_dir,
      },
    };
  });
}

export function App() {
  const [binaryStatus, setBinaryStatus] = useState<BinaryStatus | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingBinaries, setUpdatingBinaries] = useState(false);
  const [binaryProgress, setBinaryProgress] = useState<
    Record<string, BinaryUpdateProgress>
  >({});

  const [url, setUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeMessage, setAnalyzeMessage] = useState("Cargando video...");
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);

  const [activeStart, setActiveStart] = useState(0);
  const [activeEnd, setActiveEnd] = useState(15);
  const [seekRequest, setSeekRequest] = useState<{
    time: number;
    autoplay?: boolean;
    nonce: number;
  } | null>(null);

  const [savedClips, setSavedClips] = useState<SavedClipEntry[]>([]);
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(
    new Set()
  );
  const [clipsLoaded, setClipsLoaded] = useState(false);
  const [mergeClips, setMergeClips] = useState(false);
  const [preciseCut, setPreciseCut] = useState(false);

  const [marginBefore, setMarginBefore] = useState(0);
  const [marginAfter, setMarginAfter] = useState(0);
  const [filenameFormat, setFilenameFormat] = useState<"clean" | "full">("clean");
  const [clipStartIndex, setClipStartIndex] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("clipgen_start_index");
      const parsed = saved ? parseInt(saved, 10) : 1;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    } catch {
      return 1;
    }
  });

  const handleClipStartIndexChange = useCallback((val: number) => {
    setClipStartIndex(val);
    try {
      localStorage.setItem("clipgen_start_index", String(val));
    } catch {}
  }, []);

  const [isImportJsonOpen, setIsImportJsonOpen] = useState(false);
  const [isTranscriptionOpen, setIsTranscriptionOpen] = useState(false);
  const [pasteConfirmData, setPasteConfirmData] = useState<{
    streamUrl: string | null;
    clips: ParsedClip[];
  } | null>(null);

  const [options, setOptions] = useState<ManualDownloadOptions>(DEFAULT_OPTIONS);
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<"export" | "engines">("export");

  const openSettingsAtTab = useCallback((tab: "export" | "engines") => {
    setSettingsInitialTab(tab);
    setIsSettingsOpen(true);
  }, []);

  // Clips for current active video
  const currentVideoClips = useMemo(() => {
    if (!metadata) return savedClips;
    return savedClips.filter((entry) =>
      matchesMetadataVideo(entry, metadata, url)
    );
  }, [savedClips, metadata, url]);

  // Initial load: output directory, saved persistent clips, event listeners
  useEffect(() => {
    let unlistenBinary: (() => void) | undefined;
    let unlistenJob: (() => void) | undefined;
    let unlistenVideoLoad: (() => void) | undefined;

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
          setOptions((prev) =>
            prev.output_dir ? prev : { ...prev, output_dir: dir }
          );
        } catch {
          // Handled if user picks manually
        }
      }

      try {
        const loadedClips = await invoke<SavedClipEntry[]>(
          "load_persistent_clips"
        );
        if (Array.isArray(loadedClips)) {
          setSavedClips(loadedClips);
          setSelectedClipIds(new Set(loadedClips.map((c) => c.id)));
        }
        setClipsLoaded(true);
      } catch (err) {
        console.error("Error cargando clips persistentes:", err);
      }

      // Check binaries status
      try {
        const status = await invoke<BinaryStatus>("check_binaries_status");
        setBinaryStatus(status);
        if (!status.ytdlp_installed || !status.ffmpeg_installed) {
          void installPendingUpdates();
        }
      } catch {
        // Binary check failure
      }

      // Listen to binary update progress
      unlistenBinary = await listen<BinaryUpdateProgress>(
        "binary-update-progress",
        (event) => {
          setBinaryProgress((prev) => ({
            ...prev,
            [event.payload.binary]: event.payload,
          }));
        }
      );

      // Listen to video metadata load progress
      unlistenVideoLoad = await listen<{ percent: number; message: string }>(
        "video-load-progress",
        (event) => {
          setAnalyzeProgress(event.payload.percent);
          if (event.payload.message) {
            setAnalyzeMessage(event.payload.message);
          }
        }
      );

      // Listen to job progress
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
    };

    void init();

    return () => {
      unlistenBinary?.();
      unlistenJob?.();
      unlistenVideoLoad?.();
    };
  }, []);

  // Save persistent clips
  useEffect(() => {
    if (!clipsLoaded) return;
    void invoke("save_persistent_clips", { clips: savedClips }).catch((err) => {
      console.error("Error guardando clips persistentes:", err);
    });
  }, [savedClips, clipsLoaded]);

  const installPendingUpdates = useCallback(async () => {
    setUpdatingBinaries(true);
    try {
      const updated = await invoke<BinaryStatus>(
        "ensure_and_update_binaries",
        { force: false }
      );
      setBinaryStatus(updated);
    } catch (err) {
      console.error("Error actualizando binarios:", err);
    } finally {
      setUpdatingBinaries(false);
    }
  }, []);

  const checkUpdatesOnly = useCallback(async () => {
    setCheckingUpdates(true);
    try {
      const status = await invoke<BinaryStatus>("check_binaries_status");
      setBinaryStatus(status);
    } catch (err) {
      console.error("Error comprobando actualizaciones:", err);
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

  const handleOptionsChange = useCallback((next: ManualDownloadOptions) => {
    setOptions(next);
    if (typeof localStorage !== "undefined" && next.output_dir.trim()) {
      localStorage.setItem(STORAGE_OUTPUT_DIR_KEY, next.output_dir);
    }
  }, []);

  const handlePickFolder = useCallback(async () => {
    try {
      const chosen = await invoke<string | null>("pick_download_folder", {
        initialDir: options.output_dir || null,
      });
      if (chosen) {
        handleOptionsChange({ ...options, output_dir: chosen });
        setSavedClips((prev) =>
          prev.map((c) => ({
            ...c,
            options: { ...c.options, output_dir: chosen },
          }))
        );
      }
    } catch (err) {
      setAnalyzeError(`No se pudo seleccionar carpeta: ${String(err)}`);
    }
  }, [options, handleOptionsChange]);

  const handleOpenFolder = useCallback(async (path: string) => {
    if (!path) return;
    try {
      await invoke("open_output_folder", { path });
    } catch (err) {
      console.error("Error abriendo carpeta:", err);
    }
  }, []);

  // Analyze URL
  const handleAnalyze = async (overrideUrl?: string) => {
    const targetUrl = (overrideUrl ?? url).trim();
    if (!targetUrl) return;
    if (overrideUrl) {
      setUrl(targetUrl);
    }

    setAnalyzing(true);
    setAnalyzeProgress(4);
    setAnalyzeMessage("Conectando con el video...");
    setAnalyzeError(null);

    try {
      const data = await invoke<VideoMetadata>("fetch_video_info", {
        url: targetUrl,
      });
      setMetadata(data);

      const dur = Math.max(data.duration || 30, 1);
      setActiveStart(0);
      setActiveEnd(Math.min(15, dur));
      setSeekRequest(null);

      // Enrich any clips bound to this targetUrl with the real metadata
      setSavedClips((prev) =>
        prev.map((c) => {
          if (
            c.video_url === targetUrl ||
            (data.webpage_url && c.video_url === data.webpage_url)
          ) {
            return {
              ...c,
              video_url: data.webpage_url || c.video_url,
              video_id: data.id,
              video_title: data.title,
              video_thumbnail: data.thumbnail,
              video_duration: data.duration,
            };
          }
          return c;
        })
      );

      // Auto-configure audio track
      const defaultTrack = data.audio_tracks[0] ?? null;
      if (defaultTrack) {
        setOptions((prev) => ({
          ...prev,
          audio_track_id: defaultTrack.track_id,
          audio_format_id: defaultTrack.format_id,
        }));
      }
    } catch (err) {
      setAnalyzeProgress(0);
      setAnalyzeError(String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  // Add clip (optionally at a specific ordinal number)
  const handleAddClip = (
    name: string,
    start: number,
    end: number,
    insertAtNumber?: number
  ) => {
    if (!metadata || end <= start) return;

    const cleanName = cleanClipTitle(name.trim());

    const newEntry: SavedClipEntry = {
      id: makeId(),
      name: cleanName,
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

    setSavedClips((prev) => {
      if (
        typeof insertAtNumber === "number" &&
        Number.isFinite(insertAtNumber)
      ) {
        const targetIndex = Math.max(
          0,
          Math.min(prev.length, Math.floor(insertAtNumber) - clipStartIndex)
        );
        const next = [...prev];
        next.splice(targetIndex, 0, newEntry);
        return next;
      }
      return [...prev, newEntry];
    });
    setSelectedClipIds((prev) => new Set([...prev, newEntry.id]));
  };

  // Move clip to a specific ordinal position
  const handleMoveClipToNumber = useCallback(
    (id: string, targetNumber: number) => {
      if (!Number.isFinite(targetNumber)) return;
      setSavedClips((prev) => {
        const currentIndex = prev.findIndex((c) => c.id === id);
        if (currentIndex === -1) return prev;
        const targetIndex = Math.max(
          0,
          Math.min(prev.length - 1, Math.floor(targetNumber) - clipStartIndex)
        );
        if (targetIndex === currentIndex) return prev;
        const next = [...prev];
        const [moved] = next.splice(currentIndex, 1);
        next.splice(targetIndex, 0, moved);
        return next;
      });
    },
    [clipStartIndex]
  );

  // Reorder clips in queue
  const handleMoveClip = useCallback((id: string, direction: "up" | "down") => {
    setSavedClips((prev) => {
      const index = prev.findIndex((c) => c.id === id);
      if (index === -1) return prev;
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  // Select / Deselect Clips
  const handleToggleSelectClip = (id: string) => {
    setSelectedClipIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = (select: boolean, clipIds?: string[]) => {
    if (clipIds) {
      setSelectedClipIds((prev) => {
        const next = new Set(prev);
        if (select) {
          for (const id of clipIds) next.add(id);
        } else {
          for (const id of clipIds) next.delete(id);
        }
        return next;
      });
      return;
    }
    if (select) {
      setSelectedClipIds(new Set(savedClips.map((c) => c.id)));
    } else {
      setSelectedClipIds(new Set());
    }
  };

  const handleRenameClip = (id: string, newName: string) => {
    const cleanName = cleanClipTitle(newName.trim());
    setSavedClips((prev) =>
      prev.map((c) => (c.id === id ? { ...c, name: cleanName } : c))
    );
  };

  const handleRemoveClip = (id: string) => {
    setSavedClips((prev) => prev.filter((c) => c.id !== id));
    setSelectedClipIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleClearAll = () => {
    setSavedClips([]);
    setSelectedClipIds(new Set());
  };

  const handlePreviewClip = (clip: SavedClipEntry) => {
    setActiveStart(clip.start_time);
    setActiveEnd(clip.end_time);
    setSeekRequest({
      time: clip.start_time,
      autoplay: true,
      nonce: Date.now(),
    });
  };

  const handleLoadClipVideo = useCallback(
    async (clip: SavedClipEntry) => {
      const isSameVideo =
        metadata &&
        ((clip.video_id && metadata.id === clip.video_id) ||
          (clip.video_url && metadata.webpage_url === clip.video_url) ||
          url === clip.video_url);

      if (isSameVideo) {
        setActiveStart(clip.start_time);
        setActiveEnd(clip.end_time);
        setSeekRequest({
          time: clip.start_time,
          autoplay: true,
          nonce: Date.now(),
        });
        return;
      }

      // Load new video
      setUrl(clip.video_url);
      setAnalyzing(true);
      setAnalyzeProgress(4);
      setAnalyzeMessage("Cargando video del clip...");
      setAnalyzeError(null);
      try {
        const data = await invoke<VideoMetadata>("fetch_video_info", {
          url: clip.video_url,
        });
        setMetadata(data);
        setActiveStart(clip.start_time);
        setActiveEnd(clip.end_time);
        setSeekRequest({
          time: clip.start_time,
          autoplay: true,
          nonce: Date.now(),
        });

        setSavedClips((prev) =>
          prev.map((c) => {
            if (
              c.video_url === clip.video_url ||
              (data.webpage_url && c.video_url === data.webpage_url)
            ) {
              return {
                ...c,
                video_url: data.webpage_url || c.video_url,
                video_id: data.id,
                video_title: data.title,
                video_thumbnail: data.thumbnail,
                video_duration: data.duration,
              };
            }
            return c;
          })
        );

        const defaultTrack = data.audio_tracks[0] ?? null;
        if (defaultTrack) {
          setOptions((prev) => ({
            ...prev,
            audio_track_id: defaultTrack.track_id,
            audio_format_id: defaultTrack.format_id,
          }));
        }
      } catch (err) {
        setAnalyzeProgress(0);
        setAnalyzeError(`Error cargando video del clip: ${String(err)}`);
      } finally {
        setAnalyzing(false);
      }
    },
    [metadata, url]
  );

  // Import all chapters as clips
  const handleAddAllChapters = () => {
    if (!metadata || metadata.chapters.length === 0) return;
    const newClips: SavedClipEntry[] = metadata.chapters
      .filter((ch) => ch.end_time > ch.start_time)
      .map((ch) => ({
        id: makeId(),
        name: cleanClipTitle(ch.title),
        start_time: ch.start_time,
        end_time: ch.end_time,
        video_url: metadata.webpage_url || url,
        video_id: metadata.id,
        video_title: metadata.title,
        video_thumbnail: metadata.thumbnail,
        video_duration: metadata.duration,
        precise_cut: preciseCut,
        merge_clips: mergeClips,
        options: { ...options },
      }));

    setSavedClips((prev) => [...prev, ...newClips]);
    setSelectedClipIds(
      (prev) => new Set([...prev, ...newClips.map((c) => c.id)])
    );
  };

  // Per-clip fine tuning
  const handleAdjustClipTimes = (
    id: string,
    startDelta: number,
    endDelta: number
  ) => {
    setSavedClips((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const maxDur =
          c.video_duration > 0 ? c.video_duration : Number.POSITIVE_INFINITY;
        const newStart = Math.max(
          0,
          Math.min(maxDur - 0.1, c.start_time + startDelta)
        );
        const newEnd = Math.min(
          maxDur,
          Math.max(newStart + 0.1, c.end_time + endDelta)
        );
        return {
          ...c,
          start_time: newStart,
          end_time: newEnd,
        };
      })
    );
  };

  // Import JSON handler
  const handleImportJson = (
    streamUrl: string | null,
    importedClips: Array<{ title: string; start: number; end: number; notes?: string }>,
    replace: boolean
  ) => {
    const trimmedStreamUrl = streamUrl && streamUrl.trim().length > 0 ? streamUrl.trim() : null;

    let targetUrl: string;
    let targetId: string;
    let targetTitle: string;
    let targetThumb: string;
    let targetDur: number;

    if (trimmedStreamUrl) {
      targetUrl = trimmedStreamUrl;
      // Check if current metadata is already for this exact stream URL
      const isAlreadyLoaded =
        metadata &&
        (metadata.webpage_url === trimmedStreamUrl || url === trimmedStreamUrl);

      if (isAlreadyLoaded) {
        targetId = metadata.id;
        targetTitle = metadata.title;
        targetThumb = metadata.thumbnail;
        targetDur = metadata.duration;
      } else {
        targetId = trimmedStreamUrl;
        targetTitle = "Cargando info del stream...";
        targetThumb = "";
        targetDur = 0;
        setUrl(trimmedStreamUrl);
        void handleAnalyze(trimmedStreamUrl);
      }
    } else {
      targetUrl = metadata?.webpage_url || url;
      targetId = metadata?.id || "video";
      targetTitle = metadata?.title || "Stream";
      targetThumb = metadata?.thumbnail || "";
      targetDur = metadata?.duration || 0;
    }

    const newEntries: SavedClipEntry[] = importedClips.map((c) => ({
      id: makeId(),
      name: cleanClipTitle(c.title),
      start_time: c.start,
      end_time: c.end,
      notes: c.notes,
      selected: true,
      video_url: targetUrl,
      video_id: targetId,
      video_title: targetTitle,
      video_thumbnail: targetThumb,
      video_duration: targetDur,
      precise_cut: preciseCut,
      merge_clips: mergeClips,
      options: { ...options },
    }));

    if (replace) {
      setSavedClips(newEntries);
      setSelectedClipIds(new Set(newEntries.map((c) => c.id)));
    } else {
      setSavedClips((prev) => [...prev, ...newEntries]);
      setSelectedClipIds((prev) => new Set([...prev, ...newEntries.map((c) => c.id)]));
    }
  };

  // Direct paste JSON from clipboard handler
  const handleDirectPasteJson = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        setIsImportJsonOpen(true);
        return;
      }
      const res = parseClipGenJson(text);
      if (res.success && res.clips.length > 0) {
        setPasteConfirmData({
          streamUrl: res.streamUrl,
          clips: res.clips,
        });
      } else {
        setIsImportJsonOpen(true);
      }
    } catch {
      setIsImportJsonOpen(true);
    }
  };

  // Direct timeline drag adjustment for saved clips
  const handleUpdateClipTimes = (
    id: string,
    newStart: number,
    newEnd: number
  ) => {
    setSavedClips((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              start_time: Math.max(0, newStart),
              end_time: Math.max(newStart + 0.1, newEnd),
            }
          : c
      )
    );
  };

  // Copy AI Prompt handler
  const handleCopyAiPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT_TEMPLATE);
    } catch {
      // Fallback
    }
  }, []);

  // Export resolution preset change
  const handleExportQualityPresetChange = useCallback(
    (newPreset: ManualDownloadOptions["quality_preset"]) => {
      setOptions((prev) => ({ ...prev, quality_preset: newPreset }));
      setSavedClips((prev) =>
        prev.map((c) => ({
          ...c,
          options: {
            ...c.options,
            quality_preset: newPreset,
          },
        }))
      );
    },
    []
  );

  // Export selected clips
  const handleExportSelected = async () => {
    const clipsToExport = savedClips.filter((c) => selectedClipIds.has(c.id));
    if (clipsToExport.length === 0) return;

    // Clear finished/errored/cancelled banners before launching a new export
    setJobs((prev) =>
      prev.filter(
        (j) =>
          j.status === "downloading" ||
          j.status === "cutting" ||
          j.status === "merging" ||
          j.status === "queued"
      )
    );

    const requests = buildBatchRequests(
      clipsToExport,
      options.output_dir,
      marginBefore,
      marginAfter,
      filenameFormat,
      clipStartIndex,
      preciseCut,
      mergeClips,
      options
    );
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

  const handleCancelJob = async (jobId: string) => {
    try {
      await invoke("cancel_job", { jobId });
      setJobs((prev) =>
        prev.map((j) =>
          j.job_id === jobId ? { ...j, status: "cancelled" } : j
        )
      );
    } catch (err) {
      console.error("Error cancelando trabajo:", err);
    }
  };

  const handleDismissJob = useCallback((jobId?: string) => {
    setJobs((prev) =>
      jobId
        ? prev.filter((j) => j.job_id !== jobId)
        : prev.filter(
            (j) =>
              j.status === "downloading" ||
              j.status === "cutting" ||
              j.status === "merging" ||
              j.status === "queued"
          )
    );
  }, []);

  // Active or latest job for the progress bar
  const latestJob = jobs[0] ?? null;

  const transcriptionMatchesMetadata = isUrlMatchingMetadata(url, metadata);
  const transcriptionStreamUrl = transcriptionMatchesMetadata
    ? metadata?.webpage_url || url.trim()
    : url.trim();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#09090B] text-slate-100 select-none">
      {/* ── 1. Top Bar (Custom Drag Region Header & Window Controls) ── */}
      <TitleBar
        url={url}
        onUrlChange={setUrl}
        onAnalyze={handleAnalyze}
        analyzing={analyzing}
        binaryStatus={binaryStatus}
        onOpenSettings={() => openSettingsAtTab("export")}
        onOpenEngines={() => openSettingsAtTab("engines")}
        error={analyzeError}
        onDismissError={() => setAnalyzeError(null)}
        onOpenTranscription={() => setIsTranscriptionOpen(true)}
        onCopyAiPrompt={handleCopyAiPrompt}
      />

      {/* ── 2. Main Modular Workspace (70% Visor / 30% Queue) ── */}
      <main className="flex flex-1 min-h-0 w-full gap-3 p-3 overflow-hidden">
        {/* Left Panel: Visor & Línea de Tiempo (70%) */}
        <VisorPanel
          metadata={metadata}
          clips={currentVideoClips}
          allClips={savedClips}
          clipStartIndex={clipStartIndex}
          activeStart={activeStart}
          activeEnd={activeEnd}
          onActiveRangeChange={(s, e) => {
            setActiveStart(s);
            setActiveEnd(e);
          }}
          onAddClip={handleAddClip}
          seekRequest={seekRequest}
          selectedAudioTrackId={options.audio_track_id}
          onSelectAudioTrack={(trackId) =>
            setOptions((prev) => ({ ...prev, audio_track_id: trackId }))
          }
          onUpdateClipTimes={handleUpdateClipTimes}
          isAnalyzing={analyzing}
          analyzeProgress={analyzeProgress}
          analyzeMessage={analyzeMessage}
        />

        {/* Right Panel: Cola de Clips & Exportación (30%) */}
        <ClipQueuePanel
          clips={savedClips}
          currentVideoId={metadata?.id ?? null}
          currentVideoUrl={metadata?.webpage_url ?? null}
          selectedClipIds={selectedClipIds}
          onToggleSelectClip={handleToggleSelectClip}
          onSelectAll={handleSelectAll}
          onRenameClip={handleRenameClip}
          onRemoveClip={handleRemoveClip}
          onClearAll={handleClearAll}
          onPreviewClip={handlePreviewClip}
          onLoadClipVideo={handleLoadClipVideo}
          preciseCut={preciseCut}
          onTogglePreciseCut={setPreciseCut}
          mergeClips={mergeClips}
          onToggleMergeClips={setMergeClips}
          outputDir={options.output_dir}
          onPickFolder={handlePickFolder}
          onOpenFolder={handleOpenFolder}
          onExportSelected={handleExportSelected}
          activeJob={latestJob}
          onCancelJob={handleCancelJob}
          onDismissJob={handleDismissJob}
          chapters={metadata?.chapters ?? []}
          onAddAllChapters={handleAddAllChapters}
          marginBefore={marginBefore}
          onMarginBeforeChange={setMarginBefore}
          marginAfter={marginAfter}
          onMarginAfterChange={setMarginAfter}
          onAdjustClipTimes={handleAdjustClipTimes}
          onMoveClip={handleMoveClip}
          onMoveClipToNumber={handleMoveClipToNumber}
          filenameFormat={filenameFormat}
          onFilenameFormatChange={setFilenameFormat}
          onOpenImportJson={() => setIsImportJsonOpen(true)}
          onOpenPasteJson={handleDirectPasteJson}
          clipStartIndex={clipStartIndex}
          onClipStartIndexChange={handleClipStartIndexChange}
          qualityPreset={options.quality_preset}
          onQualityPresetChange={handleExportQualityPresetChange}
        />
      </main>

      {/* ── 3. Settings & Engine Config Modal ── */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        initialTab={settingsInitialTab}
        options={options}
        onOptionsChange={handleOptionsChange}
        onPickFolder={handlePickFolder}
        onOpenFolder={handleOpenFolder}
        binaryStatus={binaryStatus}
        checkingUpdates={checkingUpdates}
        updatingBinaries={updatingBinaries}
        onCheckUpdates={checkUpdatesOnly}
        onInstallUpdates={installPendingUpdates}
        binaryProgress={binaryProgress}
        metadata={metadata}
      />

      {/* ── 4. Import JSON Modal (Manual File / Text) ── */}
      <ImportJsonModal
        isOpen={isImportJsonOpen}
        onClose={() => setIsImportJsonOpen(false)}
        onImport={handleImportJson}
        onCopyAiPrompt={handleCopyAiPrompt}
      />

      {/* ── 5. Paste Confirm Modal (Direct Clipboard Extraction) ── */}
      <PasteConfirmModal
        isOpen={Boolean(pasteConfirmData)}
        streamUrl={pasteConfirmData?.streamUrl ?? null}
        clips={pasteConfirmData?.clips ?? []}
        onConfirm={(replace) => {
          if (pasteConfirmData) {
            handleImportJson(
              pasteConfirmData.streamUrl,
              pasteConfirmData.clips,
              replace
            );
          }
          setPasteConfirmData(null);
        }}
        onClose={() => setPasteConfirmData(null)}
      />

      {/* ── 6. Transcription & Audio Peak Detection Modal ── */}
      <TranscriptionModal
        isOpen={isTranscriptionOpen}
        onClose={() => setIsTranscriptionOpen(false)}
        streamUrl={transcriptionStreamUrl}
        onStreamUrlChange={setUrl}
        videoTitle={transcriptionMatchesMetadata ? metadata?.title || "" : ""}
        outputDir={options.output_dir}
        hasMetadata={transcriptionMatchesMetadata}
        activeStart={transcriptionMatchesMetadata ? activeStart : undefined}
        activeEnd={transcriptionMatchesMetadata ? activeEnd : undefined}
      />
    </div>
  );
}

export default App;
