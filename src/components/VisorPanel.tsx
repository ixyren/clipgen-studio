import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Hls from "hls.js";
import { motion } from "framer-motion";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Repeat,
  StopCircle,
  Volume2,
  VolumeX,
  MapPin,
  Flag,
  Plus,
  Layers,
  Film,
  Loader2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Pin,
} from "lucide-react";
import type { SavedClipEntry, VideoMetadata } from "../types";
import { formatTimeShort, formatTimecode, cleanClipTitle } from "../utils/time";

type PlayerSourceMode = "mp4" | "webm" | "embed";

type DragMode =
  | "playhead"
  | "start"
  | "end"
  | { type: "range-move"; anchorOffset: number; rangeLen: number }
  | { type: "clip-start"; clipId: string; end: number }
  | { type: "clip-end"; clipId: string; start: number }
  | null;

interface VisorPanelProps {
  metadata: VideoMetadata | null;
  clips: SavedClipEntry[];
  allClips?: SavedClipEntry[];
  activeStart: number;
  activeEnd: number;
  onActiveRangeChange: (start: number, end: number) => void;
  onAddClip: (name: string, start: number, end: number, insertAtNumber?: number) => void;
  seekRequest: { time: number; autoplay?: boolean; nonce: number } | null;
  selectedAudioTrackId: string | null;
  onSelectAudioTrack?: (trackId: string) => void;
  onUpdateClipTimes?: (clipId: string, newStart: number, newEnd: number) => void;
  clipStartIndex?: number;
  isAnalyzing?: boolean;
  analyzeProgress?: number;
  analyzeMessage?: string;
}

const CLIP_ACCENT_COLORS = [
  "bg-indigo-500/30 border-indigo-400/80 text-indigo-200",
  "bg-violet-500/30 border-violet-400/80 text-violet-200",
  "bg-cyan-500/30 border-cyan-400/80 text-cyan-200",
  "bg-emerald-500/30 border-emerald-400/80 text-emerald-200",
  "bg-amber-500/30 border-amber-400/80 text-amber-200",
  "bg-pink-500/30 border-pink-400/80 text-pink-200",
];

const ZOOM_PRESETS = [1, 2, 5, 10, 25, 50, 100, 250, 500];

function isHlsUrl(url: string | null | undefined): url is string {
  return Boolean(url && url.includes(".m3u8"));
}

function getTickInterval(viewDuration: number): number {
  if (viewDuration > 7200) return 1800; // 30 min
  if (viewDuration > 3600) return 600; // 10 min
  if (viewDuration > 1800) return 300; // 5 min
  if (viewDuration > 600) return 60; // 1 min
  if (viewDuration > 300) return 30; // 30 s
  if (viewDuration > 120) return 15; // 15 s
  if (viewDuration > 60) return 10; // 10 s
  if (viewDuration > 20) return 5; // 5 s
  if (viewDuration > 10) return 2; // 2 s
  if (viewDuration > 4) return 1; // 1 s
  if (viewDuration > 2) return 0.5; // 0.5 s
  return 0.2; // 0.2 s
}

function computeCenteredViewStart(t: number, dur: number, z: number): number {
  const vDur = dur / Math.max(1, z);
  const maxStart = Math.max(0, dur - vDur);
  return Math.max(0, Math.min(maxStart, t - vDur / 2));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function computeScrubGain(
  velPxPerSec: number,
  isPlayhead: boolean,
  slowPrecision: boolean
): number {
  if (slowPrecision) {
    const fineT = smoothstep(clamp01((velPxPerSec - 40) / 900));
    return 0.08 + fineT * 0.20;
  }
  if (!isPlayhead) {
    return 1.0;
  }
  if (velPxPerSec < 320) {
    return 0.55 + smoothstep(clamp01(velPxPerSec / 320)) * 0.45;
  }
  return 1.0 + smoothstep(clamp01((velPxPerSec - 320) / 1400)) * 1.35;
}

export const VisorPanel: React.FC<VisorPanelProps> = ({
  metadata,
  clips,
  allClips,
  activeStart,
  activeEnd,
  onActiveRangeChange,
  onAddClip,
  seekRequest,
  selectedAudioTrackId,
  onSelectAudioTrack,
  onUpdateClipTimes,
  clipStartIndex = 1,
  isAnalyzing = false,
  analyzeProgress = 0,
  analyzeMessage = "Cargando video...",
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const audioHlsRef = useRef<Hls | null>(null);
  const scrubVideoRef = useRef<HTMLVideoElement | null>(null);
  const scrubHlsRef = useRef<Hls | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);

  const [playerMode, setPlayerMode] = useState<PlayerSourceMode>("mp4");
  const [selectedResolution, setSelectedResolution] = useState<string>("480p");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingStream, setIsLoadingStream] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadLabel, setLoadLabel] = useState("Cargando video...");
  const [showLoadOverlay, setShowLoadOverlay] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopSelection, setLoopSelection] = useState(false);
  const [stopAtClipEnd, setStopAtClipEnd] = useState(false);

  // Pro Timeline Zoom & Pan
  const [zoom, setZoom] = useState<number>(1); // 1x to 50x
  const [viewStart, setViewStart] = useState<number>(0); // in seconds
  const [followPlayhead, setFollowPlayhead] = useState(false);
  const [isPanningMinimap, setIsPanningMinimap] = useState(false);
  const [isAltPressed, setIsAltPressed] = useState(false);
  const [isLeftShiftPressed, setIsLeftShiftPressed] = useState(false);
  const [selectedTimelineClipId, setSelectedTimelineClipId] = useState<string | null>(null);

  const [clipNameInput, setClipNameInput] = useState("");
  const [clipNumberInput, setClipNumberInput] = useState("");
  const [hoverTime, setHoverTime] = useState<{ time: number; pct: number } | null>(
    null
  );
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [trimPreview, setTrimPreview] = useState<{
    label: string;
    time: number;
    pct: number;
    seeking: boolean;
    modeHint?: string;
  } | null>(null);
  const [bufferedRanges, setBufferedRanges] = useState<Array<{ start: number; end: number }>>([]);

  const totalQueueCount = allClips ? allClips.length : clips.length;
  const nextDefaultClipNumber = clipStartIndex + totalQueueCount;

  const duration = Math.max(metadata?.duration || 1, 1);
  const maxZoom = Math.max(500, Math.min(2500, Math.ceil(duration / 2)));
  const selectionDuration = Math.max(0, activeEnd - activeStart);

  const updateBufferedRanges = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.buffered || v.buffered.length === 0) {
      setBufferedRanges((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const next: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < v.buffered.length; i++) {
      const start = Math.max(0, v.buffered.start(i));
      const end = Math.min(duration, v.buffered.end(i));
      if (end > start + 0.05) {
        next.push({ start, end });
      }
    }
    setBufferedRanges((prev) => {
      if (
        prev.length === next.length &&
        prev.every(
          (r, idx) =>
            Math.abs(r.start - next[idx].start) < 0.2 &&
            Math.abs(r.end - next[idx].end) < 0.2
        )
      ) {
        return prev;
      }
      return next;
    });
  }, [duration]);

  const totalBufferedSeconds = useMemo(
    () => bufferedRanges.reduce((acc, r) => acc + Math.max(0, r.end - r.start), 0),
    [bufferedRanges]
  );

  // View bounds
  const viewDuration = duration / zoom;
  const viewEnd = Math.min(duration, viewStart + viewDuration);

  // Dedicated ref to restore time ONLY when changing resolution/mode/watchdog reload
  const pendingResolutionRestoreTimeRef = useRef<number | null>(null);

  const wantPlayRef = useRef(false);
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const dragModeRef = useRef<DragMode>(dragMode);
  dragModeRef.current = dragMode;
  const followPlayheadRef = useRef(followPlayhead);
  followPlayheadRef.current = followPlayhead;
  const isLeftShiftPressedRef = useRef(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const scrubPhysicsRef = useRef({
    lastClientX: 0,
    lastMoveTs: 0,
    lastFrameTs: 0,
    smoothedVelocityPxPerSec: 0,
    rawTargetTime: 0,
    targetTime: 0,
    displayTime: 0,
    currentGain: 1,
    hasPointerMoved: false,
  });
  const wasPlayingBeforeDragRef = useRef(false);
  const lastDraggedTimeRef = useRef<number | null>(null);
  const dragOriginPlayheadRef = useRef(0);
  const lastSeekWriteRef = useRef(0);
  const pendingSeekTimerRef = useRef<number | null>(null);
  const queuedSeekTimeRef = useRef<number | null>(null);
  const trimPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPlaybackProgressRef = useRef({
    time: 0,
    at: Date.now(),
    softAttempts: 0,
    hardAttempts: 0,
  });

  const loopRef = useRef({
    enabled: loopSelection,
    stopAtEnd: stopAtClipEnd,
    start: activeStart,
    end: activeEnd,
  });
  loopRef.current = {
    enabled: loopSelection,
    stopAtEnd: stopAtClipEnd,
    start: activeStart,
    end: activeEnd,
  };

  const isLoopSeekingRef = useRef(false);
  const lastStopCheckTimeRef = useRef(0);
  const loadTargetRef = useRef(0);
  const loadCeilingRef = useRef(95);
  const loadDisplayRef = useRef(0);
  const loadPhaseRef = useRef<"idle" | "initial" | "stream" | "completing">("idle");
  const loadHideTimerRef = useRef<number | null>(null);
  const prevMetadataRef = useRef<VideoMetadata | null>(metadata);
  const awaitingInitialStreamRef = useRef(false);

  // Reset zoom, pan & playback state when metadata changes
  useEffect(() => {
    setZoom(1);
    setViewStart(0);
    setFollowPlayhead(false);
    followPlayheadRef.current = false;
    setSelectedTimelineClipId(null);
    setReloadNonce(0);
    setTrimPreview(null);
    setBufferedRanges([]);
    wantPlayRef.current = false;
    pendingResolutionRestoreTimeRef.current = null;
    queuedSeekTimeRef.current = null;
    lastStopCheckTimeRef.current = 0;
    lastPlaybackProgressRef.current = {
      time: 0,
      at: Date.now(),
      softAttempts: 0,
      hardAttempts: 0,
    };
  }, [metadata?.id, metadata?.duration]);

  // Sync mode and default resolution based on metadata
  useEffect(() => {
    if (!metadata) return;
    if (metadata.preview_stream_url) {
      setPlayerMode("mp4");
    } else if (metadata.preview_webm_url) {
      setPlayerMode("webm");
    } else {
      setPlayerMode("embed");
    }

    if (metadata.preview_resolutions && metadata.preview_resolutions.length > 0) {
      const has480 = metadata.preview_resolutions.some((r) => r.label === "480p");
      const has720 = metadata.preview_resolutions.some((r) => r.label === "720p");
      if (has480) {
        setSelectedResolution("480p");
      } else if (has720) {
        setSelectedResolution("720p");
      } else {
        setSelectedResolution(metadata.preview_resolutions[0].label);
      }
    } else {
      setSelectedResolution("480p");
    }

    setStreamError(false);
    setCurrentTime(0);
    setIsPlaying(false);
  }, [metadata?.id, metadata?.preview_stream_url, metadata?.preview_webm_url]);

  const activeResOption = metadata?.preview_resolutions?.find(
    (r) => r.label === selectedResolution
  );

  const activeStreamUrl =
    playerMode === "mp4"
      ? activeResOption?.mp4_url || activeResOption?.webm_url || metadata?.preview_stream_url
      : playerMode === "webm"
      ? activeResOption?.webm_url || activeResOption?.mp4_url || metadata?.preview_webm_url
      : null;

  const activeAudioTrack =
    metadata?.audio_tracks.find((t) => t.track_id === selectedAudioTrackId) ??
    metadata?.audio_tracks[0] ??
    null;
  const activeAudioUrl =
    activeAudioTrack?.preview_url ?? metadata?.preview_audio_url;
  const hasAudioTrack = playerMode !== "embed" && Boolean(activeAudioUrl);
  const hasAudioTrackRef = useRef(hasAudioTrack);
  hasAudioTrackRef.current = hasAudioTrack;

  // Dedicated low-resolution stream (prefer 480p -> 360p -> lowest) for fast mini-tooltip scrubbing
  const scrubStreamChoice = useMemo(() => {
    if (!metadata || playerMode === "embed") {
      return { url: null as string | null, label: "" };
    }
    const list = metadata.preview_resolutions || [];
    const pickUrl = (r?: { mp4_url?: string | null; webm_url?: string | null }) =>
      playerMode === "webm"
        ? r?.webm_url || r?.mp4_url || null
        : r?.mp4_url || r?.webm_url || null;

    const r480 = list.find((r) => r.label === "480p" && pickUrl(r));
    if (r480) return { url: pickUrl(r480), label: "480p" };

    const r360 = list.find((r) => r.label === "360p" && pickUrl(r));
    if (r360) return { url: pickUrl(r360), label: "360p" };

    const lowest = [...list]
      .filter((r) => Boolean(pickUrl(r)))
      .sort((a, b) => a.height - b.height)[0];
    if (lowest) return { url: pickUrl(lowest), label: lowest.label };

    const fallback = metadata.preview_stream_url || metadata.preview_webm_url || null;
    return { url: fallback, label: fallback ? "SD" : "" };
  }, [metadata, playerMode]);
  const scrubStreamUrl = scrubStreamChoice.url;
  const scrubResLabel = scrubStreamChoice.label;

  const syncMediaSettings = useCallback(() => {
    const rate = playbackRateRef.current;
    const isMuted = mutedRef.current;
    const separateAudio = hasAudioTrackRef.current;
    const v = videoRef.current;
    const a = audioRef.current;
    if (v) {
      v.defaultPlaybackRate = rate;
      if (v.playbackRate !== rate) {
        v.playbackRate = rate;
      }
      v.muted = isMuted || separateAudio;
    }
    if (a) {
      a.defaultPlaybackRate = rate;
      if (a.playbackRate !== rate) {
        a.playbackRate = rate;
      }
      a.muted = isMuted;
    }
  }, []);

  useEffect(() => {
    syncMediaSettings();
  }, [playbackRate, muted, hasAudioTrack, syncMediaSettings]);

  const clearLoadHideTimer = useCallback(() => {
    if (loadHideTimerRef.current !== null) {
      window.clearTimeout(loadHideTimerRef.current);
      loadHideTimerRef.current = null;
    }
  }, []);

  const completeViewportLoading = useCallback(() => {
    clearLoadHideTimer();
    awaitingInitialStreamRef.current = false;
    loadPhaseRef.current = "completing";
    loadTargetRef.current = 100;
    loadCeilingRef.current = 100;
    loadDisplayRef.current = 100;
    setLoadProgress(100);
    setLoadLabel("Listo");
    loadHideTimerRef.current = window.setTimeout(() => {
      loadHideTimerRef.current = null;
      loadPhaseRef.current = "idle";
      loadDisplayRef.current = 0;
      loadTargetRef.current = 0;
      setShowLoadOverlay(false);
      setLoadProgress(0);
    }, 240);
  }, [clearLoadHideTimer]);

  const advanceStreamStage = useCallback(
    (
      stage: "attach" | "manifest" | "frag_loading" | "frag_loaded",
      customLabel?: string
    ) => {
      const isInitial = loadPhaseRef.current === "initial";
      let target = 12;
      let ceiling = 34;
      let label = customLabel || "Cargando video...";

      if (isInitial) {
        if (stage === "attach") {
          target = 82;
          ceiling = 87;
          label = customLabel || "Cargando vista previa...";
        } else if (stage === "manifest") {
          target = 88;
          ceiling = 93;
          label = customLabel || "Cargando buffer...";
        } else if (stage === "frag_loading") {
          target = 91;
          ceiling = 96;
          label = customLabel || "Cargando video...";
        } else {
          target = 96;
          ceiling = 99;
          label = customLabel || "Preparando fotogramas...";
        }
      } else {
        if (stage === "attach") {
          target = 12;
          ceiling = 34;
          label = customLabel || "Cargando video...";
        } else if (stage === "manifest") {
          target = 38;
          ceiling = 68;
          label = customLabel || "Cargando buffer...";
        } else if (stage === "frag_loading") {
          target = 58;
          ceiling = 88;
          label = customLabel || "Descargando segmento...";
        } else {
          target = 88;
          ceiling = 97;
          label = customLabel || "Preparando fotogramas...";
        }
      }

      loadTargetRef.current = Math.max(loadTargetRef.current, target);
      loadCeilingRef.current = Math.max(
        loadTargetRef.current,
        Math.max(loadCeilingRef.current, ceiling)
      );
      setLoadLabel((prev) => {
        if (stage === "attach" && !customLabel && prev.startsWith("Cambiando a ")) {
          return prev;
        }
        return label;
      });
    },
    []
  );

  useEffect(() => {
    if (isAnalyzing) {
      clearLoadHideTimer();
      awaitingInitialStreamRef.current = true;
      if (loadPhaseRef.current !== "initial") {
        loadPhaseRef.current = "initial";
        loadDisplayRef.current = 0;
        loadTargetRef.current = 0;
        setLoadProgress(0);
      }
      const nextCeiling =
        analyzeProgress < 40
          ? 42
          : analyzeProgress < 56
          ? 56
          : analyzeProgress < 68
          ? 68
          : analyzeProgress < 78
          ? 78
          : 84;
      loadTargetRef.current = Math.max(
        loadTargetRef.current,
        Math.min(82, analyzeProgress)
      );
      loadCeilingRef.current = Math.max(loadTargetRef.current, nextCeiling);
      setLoadLabel(analyzeMessage || "Cargando video...");
      setShowLoadOverlay(true);
      return;
    }

    const metadataChanged = prevMetadataRef.current !== metadata;
    prevMetadataRef.current = metadata;

    if (loadPhaseRef.current === "initial") {
      if (!metadataChanged && !isLoadingStream) {
        clearLoadHideTimer();
        awaitingInitialStreamRef.current = false;
        loadPhaseRef.current = "idle";
        loadDisplayRef.current = 0;
        loadTargetRef.current = 0;
        setShowLoadOverlay(false);
        setLoadProgress(0);
      } else if (
        metadataChanged &&
        (!metadata ||
          (!metadata.preview_stream_url && !metadata.preview_webm_url))
      ) {
        completeViewportLoading();
      }
    }
  }, [
    isAnalyzing,
    analyzeProgress,
    analyzeMessage,
    metadata,
    isLoadingStream,
    clearLoadHideTimer,
    completeViewportLoading,
  ]);

  useEffect(() => {
    if (isAnalyzing) return;

    if (isLoadingStream) {
      clearLoadHideTimer();
      awaitingInitialStreamRef.current = false;
      if (
        loadPhaseRef.current !== "initial" &&
        loadPhaseRef.current !== "stream"
      ) {
        loadPhaseRef.current = "stream";
        loadDisplayRef.current = 0;
        loadTargetRef.current = 10;
        loadCeilingRef.current = 45;
        setLoadProgress(0);
        setLoadLabel((prev) =>
          prev && prev !== "Listo" ? prev : "Cargando video..."
        );
      }
      setShowLoadOverlay(true);
      return;
    }

    if (loadPhaseRef.current === "stream") {
      completeViewportLoading();
    } else if (loadPhaseRef.current === "initial" && Boolean(metadata)) {
      if (!awaitingInitialStreamRef.current) {
        completeViewportLoading();
      } else if (loadHideTimerRef.current === null) {
        loadHideTimerRef.current = window.setTimeout(() => {
          loadHideTimerRef.current = null;
          if (loadPhaseRef.current === "initial") {
            completeViewportLoading();
          }
        }, 350);
      }
    }
  }, [
    isLoadingStream,
    isAnalyzing,
    metadata,
    clearLoadHideTimer,
    completeViewportLoading,
  ]);

  useEffect(() => {
    if (!showLoadOverlay) return;
    let rafId = 0;
    let lastTs = performance.now();
    let lastInt = Math.round(loadDisplayRef.current);

    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

      const phase = loadPhaseRef.current;
      if (phase !== "completing" && phase !== "idle") {
        let cur = loadDisplayRef.current;
        const target = loadTargetRef.current;
        const ceiling = loadCeilingRef.current;

        if (cur < target) {
          cur += (target - cur) * (1 - Math.exp(-dt * 9));
        } else if (cur < ceiling) {
          cur += (ceiling - cur) * (1 - Math.exp(-dt * 0.65));
        }

        cur = Math.max(0, Math.min(99, cur));
        loadDisplayRef.current = cur;
        const rounded = Math.round(cur);
        if (rounded !== lastInt) {
          lastInt = rounded;
          setLoadProgress(rounded);
        }
      }

      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(rafId);
  }, [showLoadOverlay]);

  useEffect(() => {
    return () => {
      if (pendingSeekTimerRef.current !== null) {
        window.clearTimeout(pendingSeekTimerRef.current);
      }
      if (loadHideTimerRef.current !== null) {
        window.clearTimeout(loadHideTimerRef.current);
      }
    };
  }, []);

  // Clean, synchronized resolution switching (preserves playback intent & speed)
  const handleResolutionChange = (newRes: string) => {
    if (newRes === selectedResolution) return;
    const v = videoRef.current;
    const a = audioRef.current;
    const shouldResume = wantPlayRef.current || Boolean(v && !v.paused);
    wantPlayRef.current = shouldResume;
    pendingResolutionRestoreTimeRef.current = v ? v.currentTime : currentTime;
    if (v) v.pause();
    if (a) a.pause();
    setIsPlaying(false);
    setLoadLabel(`Cambiando a ${newRes}...`);
    setIsLoadingStream(true);
    setSelectedResolution(newRes);
  };

  // Video / HLS Stream Attachment & Cleanup
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v) return;

    // Clean up any existing Hls instance immediately
    if (hlsRef.current) {
      hlsRef.current.stopLoad();
      hlsRef.current.detachMedia();
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    // Immediately pause and stop background audio
    v.pause();
    if (a) a.pause();
    setIsPlaying(false);
    setBufferedRanges([]);

    if (!activeStreamUrl || playerMode === "embed") {
      v.removeAttribute("src");
      v.load();
      setIsLoadingStream(false);
      return;
    }

    setIsLoadingStream(true);
    advanceStreamStage("attach");
    syncMediaSettings();

    if (isHlsUrl(activeStreamUrl)) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          maxBufferHole: 0.5,
          nudgeOffset: 0.2,
          nudgeMaxRetry: 8,
          fragLoadingMaxRetry: 6,
          fragLoadingRetryDelay: 500,
          manifestLoadingMaxRetry: 4,
        });
        hlsRef.current = hls;
        let networkRetries = 0;
        let mediaRetries = 0;
        hls.loadSource(activeStreamUrl);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          syncMediaSettings();
          advanceStreamStage("manifest");
          if (v.readyState >= 2) {
            setIsLoadingStream(false);
          }
          if (pendingResolutionRestoreTimeRef.current !== null) {
            const restoreT = pendingResolutionRestoreTimeRef.current;
            pendingResolutionRestoreTimeRef.current = null;
            v.currentTime = restoreT;
            if (a) a.currentTime = restoreT;
          }
          if (wantPlayRef.current) {
            syncMediaSettings();
            v.play().catch(() => {});
            if (a && hasAudioTrackRef.current) a.play().catch(() => {});
          }
        });
        hls.on(Hls.Events.FRAG_LOADING, () => {
          advanceStreamStage("frag_loading");
        });
        hls.on(Hls.Events.FRAG_LOADED, () => {
          advanceStreamStage("frag_loaded");
        });
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          updateBufferedRanges();
          if (videoRef.current && videoRef.current.readyState >= 2) {
            setIsLoadingStream(false);
          }
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
              networkRetries++;
              hls.startLoad();
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
              mediaRetries++;
              hls.recoverMediaError();
              return;
            }
            setStreamError(true);
            setIsLoadingStream(false);
            setPlayerMode("embed");
          }
        });
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = activeStreamUrl;
        syncMediaSettings();
      }
    } else {
      v.src = activeStreamUrl;
      v.load();
      syncMediaSettings();
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.stopLoad();
        hlsRef.current.detachMedia();
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [
    activeStreamUrl,
    playerMode,
    reloadNonce,
    syncMediaSettings,
    updateBufferedRanges,
    advanceStreamStage,
  ]);

  // Dedicated Audio Track Attachment & Cleanup (supports both direct & HLS audio)
  useEffect(() => {
    const a = audioRef.current;
    if (audioHlsRef.current) {
      audioHlsRef.current.stopLoad();
      audioHlsRef.current.detachMedia();
      audioHlsRef.current.destroy();
      audioHlsRef.current = null;
    }

    if (!a) return;

    if (!hasAudioTrack || !activeAudioUrl) {
      if (a.hasAttribute("src")) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
      return;
    }

    syncMediaSettings();

    if (isHlsUrl(activeAudioUrl) && Hls.isSupported()) {
      const audioHls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
        fragLoadingMaxRetry: 6,
      });
      audioHlsRef.current = audioHls;
      audioHls.loadSource(activeAudioUrl);
      audioHls.attachMedia(a);
      audioHls.on(Hls.Events.MANIFEST_PARSED, () => {
        syncMediaSettings();
        const v = videoRef.current;
        if (v) {
          a.currentTime = v.currentTime;
          if (!v.paused && wantPlayRef.current) {
            a.play().catch(() => {});
          }
        }
      });
    } else {
      a.src = activeAudioUrl;
      a.load();
      syncMediaSettings();
      const v = videoRef.current;
      if (v) {
        a.currentTime = v.currentTime;
      }
    }

    return () => {
      if (audioHlsRef.current) {
        audioHlsRef.current.stopLoad();
        audioHlsRef.current.detachMedia();
        audioHlsRef.current.destroy();
        audioHlsRef.current = null;
      }
    };
  }, [activeAudioUrl, hasAudioTrack, playerMode, metadata?.id, syncMediaSettings]);

  // Dedicated low-resolution scrubber stream attachment (independent of main viewport video)
  useEffect(() => {
    const sv = scrubVideoRef.current;
    if (scrubHlsRef.current) {
      scrubHlsRef.current.stopLoad();
      scrubHlsRef.current.detachMedia();
      scrubHlsRef.current.destroy();
      scrubHlsRef.current = null;
    }

    if (!sv) return;

    if (!scrubStreamUrl || playerMode === "embed") {
      if (sv.hasAttribute("src")) {
        sv.removeAttribute("src");
        sv.load();
      }
      return;
    }

    if (isHlsUrl(scrubStreamUrl) && Hls.isSupported()) {
      const scrubHls = new Hls({
        enableWorker: true,
        autoStartLoad: true,
        maxBufferLength: 4,
        maxMaxBufferLength: 8,
        backBufferLength: 2,
        fragLoadingMaxRetry: 4,
        manifestLoadingMaxRetry: 3,
      });
      scrubHlsRef.current = scrubHls;
      scrubHls.loadSource(scrubStreamUrl);
      scrubHls.attachMedia(sv);
    } else {
      sv.preload = "auto";
      sv.src = scrubStreamUrl;
      sv.load();
    }

    return () => {
      if (scrubHlsRef.current) {
        scrubHlsRef.current.stopLoad();
        scrubHlsRef.current.detachMedia();
        scrubHlsRef.current.destroy();
        scrubHlsRef.current = null;
      }
    };
  }, [scrubStreamUrl, playerMode, metadata?.id]);

  // Draw current decoded frame from low-res scrubber (fallback to main video before first scrub seek)
  const drawTrimPreviewFrame = useCallback((preferMain = false) => {
    const sv = scrubVideoRef.current;
    const v = videoRef.current;
    const canvas = trimPreviewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (preferMain && v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      return;
    }

    if (sv && sv.readyState >= 2 && sv.videoWidth > 0 && sv.videoHeight > 0) {
      ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
      return;
    }

    if (v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    }
  }, []);

  // Serial non-aborting seek queue operating exclusively on the low-res scrubber video
  const flushQueuedSeek = useCallback(() => {
    const sv = scrubVideoRef.current;
    const target = queuedSeekTimeRef.current;
    if (!sv || target === null) return;

    if (sv.readyState < 1) {
      if (scrubHlsRef.current) {
        scrubHlsRef.current.startLoad(target);
      }
      if (pendingSeekTimerRef.current === null) {
        pendingSeekTimerRef.current = window.setTimeout(() => {
          pendingSeekTimerRef.current = null;
          flushQueuedSeek();
        }, 60);
      }
      return;
    }

    if (sv.seeking) {
      if (pendingSeekTimerRef.current === null) {
        pendingSeekTimerRef.current = window.setTimeout(() => {
          pendingSeekTimerRef.current = null;
          flushQueuedSeek();
        }, 60);
      }
      return;
    }

    const elapsed = Date.now() - lastSeekWriteRef.current;
    if (elapsed < 35) {
      if (pendingSeekTimerRef.current !== null) {
        window.clearTimeout(pendingSeekTimerRef.current);
      }
      pendingSeekTimerRef.current = window.setTimeout(() => {
        pendingSeekTimerRef.current = null;
        flushQueuedSeek();
      }, Math.max(10, 35 - elapsed));
      return;
    }

    if (pendingSeekTimerRef.current !== null) {
      window.clearTimeout(pendingSeekTimerRef.current);
      pendingSeekTimerRef.current = null;
    }
    queuedSeekTimeRef.current = null;
    lastSeekWriteRef.current = Date.now();

    if (Math.abs(sv.currentTime - target) > 0.02) {
      if (scrubHlsRef.current) {
        scrubHlsRef.current.startLoad(target);
      }
      sv.currentTime = target;
      setTrimPreview((prev) => (prev ? { ...prev, seeking: true } : prev));
    } else {
      drawTrimPreviewFrame();
      setTrimPreview((prev) => (prev ? { ...prev, seeking: false } : prev));
    }
  }, [drawTrimPreviewFrame]);

  const isVideoBufferedAt = (v: HTMLVideoElement, t: number): boolean => {
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= t + 0.15 && v.buffered.end(i) >= t - 0.15) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  };

  // Seek handler (instant UI update + low-res scrubber queue during drag; main viewport updates on commit)
  const seekTo = useCallback(
    (time: number, throttle = false) => {
      const clamped = Math.max(0, Math.min(time, duration));
      lastStopCheckTimeRef.current = clamped;
      setCurrentTime(clamped);

      if (!throttle) {
        if (followPlayheadRef.current) {
          setViewStart(
            computeCenteredViewStart(clamped, durationRef.current, zoomRef.current)
          );
        }
        if (pendingSeekTimerRef.current !== null) {
          window.clearTimeout(pendingSeekTimerRef.current);
          pendingSeekTimerRef.current = null;
        }
        queuedSeekTimeRef.current = null;
        lastSeekWriteRef.current = Date.now();
        const v = videoRef.current;
        const a = audioRef.current;
        const prevMainTime = v ? v.currentTime : clamped;
        const needsLoadIndicator = Boolean(
          v && Math.abs(prevMainTime - clamped) > 0.25 && !isVideoBufferedAt(v, clamped)
        );
        if (v) {
          v.currentTime = clamped;
        }
        if (a && !dragModeRef.current && Math.abs(a.currentTime - clamped) > 0.08) {
          a.currentTime = clamped;
        }
        if (needsLoadIndicator) {
          setLoadLabel("Cargando video...");
          setIsLoadingStream(true);
        }
        return;
      }

      queuedSeekTimeRef.current = clamped;
      flushQueuedSeek();
    },
    [duration, flushQueuedSeek]
  );

  const handleToggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      syncMediaSettings();
      return next;
    });
  }, [syncMediaSettings]);

  const handleRateChange = useCallback(
    (rate: number) => {
      playbackRateRef.current = rate;
      setPlaybackRate(rate);
      syncMediaSettings();
    },
    [syncMediaSettings]
  );

  // Handle external seek requests
  useEffect(() => {
    if (!seekRequest) return;
    seekTo(seekRequest.time, false);
    if (seekRequest.autoplay) {
      wantPlayRef.current = true;
      syncMediaSettings();
      const v = videoRef.current;
      const a = audioRef.current;
      if (v) {
        v.play().catch(() => {});
        setIsPlaying(true);
      }
      if (a && hasAudioTrack) {
        a.play().catch(() => {});
      }
    }
  }, [seekRequest, seekTo, hasAudioTrack, syncMediaSettings]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v) return;

    if (v.paused) {
      const { stopAtEnd, start, end } = loopRef.current;
      if (
        stopAtEnd &&
        end > start + 0.1 &&
        v.currentTime >= end - 0.15 &&
        v.currentTime <= end + 0.25
      ) {
        v.currentTime = start;
        if (a && hasAudioTrack) {
          a.currentTime = start;
        }
        setCurrentTime(start);
        lastStopCheckTimeRef.current = start;
      } else {
        lastStopCheckTimeRef.current = v.currentTime;
      }
      wantPlayRef.current = true;
      syncMediaSettings();
      lastPlaybackProgressRef.current = {
        time: v.currentTime,
        at: Date.now(),
        softAttempts: 0,
        hardAttempts: 0,
      };
      if (a && hasAudioTrackRef.current) {
        a.currentTime = v.currentTime;
      }
      const p1 = v.play();
      const p2 = (a && hasAudioTrackRef.current) ? a.play() : Promise.resolve();
      Promise.allSettled([p1, p2]).then((results) => {
        const vOk = results[0].status === "fulfilled";
        if (vOk) {
          syncMediaSettings();
          setIsPlaying(true);
        } else {
          setIsPlaying(false);
        }
      });
    } else {
      wantPlayRef.current = false;
      v.pause();
      if (a) a.pause();
      setIsPlaying(false);
    }
  }, [hasAudioTrack, syncMediaSettings]);

  const stepTime = useCallback(
    (seconds: number) => {
      const v = videoRef.current;
      const current = v ? v.currentTime : currentTime;
      seekTo(current + seconds, false);
    },
    [currentTime, seekTo]
  );

  const markInAtCurrent = useCallback(() => {
    const v = videoRef.current;
    const rawT = v ? v.currentTime : currentTime;
    const t = Math.max(0, Math.min(duration, rawT));
    if (t >= activeEnd - 0.1) {
      const newStart = Math.min(t, Math.max(0, duration - 0.1));
      const newEnd = Math.min(duration, Math.max(newStart + 0.1, newStart + 15));
      onActiveRangeChange(newStart, newEnd);
    } else {
      onActiveRangeChange(t, activeEnd);
    }
  }, [currentTime, activeEnd, duration, onActiveRangeChange]);

  const markOutAtCurrent = useCallback(() => {
    const v = videoRef.current;
    const rawT = v ? v.currentTime : currentTime;
    const t = Math.max(0, Math.min(duration, rawT));
    if (t <= activeStart + 0.1) {
      const newEnd = Math.max(Math.min(duration, 0.1), t);
      const newStart = Math.max(0, Math.min(newEnd - 0.1, newEnd - 15));
      onActiveRangeChange(newStart, newEnd);
    } else {
      onActiveRangeChange(activeStart, t);
    }
  }, [currentTime, activeStart, duration, onActiveRangeChange]);

  const handleAddCurrentClip = useCallback(() => {
    if (!metadata) return;
    const name = clipNameInput.trim() || "Clip";
    const rawNum = clipNumberInput.trim();
    const parsedNum = rawNum !== "" ? Number.parseInt(rawNum, 10) : NaN;
    const insertAtNumber = Number.isFinite(parsedNum) ? parsedNum : undefined;
    onAddClip(name, activeStart, activeEnd, insertAtNumber);
    setClipNameInput("");
    setClipNumberInput("");
  }, [metadata, clipNameInput, clipNumberInput, activeStart, activeEnd, onAddClip]);

  // Toggle loop with immediate jump into selection (mutually exclusive with stopAtClipEnd)
  const handleToggleLoop = useCallback(() => {
    const next = !loopSelection;
    setLoopSelection(next);
    if (next) {
      setStopAtClipEnd(false);
      if (activeEnd > activeStart) {
        const v = videoRef.current;
        const a = audioRef.current;
        if (v && (v.currentTime < activeStart || v.currentTime >= activeEnd)) {
          v.currentTime = activeStart;
          if (a) a.currentTime = activeStart;
          setCurrentTime(activeStart);
          lastStopCheckTimeRef.current = activeStart;
          wantPlayRef.current = true;
          syncMediaSettings();
          v.play().catch(() => {});
          if (a && hasAudioTrack) a.play().catch(() => {});
          setIsPlaying(true);
        }
      }
    }
  }, [loopSelection, activeStart, activeEnd, hasAudioTrack, syncMediaSettings]);

  // Toggle automatic pause at active clip end (mutually exclusive with loopSelection)
  const handleToggleStopAtEnd = useCallback(() => {
    const next = !stopAtClipEnd;
    setStopAtClipEnd(next);
    if (next) {
      setLoopSelection(false);
      const v = videoRef.current;
      if (v) {
        lastStopCheckTimeRef.current = v.currentTime;
      }
    }
  }, [stopAtClipEnd]);

  // Global Keyboard shortcuts, Alt & Left Shift key tracking
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" || e.altKey) {
        setIsAltPressed(true);
      }
      if (e.code === "ShiftLeft") {
        isLeftShiftPressedRef.current = true;
        setIsLeftShiftPressed(true);
      }

      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        if (
          e.key === "Enter" &&
          (target.id === "clip-name-input" || target.id === "clip-position-input")
        ) {
          e.preventDefault();
          handleAddCurrentClip();
        }
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        markInAtCurrent();
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        markOutAtCurrent();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleAddCurrentClip();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepTime(e.shiftKey ? -5 : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepTime(e.shiftKey ? 5 : 1);
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        handleToggleLoop();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" || !e.altKey) {
        setIsAltPressed(false);
      }
      if (e.code === "ShiftLeft" || !e.shiftKey) {
        isLeftShiftPressedRef.current = false;
        setIsLeftShiftPressed(false);
      }
    };

    const handleWindowBlur = () => {
      setIsAltPressed(false);
      isLeftShiftPressedRef.current = false;
      setIsLeftShiftPressed(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [
    togglePlay,
    markInAtCurrent,
    markOutAtCurrent,
    handleAddCurrentClip,
    stepTime,
    handleToggleLoop,
  ]);

  // High-precision end-of-clip stop check (shared by handleTimeUpdate & requestAnimationFrame)
  const checkStopAtClipEnd = useCallback((v: HTMLVideoElement): boolean => {
    if (dragModeRef.current || v.paused || v.seeking) return false;
    const { enabled, stopAtEnd, start, end } = loopRef.current;
    const t = v.currentTime;
    const prevT = lastStopCheckTimeRef.current;

    if (!stopAtEnd || enabled || end <= start + 0.1) {
      lastStopCheckTimeRef.current = t;
      return false;
    }

    const reachedEnd =
      (t >= end - 0.03 && t <= end + 0.5) ||
      (prevT < end - 0.03 && t >= end - 0.03 && t <= end + 1.5);

    if (reachedEnd) {
      wantPlayRef.current = false;
      v.pause();
      const a = audioRef.current;
      if (a) a.pause();
      if (Math.abs(v.currentTime - end) > 0.01) {
        v.currentTime = end;
      }
      if (a && hasAudioTrackRef.current && Math.abs(a.currentTime - end) > 0.01) {
        a.currentTime = end;
      }
      lastStopCheckTimeRef.current = end;
      setCurrentTime(end);
      setIsPlaying(false);
      return true;
    }

    lastStopCheckTimeRef.current = t;
    return false;
  }, []);

  useEffect(() => {
    if (!isPlaying || (!stopAtClipEnd && !followPlayhead) || playerMode === "embed") {
      return;
    }
    let rafId = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        if (stopAtClipEnd && checkStopAtClipEnd(v)) {
          return;
        }
        const t = v.currentTime;
        setCurrentTime(t);
        if (followPlayheadRef.current && !dragModeRef.current) {
          const targetStart = computeCenteredViewStart(
            t,
            durationRef.current,
            zoomRef.current
          );
          setViewStart((prev) =>
            Math.abs(prev - targetStart) > 0.0005 ? targetStart : prev
          );
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying, stopAtClipEnd, followPlayhead, playerMode, checkStopAtClipEnd]);

  // Video time update, speed/drift guard & Loop check
  const handleTimeUpdate = () => {
    if (dragModeRef.current) {
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (checkStopAtClipEnd(v)) return;
    const t = v.currentTime;
    setCurrentTime(t);
    if (followPlayheadRef.current && !dragModeRef.current) {
      const targetStart = computeCenteredViewStart(
        t,
        durationRef.current,
        zoomRef.current
      );
      setViewStart((prev) =>
        Math.abs(prev - targetStart) > 0.0005 ? targetStart : prev
      );
    }
    updateBufferedRanges();

    if (Math.abs(t - lastPlaybackProgressRef.current.time) > 0.03) {
      lastPlaybackProgressRef.current = {
        time: t,
        at: Date.now(),
        softAttempts: 0,
        hardAttempts: 0,
      };
      setIsLoadingStream(false);
    }

    const expectedRate = playbackRateRef.current;
    if (v.playbackRate !== expectedRate) {
      v.playbackRate = expectedRate;
    }

    const a = audioRef.current;
    if (a && hasAudioTrackRef.current) {
      if (!v.paused && !dragModeRef.current) {
        const diff = a.currentTime - t;
        const absDiff = Math.abs(diff);

        if (absDiff > 0.40) {
          if (!a.seeking) {
            a.currentTime = t;
          }
        } else if (absDiff > 0.04) {
          if (diff < 0) {
            a.playbackRate = expectedRate * 1.08;
          } else {
            a.playbackRate = expectedRate * 0.92;
          }
        } else {
          if (a.playbackRate !== expectedRate) {
            a.playbackRate = expectedRate;
          }
        }

        if (a.paused && wantPlayRef.current && v.readyState >= 3) {
          a.play().catch(() => {});
        }
      }
    }

    const { enabled, start, end } = loopRef.current;
    if (enabled && end > start + 0.1) {
      if (t >= end - 0.05 && !isLoopSeekingRef.current) {
        isLoopSeekingRef.current = true;
        v.currentTime = start;
        if (a) a.currentTime = start;
        if (v.paused && wantPlayRef.current) {
          syncMediaSettings();
          v.play().catch(() => {});
          if (a && hasAudioTrack) a.play().catch(() => {});
        }
        setTimeout(() => {
          isLoopSeekingRef.current = false;
        }, 200);
      }
    }
  };

  // Automatic stall recovery watchdog when stream stalls mid-playback
  useEffect(() => {
    if (!metadata || playerMode === "embed") return;
    const interval = window.setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      if (
        !wantPlayRef.current ||
        dragModeRef.current ||
        isLoopSeekingRef.current ||
        v.ended
      ) {
        return;
      }
      const stalledMs = Date.now() - lastPlaybackProgressRef.current.at;
      const tracker = lastPlaybackProgressRef.current;
      if (stalledMs >= 3200 && tracker.softAttempts < 2) {
        tracker.softAttempts += 1;
        tracker.at = Date.now();
        syncMediaSettings();
        if (hlsRef.current) {
          hlsRef.current.startLoad(v.currentTime);
        } else {
          const nudge = Math.min(duration - 0.05, Math.max(0, v.currentTime + 0.04));
          v.currentTime = nudge;
          if (audioRef.current && hasAudioTrackRef.current) {
            audioRef.current.currentTime = nudge;
          }
        }
        v.play().catch(() => {});
      } else if (stalledMs >= 3500 && tracker.softAttempts >= 2 && tracker.hardAttempts < 2) {
        tracker.hardAttempts += 1;
        tracker.softAttempts = 0;
        tracker.at = Date.now();
        pendingResolutionRestoreTimeRef.current = v.currentTime;
        setIsLoadingStream(true);
        setReloadNonce((n) => n + 1);
      }
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [metadata?.id, playerMode, duration, syncMediaSettings]);

  // ─── Pro Timeline Zoom & Pan Handlers ───
  const handleZoomChange = useCallback(
    (newZoom: number, centerTime?: number) => {
      const targetZoom = Math.max(1, Math.min(maxZoom, Math.round(newZoom * 10) / 10));
      const locked = followPlayheadRef.current;
      const anchor = locked
        ? currentTime
        : centerTime !== undefined
        ? centerTime
        : currentTime;
      const newVDur = duration / targetZoom;
      const currentRel = locked
        ? 0.5
        : viewDuration > 0
        ? (anchor - viewStart) / viewDuration
        : 0.5;
      const newStart = anchor - currentRel * newVDur;
      setZoom(targetZoom);
      const maxStart = Math.max(0, duration - newVDur);
      setViewStart(Math.max(0, Math.min(maxStart, newStart)));
    },
    [currentTime, duration, maxZoom, viewDuration, viewStart]
  );

  const handlePan = useCallback(
    (secondsDelta: number) => {
      if (followPlayheadRef.current) {
        followPlayheadRef.current = false;
        setFollowPlayhead(false);
      }
      setViewStart((prev) => {
        const vDur = duration / zoom;
        const maxStart = Math.max(0, duration - vDur);
        return Math.max(0, Math.min(maxStart, prev + secondsDelta));
      });
    },
    [duration, zoom]
  );

  const handleFitSelection = useCallback(() => {
    if (followPlayheadRef.current) {
      followPlayheadRef.current = false;
      setFollowPlayhead(false);
    }
    const selDur = Math.max(1, activeEnd - activeStart);
    const paddedDur = selDur * 1.35;
    const targetZoom = Math.max(1, Math.min(maxZoom, duration / paddedDur));
    const newVDur = duration / targetZoom;
    const targetStart = Math.max(0, activeStart - (newVDur - selDur) / 2);
    setZoom(targetZoom);
    const maxStart = Math.max(0, duration - newVDur);
    setViewStart(Math.max(0, Math.min(maxStart, targetStart)));
  }, [activeStart, activeEnd, duration, maxZoom]);

  const handleCenterPlayhead = useCallback(() => {
    const vDur = duration / zoom;
    const targetStart = currentTime - vDur / 2;
    const maxStart = Math.max(0, duration - vDur);
    setViewStart(Math.max(0, Math.min(maxStart, targetStart)));
  }, [currentTime, duration, zoom]);

  const handleToggleFollowPlayhead = useCallback(() => {
    const next = !followPlayhead;
    followPlayheadRef.current = next;
    setFollowPlayhead(next);
    if (next) {
      const targetZoom = zoom <= 1.05 && duration > 5 ? Math.min(maxZoom, 4) : zoom;
      if (targetZoom !== zoom) {
        zoomRef.current = targetZoom;
        setZoom(targetZoom);
      }
      const v = videoRef.current;
      const t = v ? v.currentTime : currentTime;
      setViewStart(computeCenteredViewStart(t, duration, targetZoom));
    }
  }, [followPlayhead, zoom, duration, maxZoom, currentTime]);

  // Minimap Navigation Events + Window safety release
  useEffect(() => {
    if (!isPanningMinimap) return;
    const stopPanning = () => setIsPanningMinimap(false);
    window.addEventListener("pointerup", stopPanning);
    window.addEventListener("pointercancel", stopPanning);
    window.addEventListener("blur", stopPanning);
    return () => {
      window.removeEventListener("pointerup", stopPanning);
      window.removeEventListener("pointercancel", stopPanning);
      window.removeEventListener("blur", stopPanning);
    };
  }, [isPanningMinimap]);

  const handleMinimapPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (followPlayheadRef.current) {
      followPlayheadRef.current = false;
      setFollowPlayhead(false);
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickTime = ratio * duration;
    const vDur = duration / zoom;
    const newStart = Math.max(0, Math.min(duration - vDur, clickTime - vDur / 2));
    setViewStart(newStart);
    setIsPanningMinimap(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleMinimapPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanningMinimap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickTime = ratio * duration;
    const vDur = duration / zoom;
    const newStart = Math.max(0, Math.min(duration - vDur, clickTime - vDur / 2));
    setViewStart(newStart);
  };

  const handleMinimapPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsPanningMinimap(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Timeline Dragging with Window-Level Tracking & Magnetic Snapping
  const dragLatestRef = useRef({
    viewStart,
    viewDuration,
    duration,
    activeStart,
    activeEnd,
    currentTime,
    clips,
    onActiveRangeChange,
    onUpdateClipTimes,
    seekTo,
    syncMediaSettings,
  });
  dragLatestRef.current = {
    viewStart,
    viewDuration,
    duration,
    activeStart,
    activeEnd,
    currentTime,
    clips,
    onActiveRangeChange,
    onUpdateClipTimes,
    seekTo,
    syncMediaSettings,
  };

  const pointerClientXToTime = useCallback((clientX: number): number => {
    const el = timelineRef.current;
    if (!el) return currentTime;
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / width));
    return Math.max(0, Math.min(duration, viewStart + ratio * viewDuration));
  }, [currentTime, duration, viewStart, viewDuration]);

  const getDragLabel = (mode: DragMode): string => {
    if (mode === "start") return "Inicio [ I ]";
    if (mode === "end") return "Fin [ O ]";
    if (mode === "playhead") return "Cabezal";
    if (mode && typeof mode === "object") {
      if (mode.type === "range-move") return "Mover rango";
      if (mode.type === "clip-start") return "Inicio clip";
      if (mode.type === "clip-end") return "Fin clip";
    }
    return "Recorte";
  };

  const beginTimelineDrag = useCallback(
    (mode: DragMode, initialTime?: number, startClientX?: number) => {
      const v = videoRef.current;
      const a = audioRef.current;
      dragOriginPlayheadRef.current = currentTime;
      wasPlayingBeforeDragRef.current = Boolean(v && !v.paused);
      if (v && !v.paused) v.pause();
      if (a && !a.paused) a.pause();
      dragModeRef.current = mode;
      setDragMode(mode);

      const now = performance.now();
      const t0 = initialTime ?? currentTime;
      scrubPhysicsRef.current = {
        lastClientX: startClientX ?? 0,
        lastMoveTs: now,
        lastFrameTs: now,
        smoothedVelocityPxPerSec: 0,
        rawTargetTime: t0,
        targetTime: t0,
        displayTime: t0,
        currentGain: 1,
        hasPointerMoved: false,
      };

      const pct0 =
        viewDuration > 0
          ? Math.max(0, Math.min(100, ((t0 - viewStart) / viewDuration) * 100))
          : 0;
      setTrimPreview({
        label: getDragLabel(mode),
        time: t0,
        pct: pct0,
        seeking: Boolean(v?.seeking),
        modeHint: isLeftShiftPressedRef.current
          ? "Shift Izq · Precisión 0.08x"
          : "Shift Izq = Lento",
      });
      requestAnimationFrame(() =>
        drawTrimPreviewFrame(Math.abs((videoRef.current?.currentTime ?? 0) - t0) < 0.5)
      );
      if (scrubHlsRef.current) {
        scrubHlsRef.current.startLoad(t0);
      }
      queuedSeekTimeRef.current = t0;
      flushQueuedSeek();
    },
    [currentTime, drawTrimPreviewFrame, flushQueuedSeek, viewDuration, viewStart]
  );

  useEffect(() => {
    if (!dragMode) return;

    const snapTime = (
      rawT: number,
      rectWidth: number,
      disableSnap: boolean,
      excludeClipId?: string,
      excludeEdge?: "start" | "end"
    ): number => {
      if (disableSnap || rectWidth <= 0) return rawT;
      const { viewDuration: vDur, clips: list } = dragLatestRef.current;
      const threshold = (6 / rectWidth) * vDur;
      let best = rawT;
      let bestDist = threshold;

      const check = (candidate: number) => {
        const d = Math.abs(candidate - rawT);
        if (d <= bestDist) {
          bestDist = d;
          best = candidate;
        }
      };

      check(dragOriginPlayheadRef.current);
      for (const c of list) {
        if (c.id !== excludeClipId || excludeEdge !== "start") {
          check(c.start_time);
        }
        if (c.id !== excludeClipId || excludeEdge !== "end") {
          check(c.end_time);
        }
      }
      return best;
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      const activeDrag = dragModeRef.current;
      const el = timelineRef.current;
      if (!activeDrag || !el) return;

      const physics = scrubPhysicsRef.current;
      const now = performance.now();
      if (physics.lastClientX === 0 && !physics.hasPointerMoved) {
        physics.lastClientX = e.clientX;
        physics.lastMoveTs = now;
        return;
      }

      const rawDtMs = now - physics.lastMoveTs;
      if (rawDtMs > 90) {
        physics.smoothedVelocityPxPerSec *= 0.25;
      }
      const dtSec = Math.max(0.004, Math.min(0.1, rawDtMs / 1000));
      const dx = e.clientX - physics.lastClientX;
      physics.lastClientX = e.clientX;
      physics.lastMoveTs = now;
      if (dx === 0) return;

      physics.hasPointerMoved = true;
      const instVel = Math.abs(dx) / dtSec;
      physics.smoothedVelocityPxPerSec =
        physics.smoothedVelocityPxPerSec * 0.65 + instVel * 0.35;

      const slowPrecision = isLeftShiftPressedRef.current;
      const gain = computeScrubGain(
        physics.smoothedVelocityPxPerSec,
        activeDrag === "playhead",
        slowPrecision
      );
      physics.currentGain = gain;

      const rect = el.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const {
        viewDuration: vDur,
        duration: dur,
        activeStart: actStart,
        activeEnd: actEnd,
      } = dragLatestRef.current;

      const baseSecPerPx = vDur / width;
      const deltaSec = dx * baseSecPerPx * gain;
      const disableSnap = e.altKey || e.shiftKey || slowPrecision;

      if (activeDrag === "playhead") {
        physics.rawTargetTime = Math.max(
          0,
          Math.min(dur, physics.rawTargetTime + deltaSec)
        );
        physics.targetTime = physics.rawTargetTime;
      } else if (activeDrag === "start") {
        physics.rawTargetTime = Math.max(
          0,
          Math.min(actEnd - 0.1, physics.rawTargetTime + deltaSec)
        );
        const snapped = snapTime(physics.rawTargetTime, width, disableSnap);
        physics.targetTime = Math.max(0, Math.min(actEnd - 0.1, snapped));
      } else if (activeDrag === "end") {
        physics.rawTargetTime = Math.max(
          actStart + 0.1,
          Math.min(dur, physics.rawTargetTime + deltaSec)
        );
        const snapped = snapTime(physics.rawTargetTime, width, disableSnap);
        physics.targetTime = Math.max(actStart + 0.1, Math.min(dur, snapped));
      } else if (activeDrag.type === "range-move") {
        const maxStart = Math.max(0, dur - activeDrag.rangeLen);
        physics.rawTargetTime = Math.max(
          0,
          Math.min(maxStart, physics.rawTargetTime + deltaSec)
        );
        physics.targetTime = physics.rawTargetTime;
      } else if (activeDrag.type === "clip-start") {
        physics.rawTargetTime = Math.max(
          0,
          Math.min(activeDrag.end - 0.1, physics.rawTargetTime + deltaSec)
        );
        const snapped = snapTime(
          physics.rawTargetTime,
          width,
          disableSnap,
          activeDrag.clipId,
          "start"
        );
        physics.targetTime = Math.max(0, Math.min(activeDrag.end - 0.1, snapped));
      } else if (activeDrag.type === "clip-end") {
        physics.rawTargetTime = Math.max(
          activeDrag.start + 0.1,
          Math.min(dur, physics.rawTargetTime + deltaSec)
        );
        const snapped = snapTime(
          physics.rawTargetTime,
          width,
          disableSnap,
          activeDrag.clipId,
          "end"
        );
        physics.targetTime = Math.max(activeDrag.start + 0.1, Math.min(dur, snapped));
      }
    };

    let rafId = 0;
    let lastEmittedTime = scrubPhysicsRef.current.displayTime;
    let lastEmittedSeeking = Boolean(videoRef.current?.seeking);
    let lastEmittedHint = "";

    const formatHint = (
      activeDrag: Exclude<DragMode, null>,
      gain: number,
      velPxPerSec: number,
      slowPrecision: boolean
    ): string => {
      if (slowPrecision) {
        return `Shift Izq · Precisión ${gain.toFixed(2)}x`;
      }
      if (activeDrag === "playhead") {
        if (gain >= 1.25) return `Acelerado · ${gain.toFixed(1)}x`;
        if (gain <= 0.78 && velPxPerSec > 4) return `Fino · ${gain.toFixed(2)}x`;
      }
      return "Shift Izq = Lento";
    };

    const tickScrub = (now: number) => {
      const activeDrag = dragModeRef.current;
      if (!activeDrag) return;

      const physics = scrubPhysicsRef.current;
      const dt = Math.min(0.05, Math.max(0.001, (now - physics.lastFrameTs) / 1000));
      physics.lastFrameTs = now;

      const slowPrecision = isLeftShiftPressedRef.current;
      if (now - physics.lastMoveTs > 35) {
        physics.smoothedVelocityPxPerSec *= Math.exp(-dt * 12);
        physics.currentGain = computeScrubGain(
          physics.smoothedVelocityPxPerSec,
          activeDrag === "playhead",
          slowPrecision
        );
      }

      const diff = physics.targetTime - physics.displayTime;
      const lambda = slowPrecision ? 16 : activeDrag === "playhead" ? 20 : 28;
      const alpha = 1 - Math.exp(-dt * lambda);
      if (Math.abs(diff) < 0.0005) {
        physics.displayTime = physics.targetTime;
      } else {
        physics.displayTime += diff * alpha;
      }

      const t = physics.displayTime;
      const currentSeeking = Boolean(scrubVideoRef.current?.seeking);
      const currentHint = formatHint(
        activeDrag,
        physics.currentGain,
        physics.smoothedVelocityPxPerSec,
        slowPrecision
      );

      if (
        Math.abs(t - lastEmittedTime) > 0.0003 ||
        currentSeeking !== lastEmittedSeeking ||
        currentHint !== lastEmittedHint
      ) {
        lastEmittedTime = t;
        lastEmittedSeeking = currentSeeking;
        lastEmittedHint = currentHint;

        const {
          viewStart: vStart,
          viewDuration: vDur,
          duration: dur,
          activeStart: actStart,
          activeEnd: actEnd,
          onActiveRangeChange: emitRange,
          onUpdateClipTimes: emitClipTimes,
          seekTo: doSeek,
        } = dragLatestRef.current;

        let effectiveViewStart = vStart;
        if (activeDrag === "playhead") {
          lastDraggedTimeRef.current = t;
          doSeek(t, true);
          if (followPlayheadRef.current) {
            effectiveViewStart = computeCenteredViewStart(t, dur, zoomRef.current);
            setViewStart(effectiveViewStart);
          } else if (zoomRef.current > 1 && dur > vDur) {
            const edgePad = vDur * 0.04;
            if (t < vStart + edgePad) {
              effectiveViewStart = Math.max(0, t - edgePad);
              setViewStart(effectiveViewStart);
            } else if (t > vStart + vDur - edgePad) {
              effectiveViewStart = Math.min(dur - vDur, t - (vDur - edgePad));
              setViewStart(effectiveViewStart);
            }
          }
        } else if (activeDrag === "start") {
          emitRange(t, actEnd);
          lastDraggedTimeRef.current = t;
          doSeek(t, true);
        } else if (activeDrag === "end") {
          emitRange(actStart, t);
          lastDraggedTimeRef.current = t;
          doSeek(t, true);
        } else if (activeDrag.type === "range-move") {
          emitRange(t, t + activeDrag.rangeLen);
          lastDraggedTimeRef.current = t;
          doSeek(t, true);
        } else if (activeDrag.type === "clip-start") {
          emitClipTimes?.(activeDrag.clipId, t, activeDrag.end);
          emitRange(t, activeDrag.end);
          lastDraggedTimeRef.current = t;
          doSeek(t, true);
        } else if (activeDrag.type === "clip-end") {
          emitClipTimes?.(activeDrag.clipId, activeDrag.start, t);
          emitRange(activeDrag.start, t);
          lastDraggedTimeRef.current = t;
          doSeek(t, true);
        }

        const previewPct =
          vDur > 0
            ? Math.max(0, Math.min(100, ((t - effectiveViewStart) / vDur) * 100))
            : 0;
        setTrimPreview({
          label: getDragLabel(activeDrag),
          time: t,
          pct: previewPct,
          seeking: currentSeeking,
          modeHint: currentHint,
        });
      }

      rafId = window.requestAnimationFrame(tickScrub);
    };

    rafId = window.requestAnimationFrame(tickScrub);

    const finishDrag = () => {
      window.cancelAnimationFrame(rafId);
      scrubHlsRef.current?.stopLoad();
      if (pendingSeekTimerRef.current !== null) {
        window.clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
      const activeDrag = dragModeRef.current;
      const shouldResumePlayhead =
        activeDrag === "playhead" && wasPlayingBeforeDragRef.current;

      const physics = scrubPhysicsRef.current;
      const commitTime = physics.hasPointerMoved
        ? physics.displayTime
        : lastDraggedTimeRef.current;

      queuedSeekTimeRef.current = null;
      dragModeRef.current = null;
      setDragMode(null);
      setTrimPreview(null);
      lastDraggedTimeRef.current = null;

      if (commitTime !== null && commitTime !== undefined) {
        dragLatestRef.current.seekTo(commitTime, false);
      }

      if (shouldResumePlayhead) {
        const v = videoRef.current;
        const a = audioRef.current;
        dragLatestRef.current.syncMediaSettings();
        wantPlayRef.current = true;
        if (v) {
          v.play().catch(() => {});
          if (a && hasAudioTrackRef.current) {
            a.currentTime = v.currentTime;
            a.play().catch(() => {});
          }
        }
      } else if (wasPlayingBeforeDragRef.current) {
        wantPlayRef.current = false;
      }
      wasPlayingBeforeDragRef.current = false;
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    window.addEventListener("blur", finishDrag);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      window.removeEventListener("blur", finishDrag);
    };
  }, [dragMode]);

  // Wheel Zoom & Pan
  const handleTimelineWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const mouseTime = viewStart + mouseRatio * viewDuration;
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.8;
      handleZoomChange(zoom * zoomFactor, mouseTime);
    } else {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const panStep = (viewDuration / 15) * (delta > 0 ? 1 : -1);
      handlePan(panStep);
    }
  };

  // Scrubber visible positions (relative to zoomed window [viewStart, viewEnd])
  const timeToViewPct = (t: number) => {
    return ((t - viewStart) / viewDuration) * 100;
  };

  const playheadPct = timeToViewPct(currentTime);
  const startPct = timeToViewPct(activeStart);
  const endPct = timeToViewPct(activeEnd);

  // Dynamic Ticks (supports sub-second steps cleanly without float drift)
  const visibleTicks = useMemo(() => {
    const interval = getTickInterval(viewDuration);
    const first = Math.ceil(viewStart / interval) * interval;
    const list: number[] = [];
    for (let i = 0; i < 250; i++) {
      const t = Math.round((first + i * interval) * 100) / 100;
      if (t > viewEnd + 1e-6) break;
      list.push(t);
    }
    return list;
  }, [viewDuration, viewStart, viewEnd]);

  return (
    <section className="flex flex-1 flex-col gap-3 rounded-2xl border border-white/10 bg-[#111114] p-3 shadow-2xl backdrop-blur-xl overflow-hidden min-h-0">
      {/* ── 1. Video Player Viewport ── */}
      <div className="relative flex-1 min-h-[240px] w-full overflow-hidden rounded-xl border border-white/10 bg-[#09090B] shadow-inner flex items-center justify-center">
        {!metadata ? (
          <div className="flex flex-col items-center justify-center text-center p-8 max-w-md">
            <div className="relative mb-4 flex h-20 w-20 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-400 shadow-2xl shadow-indigo-500/10">
              <Film className="h-10 w-10 opacity-80" />
              <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white shadow-md">
                +
              </div>
            </div>
            <h2 className="text-base font-semibold text-white">
              Ningún stream cargado
            </h2>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Pega un enlace de YouTube / Twitch o importa un JSON para recortar
              clips con precisión.
            </p>
          </div>
        ) : (
          <>
            {playerMode !== "embed" && activeStreamUrl && !streamError ? (
              <div className="relative h-full w-full flex items-center justify-center">
                <video
                  ref={videoRef}
                  poster={metadata.thumbnail || undefined}
                  preload="auto"
                  muted={muted || hasAudioTrack}
                  playsInline
                  onClick={togglePlay}
                  onLoadedMetadata={() => {
                    syncMediaSettings();
                    advanceStreamStage("manifest");
                    const v = videoRef.current;
                    if (v && pendingResolutionRestoreTimeRef.current !== null) {
                      const restoreT = pendingResolutionRestoreTimeRef.current;
                      v.currentTime = restoreT;
                      if (audioRef.current) {
                        audioRef.current.currentTime = restoreT;
                      }
                    }
                  }}
                  onLoadedData={() => {
                    setIsLoadingStream(false);
                    updateBufferedRanges();
                  }}
                  onProgress={updateBufferedRanges}
                  onRateChange={() => {
                    const v = videoRef.current;
                    if (v && v.playbackRate !== playbackRateRef.current) {
                      v.playbackRate = playbackRateRef.current;
                    }
                  }}
                  onTimeUpdate={handleTimeUpdate}
                  onWaiting={() => {
                    if (!isLoopSeekingRef.current && !dragModeRef.current) {
                      setIsLoadingStream(true);
                      if (audioRef.current) audioRef.current.pause();
                    }
                  }}
                  onStalled={() => {
                    if (wantPlayRef.current && !isLoopSeekingRef.current && !dragModeRef.current) {
                      setIsLoadingStream(true);
                    }
                  }}
                  onCanPlay={() => {
                    setIsLoadingStream(false);
                    syncMediaSettings();
                    updateBufferedRanges();
                    const v = videoRef.current;
                    const a = audioRef.current;
                    if (v && pendingResolutionRestoreTimeRef.current !== null) {
                      const restoreT = pendingResolutionRestoreTimeRef.current;
                      pendingResolutionRestoreTimeRef.current = null;
                      v.currentTime = restoreT;
                      if (a) a.currentTime = restoreT;
                    }
                    if (v && wantPlayRef.current && v.paused && !dragModeRef.current) {
                      v.play().catch(() => {});
                      if (a && hasAudioTrackRef.current) a.play().catch(() => {});
                    }
                  }}
                  onCanPlayThrough={() => {
                    setIsLoadingStream(false);
                    syncMediaSettings();
                    updateBufferedRanges();
                    const v = videoRef.current;
                    const a = audioRef.current;
                    if (v && wantPlayRef.current && v.paused && !dragModeRef.current) {
                      v.play().catch(() => {});
                      if (a && hasAudioTrackRef.current) a.play().catch(() => {});
                    }
                  }}
                  onPlaying={() => {
                    setIsLoadingStream(false);
                    setIsPlaying(true);
                    syncMediaSettings();
                    const v = videoRef.current;
                    const a = audioRef.current;
                    if (v) {
                      lastPlaybackProgressRef.current = {
                        time: v.currentTime,
                        at: Date.now(),
                        softAttempts: 0,
                        hardAttempts: 0,
                      };
                      if (a && hasAudioTrack) {
                        if (Math.abs(a.currentTime - v.currentTime) > 0.12) {
                          a.currentTime = v.currentTime;
                        }
                        if (a.paused && wantPlayRef.current) {
                          a.play().catch(() => {});
                        }
                      }
                    }
                  }}
                  onPause={() => {
                    setIsPlaying(false);
                    if (audioRef.current) audioRef.current.pause();
                  }}
                  onSeeked={() => {
                    const v = videoRef.current;
                    const a = audioRef.current;
                    if (v) {
                      lastPlaybackProgressRef.current.at = Date.now();
                      lastPlaybackProgressRef.current.time = v.currentTime;
                      lastStopCheckTimeRef.current = v.currentTime;
                      updateBufferedRanges();
                      setIsLoadingStream(false);
                      if (!dragModeRef.current && a && Math.abs(a.currentTime - v.currentTime) > 0.08) {
                        a.currentTime = v.currentTime;
                      }
                    }
                  }}
                  onEnded={() => {
                    if (loopSelection && activeEnd > activeStart) {
                      const v = videoRef.current;
                      const a = audioRef.current;
                      if (v) {
                        syncMediaSettings();
                        v.currentTime = activeStart;
                        if (a) a.currentTime = activeStart;
                        v.play().catch(() => {});
                        if (a && hasAudioTrack) a.play().catch(() => {});
                        setIsPlaying(true);
                      }
                    } else {
                      wantPlayRef.current = false;
                      setIsPlaying(false);
                    }
                  }}
                  onError={() => {
                    console.warn("Video stream load error on active stream:", activeStreamUrl);
                    if (!metadata.preview_stream_url && !metadata.preview_webm_url) {
                      setStreamError(true);
                      setIsLoadingStream(false);
                      setPlayerMode("embed");
                    }
                  }}
                  className="h-full w-full object-contain cursor-pointer"
                />

                {hasAudioTrack && activeAudioUrl && (
                  <audio
                    ref={audioRef}
                    preload="auto"
                    muted={muted}
                    onLoadedMetadata={() => {
                      syncMediaSettings();
                      const v = videoRef.current;
                      const a = audioRef.current;
                      if (v && a) {
                        a.currentTime = v.currentTime;
                      }
                    }}
                    onCanPlay={() => {
                      syncMediaSettings();
                      const v = videoRef.current;
                      const a = audioRef.current;
                      if (v && a && wantPlayRef.current && !dragModeRef.current) {
                        if (Math.abs(a.currentTime - v.currentTime) > 0.08) {
                          a.currentTime = v.currentTime;
                        }
                        if (a.paused) a.play().catch(() => {});
                        if (v.paused) v.play().catch(() => {});
                      }
                    }}
                    onWaiting={() => {
                      const v = videoRef.current;
                      if (v && !v.paused && !dragModeRef.current) {
                        v.pause();
                        setIsLoadingStream(true);
                      }
                    }}
                    onPlaying={() => {
                      const v = videoRef.current;
                      const a = audioRef.current;
                      if (v && a && !dragModeRef.current) {
                        if (Math.abs(a.currentTime - v.currentTime) > 0.15) {
                          a.currentTime = v.currentTime;
                        }
                        if (v.paused && wantPlayRef.current) {
                          v.play().catch(() => {});
                        }
                      }
                    }}
                    className="hidden"
                  />
                )}

                {scrubStreamUrl && (
                  <video
                    ref={scrubVideoRef}
                    muted
                    playsInline
                    preload="auto"
                    style={{
                      position: "fixed",
                      width: "1px",
                      height: "1px",
                      opacity: 0.001,
                      pointerEvents: "none",
                      left: "-9999px",
                      top: "-9999px",
                      zIndex: -1,
                    }}
                    onLoadedMetadata={() => {
                      if (dragModeRef.current && queuedSeekTimeRef.current !== null) {
                        flushQueuedSeek();
                      }
                    }}
                    onLoadedData={() => {
                      if (dragModeRef.current) {
                        drawTrimPreviewFrame(false);
                        setTrimPreview((prev) => (prev ? { ...prev, seeking: false } : prev));
                      }
                    }}
                    onSeeked={() => {
                      if (dragModeRef.current) {
                        drawTrimPreviewFrame(false);
                        setTrimPreview((prev) => (prev ? { ...prev, seeking: false } : prev));
                        flushQueuedSeek();
                      }
                    }}
                  />
                )}

                {!isPlaying && !isLoadingStream && !showLoadOverlay && !dragMode && (
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[1px] transition hover:bg-black/40"
                  >
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600/90 text-white shadow-2xl shadow-indigo-500/40 transition hover:scale-105 active:scale-95">
                      <Play className="ml-1 h-7 w-7 fill-white" />
                    </div>
                  </button>
                )}

                {dragMode && trimPreview && (
                  <div className="pointer-events-none absolute top-12 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border border-indigo-400/50 bg-black/80 px-3 py-1 text-[11px] font-semibold text-white shadow-xl backdrop-blur-md">
                    <span className="text-indigo-300">{trimPreview.label}</span>
                    <span className="font-mono tabular-nums">
                      {formatTimecode(trimPreview.time)}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="relative h-full w-full">
                <iframe
                  src={
                    metadata.embed_url ||
                    `https://www.youtube-nocookie.com/embed/${metadata.id}?autoplay=1&enablejsapi=1`
                  }
                  title={metadata.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full border-0"
                />
              </div>
            )}

            {/* Video Top HUD Overlay */}
            <div className="pointer-events-none absolute top-3 left-3 right-3 flex items-center justify-between z-20">
              <div className="flex items-center gap-2 rounded-lg bg-black/75 px-2.5 py-1 text-xs text-white backdrop-blur-md border border-white/10 pointer-events-auto max-w-[45%] shrink min-w-0">
                <span className="truncate font-medium">{metadata.title}</span>
              </div>

              <div className="flex items-center gap-1.5 pointer-events-auto shrink-0 flex-wrap justify-end">
                {metadata.audio_tracks.length > 1 && onSelectAudioTrack && (
                  <select
                    value={
                      selectedAudioTrackId || metadata.audio_tracks[0]?.track_id
                    }
                    onChange={(e) => onSelectAudioTrack(e.target.value)}
                    className="rounded bg-black/80 px-2 py-0.5 text-[10px] text-slate-300 border border-white/10 outline-none"
                    title="Pista de audio"
                  >
                    {metadata.audio_tracks.map((t) => (
                      <option key={t.track_id} value={t.track_id}>
                        {t.label || t.language || t.track_id}
                      </option>
                    ))}
                  </select>
                )}

                {/* Resolution Selector */}
                {metadata.preview_resolutions &&
                  metadata.preview_resolutions.length > 0 && (
                    <div className="flex items-center gap-0.5 rounded-lg bg-black/80 p-0.5 border border-white/10 backdrop-blur-md shadow-lg">
                      {metadata.preview_resolutions.map((res) => {
                        const isSelected = selectedResolution === res.label && playerMode !== "embed";
                        return (
                          <button
                            key={res.label}
                            type="button"
                            onClick={() => {
                              if (playerMode === "embed") {
                                setPlayerMode("mp4");
                              }
                              handleResolutionChange(res.label);
                            }}
                            title={`Cambiar vista previa a ${res.label}`}
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${
                              isSelected
                                ? "bg-indigo-600 text-white shadow-sm"
                                : "text-slate-400 hover:text-white"
                            }`}
                          >
                            {res.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                <div className="flex items-center gap-1 rounded-lg bg-black/80 p-0.5 border border-white/10 backdrop-blur-md">
                  <button
                    type="button"
                    disabled={!metadata.preview_stream_url}
                    onClick={() => setPlayerMode("mp4")}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold transition ${
                      playerMode === "mp4"
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-white disabled:opacity-30"
                    }`}
                  >
                    MP4
                  </button>
                  <button
                    type="button"
                    disabled={!metadata.preview_webm_url}
                    onClick={() => setPlayerMode("webm")}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold transition ${
                      playerMode === "webm"
                        ? "bg-cyan-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-white disabled:opacity-30"
                    }`}
                  >
                    WebM
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlayerMode("embed")}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold transition ${
                      playerMode === "embed"
                        ? "bg-rose-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    Embed
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Unified 0%-100% Mini Circular Progress Overlay (Initial Load & Buffering) */}
        {showLoadOverlay && !dragMode && (() => {
          const pct = Math.max(0, Math.min(100, Math.round(loadProgress)));
          const r = 22;
          const circ = 2 * Math.PI * r;
          const offset = circ * (1 - pct / 100);
          return (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[#09090B]/75 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-white/10 bg-[#121218]/90 px-5 py-4 shadow-2xl">
                <div className="relative flex h-14 w-14 items-center justify-center">
                  <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
                    <defs>
                      <linearGradient id="clipgen-viewport-load-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#6366F1" />
                        <stop offset="100%" stopColor="#22D3EE" />
                      </linearGradient>
                    </defs>
                    <circle
                      cx="28"
                      cy="28"
                      r={r}
                      fill="none"
                      stroke="rgba(255,255,255,0.1)"
                      strokeWidth="4"
                    />
                    <circle
                      cx="28"
                      cy="28"
                      r={r}
                      fill="none"
                      stroke="url(#clipgen-viewport-load-grad)"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeDasharray={circ}
                      strokeDashoffset={offset}
                    />
                  </svg>
                  <span className="absolute font-mono text-[11px] font-bold tabular-nums text-white">
                    {pct}%
                  </span>
                </div>
                <span className="max-w-[200px] truncate text-center text-[11px] font-medium text-slate-200">
                  {loadLabel || "Cargando video..."}
                </span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── 2. Professional Zoomable & Pannable Timeline ── */}
      <div className="flex flex-col gap-2 pt-0.5">
        {/* Header: Timecode and Active Range Display */}
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs tabular-nums text-indigo-300 font-semibold bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded">
              {formatTimecode(currentTime)}
            </span>
            <span className="text-slate-500 font-mono">/</span>
            <span className="font-mono text-xs tabular-nums text-slate-400">
              {formatTimecode(duration)}
            </span>
            {zoom > 1 && (
              <span className="text-[10px] text-slate-500 font-mono">
                (Ventana: {formatTimecode(viewStart)} → {formatTimecode(viewEnd)})
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {hoverTime && (
              <span className="font-mono text-[10px] tabular-nums text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded">
                Cursor: {formatTimecode(hoverTime.time)}
              </span>
            )}

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-400">Rango activo:</span>
              <span className="font-mono text-xs tabular-nums font-bold text-indigo-400 bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 rounded shadow-sm shadow-indigo-500/10">
                Δ {formatTimecode(selectionDuration)}
              </span>
            </div>

            {isAltPressed && (
              <span className="flex items-center gap-1 rounded bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                <span>Alt: Ajuste fino (sin imán)</span>
              </span>
            )}

            {playerMode !== "embed" && totalBufferedSeconds > 0 && (
              <span
                title="Partes del video cargadas actualmente en el buffer (barra celeste en la regla y minimapa)"
                className="flex items-center gap-1.5 rounded bg-sky-500/10 border border-sky-400/25 px-2 py-0.5 font-mono text-[10px] text-sky-300"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                <span>Cargado: {formatTimeShort(totalBufferedSeconds)}</span>
              </span>
            )}

            {clips.length > 0 && (
              <span className="text-[11px] text-slate-400 flex items-center gap-1">
                <Layers className="h-3 w-3 text-indigo-400" />
                <span className="tabular-nums font-semibold text-slate-200">
                  {clips.length}
                </span>{" "}
                clips
              </span>
            )}
          </div>
        </div>

        {/* 🌟 OVERVIEW MINIMAP (0% to 100% of entire stream) 🌟 */}
        <div className="relative">
          <div
            ref={minimapRef}
            onPointerDown={handleMinimapPointerDown}
            onPointerMove={handleMinimapPointerMove}
            onPointerUp={handleMinimapPointerUp}
            title="Minimapa de navegación: Haz clic o arrastra para mover el visor"
            className="relative h-4 w-full cursor-pointer select-none overflow-hidden rounded-md border border-white/10 bg-[#09090B] transition hover:border-white/20"
          >
            {/* Buffered / Loaded Video Segments in Minimap */}
            {playerMode !== "embed" &&
              bufferedRanges.map((seg, idx) => {
                const bLeft = (seg.start / duration) * 100;
                const bWidth = Math.max(0.3, ((seg.end - seg.start) / duration) * 100);
                return (
                  <div
                    key={`mini-buf-${idx}`}
                    style={{ left: `${bLeft}%`, width: `${bWidth}%` }}
                    className="pointer-events-none absolute top-0 bottom-0 z-0 bg-sky-400/20 border-b-2 border-sky-400/75"
                  />
                );
              })}

            {/* Saved Clips Highlights in Minimap */}
            {clips.map((clip, idx) => {
              const clipIndex = allClips
                ? allClips.findIndex((c) => c.id === clip.id)
                : idx;
              const currentPos = clipIndex >= 0 ? clipIndex : idx;
              const currentNum = currentPos + clipStartIndex;
              const totalCount = allClips ? allClips.length : clips.length;
              const maxNum = totalCount + clipStartIndex - 1;
              const displayNum = String(currentNum).padStart(
                maxNum >= 10 ? 2 : 1,
                "0"
              );
              const titleClean = cleanClipTitle(clip.name);
              const cStart = (clip.start_time / duration) * 100;
              const cWidth = Math.max(
                0.4,
                ((clip.end_time - clip.start_time) / duration) * 100
              );
              const colorClass =
                CLIP_ACCENT_COLORS[currentPos % CLIP_ACCENT_COLORS.length];
              return (
                <div
                  key={`mini-${clip.id}`}
                  style={{ left: `${cStart}%`, width: `${cWidth}%` }}
                  title={`#${displayNum}. ${titleClean} (${formatTimeShort(
                    clip.start_time
                  )} → ${formatTimeShort(clip.end_time)})`}
                  className={`pointer-events-none absolute top-0 bottom-0 opacity-80 ${colorClass}`}
                />
              );
            })}

            {/* Active Range in Minimap */}
            {metadata && (
              <div
                style={{
                  left: `${(activeStart / duration) * 100}%`,
                  width: `${Math.max(
                    0.5,
                    ((activeEnd - activeStart) / duration) * 100
                  )}%`,
                }}
                className="pointer-events-none absolute top-0 bottom-0 bg-indigo-500/50 border-x border-indigo-300"
              />
            )}

            {/* Current Playhead in Minimap */}
            <div
              style={{ left: `${(currentTime / duration) * 100}%` }}
              className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white z-20 shadow-[0_0_4px_rgba(255,255,255,0.9)]"
            />

            {/* Draggable Viewport Window Box */}
            <div
              style={{
                left: `${(viewStart / duration) * 100}%`,
                width: `${Math.max(1, (viewDuration / duration) * 100)}%`,
              }}
              className="pointer-events-none absolute top-0 bottom-0 rounded border-2 border-indigo-400 bg-indigo-500/25 z-10"
            />
          </div>
        </div>

        {/* 🌟 ZOOM & PAN CONTROLS TOOLBAR 🌟 */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
          {/* Zoom controls & Presets */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mr-1">
              Zoom:
            </span>
            <button
              type="button"
              onClick={() => handleZoomChange(zoom / 1.5)}
              disabled={zoom <= 1}
              className="flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10 disabled:opacity-30 transition"
              title="Alejar Zoom (-)"
            >
              <ZoomOut className="h-3 w-3" />
            </button>

            <span className="font-mono text-[11px] tabular-nums font-bold text-indigo-300 px-1 min-w-[44px] text-center">
              {zoom.toFixed(zoom >= 10 ? 0 : 1)}x
            </span>

            <button
              type="button"
              onClick={() => handleZoomChange(zoom * 1.5)}
              disabled={zoom >= maxZoom}
              className="flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10 disabled:opacity-30 transition"
              title="Acercar Zoom (+)"
            >
              <ZoomIn className="h-3 w-3" />
            </button>

            {/* Quick Presets */}
            <div className="flex flex-wrap items-center gap-0.5 ml-1">
              {ZOOM_PRESETS.filter((z) => z <= maxZoom).map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => handleZoomChange(z)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition ${
                    Math.abs(zoom - z) <= Math.max(0.2, z * 0.05)
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {z}x
                </button>
              ))}
            </div>
          </div>

          {/* Pan & Viewport centering actions */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handlePan(-viewDuration * 0.25)}
              disabled={viewStart <= 0}
              className="flex h-6 items-center gap-0.5 rounded border border-white/10 bg-white/[0.04] px-1.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-30 transition"
              title="Desplazar a la izquierda"
            >
              <ChevronLeft className="h-3 w-3" />
              <span>Pan</span>
            </button>

            <button
              type="button"
              onClick={() => handlePan(viewDuration * 0.25)}
              disabled={viewEnd >= duration}
              className="flex h-6 items-center gap-0.5 rounded border border-white/10 bg-white/[0.04] px-1.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-30 transition"
              title="Desplazar a la derecha"
            >
              <span>Pan</span>
              <ChevronRight className="h-3 w-3" />
            </button>

            <button
              type="button"
              onClick={handleCenterPlayhead}
              className="flex h-6 items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-2 text-[10px] text-slate-300 hover:bg-white/10 transition"
              title="Centrar la vista en el cabezal de reproducción"
            >
              <Crosshair className="h-3 w-3 text-indigo-400" />
              <span>Centrar Cabezal</span>
            </button>

            <button
              type="button"
              onClick={handleToggleFollowPlayhead}
              className={`flex h-6 items-center gap-1 rounded border px-2 text-[10px] font-semibold transition ${
                followPlayhead
                  ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-200 shadow-sm shadow-cyan-500/20"
                  : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10"
              }`}
              title="Fijar el cabezal de reproducción en el centro y seguir automáticamente"
            >
              <Pin className={`h-3 w-3 ${followPlayhead ? "text-cyan-300" : "text-slate-400"}`} />
              <span>Fijar al Centro</span>
            </button>

            <button
              type="button"
              onClick={handleFitSelection}
              disabled={selectionDuration <= 0}
              className="flex h-6 items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/15 px-2 text-[10px] font-semibold text-indigo-200 hover:bg-indigo-500/30 transition disabled:opacity-30"
              title="Ajustar zoom al rango seleccionado [ I - O ]"
            >
              <Maximize2 className="h-3 w-3 text-indigo-400" />
              <span>Ajustar a Selección</span>
            </button>
          </div>
        </div>

        {/* 🌟 MAIN 3-ZONE NLE WORKING TIMELINE (Zero Overlapping Handles) + Floating Mini-Frame Tooltip 🌟 */}
        <div className="relative pt-3.5">
          {trimPreview && metadata && (
            <div
              style={{
                left: `clamp(108px, ${trimPreview.pct}%, calc(100% - 108px))`,
              }}
              className="pointer-events-none absolute bottom-full mb-2 z-50 -translate-x-1/2"
            >
              <div className="w-52 rounded-xl border border-indigo-400/50 bg-[#0D0D12]/95 p-1.5 shadow-2xl shadow-black/80 backdrop-blur-md">
                <div className="relative w-full aspect-video overflow-hidden rounded-lg bg-black border border-white/10">
                  {playerMode !== "embed" ? (
                    <canvas
                      ref={trimPreviewCanvasRef}
                      width={240}
                      height={135}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">
                      Vista Embed
                    </div>
                  )}
                  {scrubResLabel && playerMode !== "embed" && (
                    <div className="absolute top-1.5 left-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-300 border border-white/10">
                      {scrubResLabel}
                    </div>
                  )}
                  {trimPreview.seeking && playerMode !== "embed" && (
                    <div className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-medium text-indigo-300 border border-indigo-400/30">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      <span>Frame...</span>
                    </div>
                  )}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 px-1 text-[10px]">
                  <span className="font-semibold text-indigo-300 truncate">
                    {trimPreview.label}
                  </span>
                  <span className="font-mono font-bold tabular-nums text-white shrink-0">
                    {formatTimecode(trimPreview.time)}
                  </span>
                </div>
                {trimPreview.modeHint && (
                  <div className="mt-0.5 flex items-center justify-center px-1">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-medium ${
                        isLeftShiftPressed
                          ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/40"
                          : "bg-white/[0.04] text-slate-400"
                      }`}
                    >
                      {trimPreview.modeHint}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div
            ref={timelineRef}
            onWheel={handleTimelineWheel}
            onPointerEnter={(e) => {
              if (e.altKey !== isAltPressed) setIsAltPressed(e.altKey);
            }}
            onPointerMove={(e) => {
              if (e.altKey !== isAltPressed) setIsAltPressed(e.altKey);
              if (!dragModeRef.current) {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
                const t = Math.max(0, Math.min(duration, viewStart + ratio * viewDuration));
                setHoverTime({ time: t, pct: ratio * 100 });
              }
            }}
            onPointerLeave={() => {
              setIsAltPressed(false);
              if (!dragModeRef.current) {
                setHoverTime(null);
              }
            }}
            className="relative w-full select-none overflow-hidden rounded-xl border border-white/10 bg-[#09090B] flex flex-col"
          >
            {/* Zone A: Ruler & Playhead Scrub Strip */}
            <div
              onPointerDown={(e) => {
                if (e.button !== 0 || !metadata) return;
                const t = pointerClientXToTime(e.clientX);
                setCurrentTime(t);
                lastDraggedTimeRef.current = t;
                beginTimelineDrag("playhead", t, e.clientX);
              }}
              className="relative h-6 w-full border-b border-white/10 bg-[#0E0E12] cursor-pointer"
            >
            {/* Buffered / Loaded Video Segments across Zoomed Ruler */}
            {playerMode !== "embed" &&
              bufferedRanges.map((seg, idx) => {
                const rawStart = timeToViewPct(seg.start);
                const rawEnd = timeToViewPct(seg.end);
                if (rawEnd <= 0 || rawStart >= 100) return null;
                const left = Math.max(0, rawStart);
                const width = Math.max(0.3, Math.min(100, rawEnd) - left);
                return (
                  <div
                    key={`buf-${idx}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    className="pointer-events-none absolute top-0 bottom-0 z-0 bg-sky-400/12"
                  >
                    <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-sky-400/85 shadow-[0_0_6px_rgba(56,189,248,0.5)]" />
                  </div>
                );
              })}

            {/* Dynamic Ruler Tick Marks & Timecodes */}
            <div className="pointer-events-none absolute inset-0 z-0">
              {visibleTicks.map((tick) => {
                const tickPct = timeToViewPct(tick);
                const fracTenths = Math.round((tick - Math.floor(tick)) * 10);
                const tickLabel =
                  fracTenths > 0 && fracTenths < 10
                    ? `${formatTimeShort(Math.floor(tick))}.${fracTenths}`
                    : formatTimeShort(Math.round(tick));
                return (
                  <div
                    key={`tick-${tick}`}
                    style={{ left: `${tickPct}%` }}
                    className="absolute top-0 bottom-0 flex flex-col justify-between"
                  >
                    <div className="h-1.5 w-px bg-slate-500/45" />
                    <span className="font-mono text-[9px] text-slate-400/75 tabular-nums -translate-x-1/2 pb-0.5 select-none leading-none">
                      {tickLabel}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Chapters Markers */}
            {metadata?.chapters.map((ch, idx) => {
              const chPct = timeToViewPct(ch.start_time);
              if (chPct < -5 || chPct > 105) return null;
              return (
                <div
                  key={`chap-${idx}`}
                  style={{ left: `${chPct}%` }}
                  title={`Capítulo: ${ch.title}`}
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-amber-400/55 z-10"
                />
              );
            })}
          </div>

          {/* Zone B: Saved Clips Lane (Dedicated hitboxes, never covered by [ I - O ]) */}
          <div
            onPointerDown={(e) => {
              if (e.button !== 0 || !metadata) return;
              setSelectedTimelineClipId(null);
              const t = pointerClientXToTime(e.clientX);
              setCurrentTime(t);
              lastDraggedTimeRef.current = t;
              beginTimelineDrag("playhead", t, e.clientX);
            }}
            className="relative h-9 w-full border-b border-white/5 bg-[#09090B] cursor-pointer"
          >
            {clips.length === 0 && (
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[9px] font-medium uppercase tracking-wider text-slate-600">
                Clips guardados
              </span>
            )}

            {/* Subtle Active Range Alignment Guides */}
            {metadata && startPct >= -2 && startPct <= 102 && (
              <div
                style={{ left: `${startPct}%` }}
                className={`pointer-events-none absolute top-0 bottom-0 w-px bg-indigo-400 z-10 ${
                  isAltPressed ? "opacity-15" : "opacity-40"
                }`}
              />
            )}
            {metadata && endPct >= -2 && endPct <= 102 && (
              <div
                style={{ left: `${endPct}%` }}
                className={`pointer-events-none absolute top-0 bottom-0 w-px bg-indigo-400 z-10 ${
                  isAltPressed ? "opacity-15" : "opacity-40"
                }`}
              />
            )}

            {/* Saved Clips with Direct Trim Handles */}
            {clips.map((clip, idx) => {
              const clipIndex = allClips
                ? allClips.findIndex((c) => c.id === clip.id)
                : idx;
              const currentPos = clipIndex >= 0 ? clipIndex : idx;
              const currentNum = currentPos + clipStartIndex;
              const totalCount = allClips ? allClips.length : clips.length;
              const maxNum = totalCount + clipStartIndex - 1;
              const displayNum = String(currentNum).padStart(
                maxNum >= 10 ? 2 : 1,
                "0"
              );
              const titleClean = cleanClipTitle(clip.name);
              const cStart = timeToViewPct(clip.start_time);
              const cEnd = timeToViewPct(clip.end_time);
              if (cEnd < -5 || cStart > 105) return null;
              const cWidth = Math.max(0.8, cEnd - cStart);
              const colorClass =
                CLIP_ACCENT_COLORS[currentPos % CLIP_ACCENT_COLORS.length];
              const isClipSelected = selectedTimelineClipId === clip.id;

              return (
                <div
                  key={clip.id}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    setSelectedTimelineClipId(clip.id);
                    onActiveRangeChange(clip.start_time, clip.end_time);
                    seekTo(clip.start_time, false);
                  }}
                  title={`#${displayNum}. ${titleClean} (${formatTimeShort(
                    clip.start_time
                  )} → ${formatTimeShort(clip.end_time)})`}
                  style={{ left: `${cStart}%`, width: `${cWidth}%` }}
                  className={`group absolute top-1 bottom-1 flex items-center justify-between rounded-md border px-1.5 cursor-pointer transition-colors ${
                    isClipSelected
                      ? "z-20 ring-1 ring-white/85 brightness-125 shadow-md"
                      : isAltPressed
                      ? "z-20 ring-1 ring-white/60 shadow-lg hover:brightness-125"
                      : "z-10 hover:brightness-115"
                  } ${colorClass}`}
                >
                  {/* Left Trim Handle */}
                  <div
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setSelectedTimelineClipId(clip.id);
                      onActiveRangeChange(clip.start_time, clip.end_time);
                      lastDraggedTimeRef.current = clip.start_time;
                      beginTimelineDrag(
                        {
                          type: "clip-start",
                          clipId: clip.id,
                          end: clip.end_time,
                        },
                        clip.start_time,
                        e.clientX
                      );
                    }}
                    title="Arrastrar para recortar el inicio de este clip"
                    className={`absolute -left-1.5 top-0 bottom-0 w-3 cursor-ew-resize flex items-center justify-center rounded-l transition-colors transition-opacity z-20 ${
                      isClipSelected || isAltPressed
                        ? "bg-white/55 opacity-100"
                        : "bg-white/25 opacity-75 group-hover:opacity-100 hover:bg-white/80"
                    }`}
                  >
                    <div className="h-4 w-0.5 rounded-full bg-white shadow-sm" />
                  </div>

                  {/* Clip Title & Duration */}
                  <div className="flex items-center gap-1 min-w-0 overflow-hidden px-1 pointer-events-none">
                    <span className="font-mono text-[9px] font-bold text-white bg-black/55 px-1 py-0.2 rounded shrink-0 border border-white/20 tabular-nums">
                      #{displayNum}
                    </span>
                    <span className="truncate text-[9px] font-bold tracking-tight opacity-95">
                      {titleClean}
                    </span>
                    <span className="font-mono text-[8px] tabular-nums opacity-75 shrink-0">
                      ({(clip.end_time - clip.start_time).toFixed(1)}s)
                    </span>
                  </div>

                  {/* Right Trim Handle */}
                  <div
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setSelectedTimelineClipId(clip.id);
                      onActiveRangeChange(clip.start_time, clip.end_time);
                      lastDraggedTimeRef.current = clip.end_time;
                      beginTimelineDrag(
                        {
                          type: "clip-end",
                          clipId: clip.id,
                          start: clip.start_time,
                        },
                        clip.end_time,
                        e.clientX
                      );
                    }}
                    title="Arrastrar para recortar el final de este clip"
                    className={`absolute -right-1.5 top-0 bottom-0 w-3 cursor-ew-resize flex items-center justify-center rounded-r transition-colors transition-opacity z-20 ${
                      isClipSelected || isAltPressed
                        ? "bg-white/55 opacity-100"
                        : "bg-white/25 opacity-75 group-hover:opacity-100 hover:bg-white/80"
                    }`}
                  >
                    <div className="h-4 w-0.5 rounded-full bg-white shadow-sm" />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Zone C: Active Selection [ I - O ] Lane (Zero transition-all drag lag!) */}
          <div
            onPointerDown={(e) => {
              if (e.button !== 0 || !metadata) return;
              const t = pointerClientXToTime(e.clientX);
              setCurrentTime(t);
              lastDraggedTimeRef.current = t;
              beginTimelineDrag("playhead", t, e.clientX);
            }}
            className="relative h-9 w-full bg-[#0B0B10] cursor-pointer"
          >
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[9px] font-medium uppercase tracking-wider text-slate-600">
              Selector [ I — O ]
            </span>

            {metadata && endPct > -5 && startPct < 105 && (
              <div
                style={{
                  left: `${startPct}%`,
                  width: `${Math.max(0.4, endPct - startPct)}%`,
                }}
                className={`absolute top-1 bottom-1 rounded border-y-2 border-indigo-400 bg-indigo-500/25 transition-opacity duration-150 ${
                  isAltPressed
                    ? "opacity-20 pointer-events-none z-10"
                    : "opacity-100 z-20"
                }`}
              >
                {/* Draggable Middle Bar to Move Entire [I - O] Window */}
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0 || isAltPressed) return;
                    e.stopPropagation();
                    const clickTime = pointerClientXToTime(e.clientX);
                    const rangeLen = Math.max(0.1, activeEnd - activeStart);
                    const anchorOffset = Math.max(0, Math.min(rangeLen, clickTime - activeStart));
                    lastDraggedTimeRef.current = activeStart;
                    beginTimelineDrag(
                      {
                        type: "range-move",
                        anchorOffset,
                        rangeLen,
                      },
                      activeStart,
                      e.clientX
                    );
                  }}
                  title="Arrastra el centro para mover todo el rango [I - O] manteniendo la duración"
                  className="h-full w-full cursor-grab active:cursor-grabbing flex items-center justify-center overflow-hidden px-3"
                >
                  <span className="pointer-events-none font-mono text-[9px] font-semibold text-indigo-200/85 truncate">
                    Δ {formatTimeShort(selectionDuration)}
                  </span>
                </div>

                {/* In Handle [ I ] */}
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0 || isAltPressed) return;
                    e.stopPropagation();
                    lastDraggedTimeRef.current = activeStart;
                    beginTimelineDrag("start", activeStart, e.clientX);
                  }}
                  title="Arrastrar Inicio [ I ]"
                  className="absolute -left-2.5 top-0 bottom-0 flex w-5 cursor-ew-resize items-center justify-center rounded-l bg-indigo-500 hover:bg-indigo-400 transition-colors shadow-md"
                >
                  <span className="font-mono text-[9px] font-extrabold text-white select-none">
                    I
                  </span>
                </div>

                {/* Out Handle [ O ] */}
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0 || isAltPressed) return;
                    e.stopPropagation();
                    lastDraggedTimeRef.current = activeEnd;
                    beginTimelineDrag("end", activeEnd, e.clientX);
                  }}
                  title="Arrastrar Fin [ O ]"
                  className="absolute -right-2.5 top-0 bottom-0 flex w-5 cursor-ew-resize items-center justify-center rounded-r bg-indigo-500 hover:bg-indigo-400 transition-colors shadow-md"
                >
                  <span className="font-mono text-[9px] font-extrabold text-white select-none">
                    O
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Vertical Hover Guide Line */}
          {hoverTime && !dragMode && (
            <div
              style={{ left: `${hoverTime.pct}%` }}
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-indigo-400/50 shadow-[0_0_4px_rgba(99,102,241,0.7)]"
            />
          )}
          </div>

          {/* Protruding Playhead Handle + Full-Height Cursor (top tab sits outside timeline, zero clip collision) */}
          {metadata && playheadPct >= -1 && playheadPct <= 101 && (
            <div className="pointer-events-none absolute inset-x-[1px] top-0 bottom-0 z-40">
              <div
                style={{ left: `${Math.max(0, Math.min(100, playheadPct))}%` }}
                className="pointer-events-none absolute top-0 bottom-0 -translate-x-1/2 flex flex-col items-center"
              >
                <button
                  type="button"
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !metadata) return;
                    e.stopPropagation();
                    e.preventDefault();
                    beginTimelineDrag("playhead", currentTime, e.clientX);
                  }}
                  title="Arrastrar cabezal (Mantén Shift izquierdo para precisión lenta)"
                  className={`pointer-events-auto relative -mt-0.5 flex h-4 w-5 cursor-grab active:cursor-grabbing items-center justify-center rounded-t-md border shadow-[0_2px_8px_rgba(0,0,0,0.65)] transition-colors ${
                    dragMode === "playhead" && isLeftShiftPressed
                      ? "border-cyan-300 bg-cyan-400 text-slate-950"
                      : dragMode === "playhead"
                      ? "border-indigo-300 bg-indigo-400 text-white"
                      : followPlayhead
                      ? "border-cyan-300/90 bg-white text-slate-900 hover:bg-cyan-100"
                      : "border-white/90 bg-white text-slate-900 hover:bg-indigo-100"
                  }`}
                >
                  <div className="flex items-center gap-[2px]">
                    <span className="h-2 w-[1.5px] rounded-full bg-current opacity-70" />
                    <span className="h-2 w-[1.5px] rounded-full bg-current opacity-90" />
                    <span className="h-2 w-[1.5px] rounded-full bg-current opacity-70" />
                  </div>
                  <span
                    className={`pointer-events-none absolute -bottom-[4px] left-1/2 -translate-x-1/2 h-0 w-0 border-l-[4px] border-r-[4px] border-t-[4px] border-l-transparent border-r-transparent ${
                      dragMode === "playhead" && isLeftShiftPressed
                        ? "border-t-cyan-400"
                        : dragMode === "playhead"
                        ? "border-t-indigo-400"
                        : "border-t-white"
                    }`}
                  />
                </button>
                <div
                  className={`w-[2px] flex-1 transition-colors ${
                    dragMode === "playhead" && isLeftShiftPressed
                      ? "bg-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.95)]"
                      : "bg-white shadow-[0_0_8px_rgba(255,255,255,0.95)]"
                  }`}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 3. Tactical Marking Controls Bar ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#18181C] p-2">
        {/* Left: Transport & Step Controls */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            disabled={!metadata}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-md shadow-indigo-500/25 transition hover:bg-indigo-500 disabled:opacity-40"
            title={isPlaying ? "Pausar (Espacio)" : "Reproducir (Espacio)"}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-white" />
            )}
          </button>

          <button
            type="button"
            onClick={() => stepTime(-5)}
            disabled={!metadata}
            className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
            title="Retroceder 5 segundos"
          >
            <RotateCcw className="h-3 w-3" />
            <span className="tabular-nums">5s</span>
          </button>

          <button
            type="button"
            onClick={() => stepTime(-1)}
            disabled={!metadata}
            className="h-8 rounded-lg border border-white/10 bg-white/[0.04] px-2 font-mono text-xs tabular-nums text-slate-300 hover:bg-white/10 disabled:opacity-40"
            title="Retroceder 1 segundo"
          >
            -1s
          </button>

          <button
            type="button"
            onClick={() => stepTime(-0.1)}
            disabled={!metadata}
            className="h-8 rounded-lg border border-white/10 bg-white/[0.04] px-1.5 font-mono text-[11px] tabular-nums text-slate-400 hover:bg-white/10 disabled:opacity-40"
            title="Retroceder 1 fotograma (100ms)"
          >
            -0.1s
          </button>

          <button
            type="button"
            onClick={() => stepTime(0.1)}
            disabled={!metadata}
            className="h-8 rounded-lg border border-white/10 bg-white/[0.04] px-1.5 font-mono text-[11px] tabular-nums text-slate-400 hover:bg-white/10 disabled:opacity-40"
            title="Avanzar 1 fotograma (100ms)"
          >
            +0.1s
          </button>

          <button
            type="button"
            onClick={() => stepTime(1)}
            disabled={!metadata}
            className="h-8 rounded-lg border border-white/10 bg-white/[0.04] px-2 font-mono text-xs tabular-nums text-slate-300 hover:bg-white/10 disabled:opacity-40"
            title="Avanzar 1 segundo"
          >
            +1s
          </button>

          <button
            type="button"
            onClick={() => stepTime(5)}
            disabled={!metadata}
            className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
            title="Avanzar 5 segundos"
          >
            <span className="tabular-nums">5s</span>
            <RotateCw className="h-3 w-3" />
          </button>

          {/* Loop Range */}
          <button
            type="button"
            onClick={handleToggleLoop}
            disabled={!metadata}
            className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-xs font-medium transition ${
              loopSelection
                ? "border-indigo-500/60 bg-indigo-500/20 text-indigo-200"
                : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
            } disabled:opacity-40`}
            title="Repetir el rango en bucle (L)"
          >
            <Repeat className="h-3 w-3" />
            <span>Bucle</span>
          </button>

          {/* Stop playback at clip end */}
          <button
            type="button"
            onClick={handleToggleStopAtEnd}
            disabled={!metadata}
            className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-xs font-medium transition whitespace-nowrap ${
              stopAtClipEnd
                ? "border-amber-500/60 bg-amber-500/20 text-amber-200"
                : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
            } disabled:opacity-40`}
            title="Detener la reproducción automáticamente al llegar al final del clip"
          >
            <StopCircle className="h-3 w-3" />
            <span>Parar al fin</span>
          </button>

          {/* Volume toggle */}
          <button
            type="button"
            onClick={handleToggleMute}
            disabled={!metadata}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-400 hover:text-white transition disabled:opacity-40"
            title={muted ? "Activar sonido" : "Silenciar"}
          >
            {muted ? (
              <VolumeX className="h-3.5 w-3.5 text-rose-400" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </button>

          {/* Speed selector */}
          <select
            value={playbackRate}
            disabled={!metadata}
            onChange={(e) => handleRateChange(parseFloat(e.target.value))}
            className="h-8 rounded-lg border border-white/10 bg-[#09090B] px-1.5 font-mono text-[11px] text-slate-300 outline-none hover:border-white/20 disabled:opacity-40"
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1.0x</option>
            <option value={1.25}>1.25x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2.0x</option>
          </select>
        </div>

        {/* Right: In / Out Marking buttons & Add Clip */}
        <div className="flex items-center gap-2">
          {/* Mark IN [ I ] */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={markInAtCurrent}
            disabled={!metadata}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-600/15 px-3 text-xs font-semibold text-indigo-200 hover:bg-indigo-600/30 hover:border-indigo-500/50 transition disabled:opacity-40"
            title="Marcar Inicio aquí (Atajo: tecla [ I ])"
          >
            <MapPin className="h-3.5 w-3.5 text-indigo-400" />
            <span>Inicio</span>
            <span className="rounded bg-indigo-500/25 px-1 py-0.2 font-mono text-[10px] text-indigo-300">
              [ I ]
            </span>
          </motion.button>

          {/* Mark OUT [ O ] */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={markOutAtCurrent}
            disabled={!metadata}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-600/15 px-3 text-xs font-semibold text-indigo-200 hover:bg-indigo-600/30 hover:border-indigo-500/50 transition disabled:opacity-40"
            title="Marcar Fin aquí (Atajo: tecla [ O ])"
          >
            <Flag className="h-3.5 w-3.5 text-indigo-400" />
            <span>Fin</span>
            <span className="rounded bg-indigo-500/25 px-1 py-0.2 font-mono text-[10px] text-indigo-300">
              [ O ]
            </span>
          </motion.button>

          {/* Clip Insertion Number (optional ordinal position) */}
          <div
            className="relative flex items-center"
            title={`Número donde insertar este clip (vacío = #${nextDefaultClipNumber}; si pones otro número, los demás se recorren automáticamente)`}
          >
            <span className="pointer-events-none absolute left-2 font-mono text-[11px] font-bold text-indigo-400">
              #
            </span>
            <input
              id="clip-position-input"
              type="number"
              min={clipStartIndex}
              max={nextDefaultClipNumber}
              value={clipNumberInput}
              onChange={(e) => setClipNumberInput(e.target.value)}
              placeholder={String(nextDefaultClipNumber)}
              disabled={!metadata}
              className="h-9 w-16 rounded-lg border border-white/10 bg-[#09090B] pl-5 pr-1.5 text-center font-mono text-xs font-bold text-indigo-300 placeholder-slate-500 outline-none focus:border-indigo-500/60 transition-all disabled:opacity-40"
            />
          </div>

          {/* Clip Name Optional Input */}
          <div className="relative">
            <input
              id="clip-name-input"
              type="text"
              value={clipNameInput}
              onChange={(e) => setClipNameInput(e.target.value)}
              placeholder="Nombre del clip..."
              disabled={!metadata}
              className="h-9 w-28 rounded-lg border border-white/10 bg-[#09090B] px-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500/60 focus:w-36 transition-all disabled:opacity-40"
            />
          </div>

          {/* "+ Añadir a la lista" Button */}
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            type="button"
            onClick={handleAddCurrentClip}
            disabled={!metadata || selectionDuration <= 0}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-3.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-400 hover:to-violet-500 transition disabled:cursor-not-allowed disabled:opacity-40"
            title="Añadir este segmento a la cola de clips (Atajo: Enter)"
          >
            <Plus className="h-4 w-4 stroke-[2.5]" />
            <span>+ Añadir a la lista</span>
          </motion.button>
        </div>
      </div>
    </section>
  );
};
