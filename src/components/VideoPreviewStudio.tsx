import React, { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import {
  AlertTriangle,
  AudioLines,
  Download,
  ExternalLink,
  Flag,
  Loader2,
  MapPin,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Youtube,
} from "lucide-react";
import type { ClipSegment, VideoMetadata } from "../types";
import { formatTimeShort, formatTimecode, parseTimecode } from "../utils/time";

type PlayerSourceMode = "mp4" | "webm" | "embed";

interface VideoPreviewStudioProps {
  metadata: VideoMetadata;
  clips: ClipSegment[];
  activeStart: number;
  activeEnd: number;
  selectedAudioTrackId: string | null;
  onSelectAudioTrack: (trackId: string) => void;
  onActiveRangeChange: (start: number, end: number) => void;
  onAddClip: (name: string, start: number, end: number) => void;
  onDownloadSelectionNow: (name: string, start: number, end: number) => void;
  seekRequest: { time: number; autoplay?: boolean; nonce: number } | null;
}

const CLIP_COLORS = [
  "bg-violet-500/35 border-violet-400/70",
  "bg-cyan-500/35 border-cyan-400/70",
  "bg-emerald-500/35 border-emerald-400/70",
  "bg-amber-500/35 border-amber-400/70",
  "bg-pink-500/35 border-pink-400/70",
];

function initialSourceMode(meta: VideoMetadata): PlayerSourceMode {
  if (meta.preview_stream_url) return "mp4";
  if (meta.preview_webm_url) return "webm";
  return "embed";
}

function isHlsUrl(url: string | null | undefined): url is string {
  return Boolean(url && url.includes(".m3u8"));
}

/**
 * Attaches an HLS (.m3u8) stream via hls.js (or native HLS if supported) to an
 * HTMLMediaElement and recovers once from transient network or media decoding errors.
 */
function attachHlsMedia(
  media: HTMLMediaElement,
  url: string,
  onFatalError?: () => void
): () => void {
  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
    });
    let recoveredNetwork = false;
    let recoveredMedia = false;

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recoveredNetwork) {
        recoveredNetwork = true;
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
        recoveredMedia = true;
        hls.recoverMediaError();
        return;
      }
      hls.destroy();
      onFatalError?.();
    });

    hls.loadSource(url);
    hls.attachMedia(media);
    return () => {
      hls.destroy();
    };
  }

  if (media.canPlayType("application/vnd.apple.mpegurl")) {
    media.src = url;
    return () => {
      media.removeAttribute("src");
      media.load();
    };
  }

  onFatalError?.();
  return () => {};
}

export const VideoPreviewStudio: React.FC<VideoPreviewStudioProps> = ({
  metadata,
  clips,
  activeStart,
  activeEnd,
  selectedAudioTrackId,
  onSelectAudioTrack,
  onActiveRangeChange,
  onAddClip,
  onDownloadSelectionNow,
  seekRequest,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const seekDebounceTimerRef = useRef<number | null>(null);
  const isUserScrubbingRef = useRef(false);

  const [playerMode, setPlayerMode] = useState<PlayerSourceMode>(() =>
    initialSourceMode(metadata)
  );
  const [streamError, setStreamError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingStream, setIsLoadingStream] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [scrubbingTime, setScrubbingTime] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopSelection, setLoopSelection] = useState(false);

  const [scrubberHover, setScrubberHover] = useState<{
    time: number;
    pct: number;
  } | null>(null);
  const [timelineHover, setTimelineHover] = useState<{
    time: number;
    pct: number;
  } | null>(null);

  const [clipName, setClipName] = useState("");
  const [startText, setStartText] = useState(formatTimecode(activeStart));
  const [endText, setEndText] = useState(formatTimecode(activeEnd));
  const [dragMode, setDragMode] = useState<"playhead" | "start" | "end" | null>(
    null
  );

  const duration = Math.max(metadata.duration || 1, 1);
  const nativeMode = playerMode !== "embed";
  const activeStreamUrl =
    playerMode === "mp4"
      ? metadata.preview_stream_url
      : playerMode === "webm"
      ? metadata.preview_webm_url
      : null;

  const activeAudioTrack =
    metadata.audio_tracks.find((t) => t.track_id === selectedAudioTrackId) ??
    metadata.audio_tracks[0] ??
    null;
  const activeAudioUrl =
    activeAudioTrack?.preview_url ?? metadata.preview_audio_url;

  const hasAudioTrack = nativeMode && Boolean(activeAudioUrl);

  // ── Refs del motor de sincronización (nunca quedan desactualizados) ──────
  const wantPlayRef = useRef(false);
  const hasAudioRef = useRef(hasAudioTrack);
  hasAudioRef.current = hasAudioTrack;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const rateRef = useRef(playbackRate);
  rateRef.current = playbackRate;
  const loopRef = useRef({ enabled: loopSelection, start: activeStart, end: activeEnd });
  loopRef.current = { enabled: loopSelection, start: activeStart, end: activeEnd };
  const pendingResumeRef = useRef<number | null>(null);
  const lastSeekNonceRef = useRef<number | null>(null);
  const lastSeekTargetRef = useRef<number | null>(null);
  const videoStalledRef = useRef(false);
  const lastVideoTimeRef = useRef<number>(0);
  const lastVideoAdvanceMsRef = useRef<number>(0);
  const lastVideoFramesRef = useRef<number>(-1);
  const lastAudioSeekMsRef = useRef<number>(0);
  const lastDecoderNudgeMsRef = useRef<number>(0);
  const scrubValueRef = useRef<number | null>(null);
  const handleVideoElementErrorRef = useRef<() => void>(() => {});

  const handleAudioTrackChange = (newTrackId: string) => {
    onSelectAudioTrack(newTrackId);
  };

  useEffect(() => {
    wantPlayRef.current = false;
    pendingResumeRef.current = null;
    lastSeekTargetRef.current = null;
    videoStalledRef.current = false;
    lastVideoTimeRef.current = 0;
    lastVideoAdvanceMsRef.current = 0;
    lastVideoFramesRef.current = -1;
    lastAudioSeekMsRef.current = 0;
    lastDecoderNudgeMsRef.current = 0;
    setPlayerMode(initialSourceMode(metadata));
    setStreamError(false);
    setCurrentTime(0);
    setIsPlaying(false);
    setIsLoadingStream(false);
  }, [
    metadata.id,
    metadata.preview_stream_url,
    metadata.preview_webm_url,
  ]);

  /**
   * Motor maestro de sincronización.
   * El VIDEO es el reloj maestro; el AUDIO lo sigue sin pausar jamás al video.
   * Detecta eventos `waiting`, falta de movimiento de `currentTime` y fotogramas
   * congelados (`getVideoPlaybackQuality().totalVideoFrames`) para silenciar el
   * audio de inmediato y desatascar el decodificador si queda pegado.
   */
  const syncPlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const a = hasAudioRef.current ? audioRef.current : null;

    // Enrutado del sonido: si hay pista de audio dedicada, el video va mudo y audio lleva el sonido.
    const wantVideoMuted = a ? true : mutedRef.current;
    if (v.muted !== wantVideoMuted) v.muted = wantVideoMuted;
    if (a) {
      if (a.muted !== mutedRef.current) a.muted = mutedRef.current;
      if (a.volume !== 1) a.volume = 1;
    }

    const now = performance.now();
    const quality =
      typeof v.getVideoPlaybackQuality === "function"
        ? v.getVideoPlaybackQuality()
        : null;
    const totalFrames = quality ? quality.totalVideoFrames : -1;
    const timeDelta = Math.abs(v.currentTime - lastVideoTimeRef.current);
    const framesAdvanced =
      totalFrames < 0 ||
      totalFrames !== lastVideoFramesRef.current ||
      lastVideoFramesRef.current <= 0;

    if (timeDelta > 0.004 && framesAdvanced) {
      lastVideoTimeRef.current = v.currentTime;
      if (totalFrames >= 0) lastVideoFramesRef.current = totalFrames;
      lastVideoAdvanceMsRef.current = now;
      videoStalledRef.current = false;
    }

    if (!wantPlayRef.current) {
      if (!v.paused) v.pause();
      if (a && !a.paused) a.pause();
      if (
        a &&
        !v.seeking &&
        !a.seeking &&
        a.readyState >= 1 &&
        Math.abs(a.currentTime - v.currentTime) > 0.08
      ) {
        a.currentTime = v.currentTime;
      }
      setIsLoadingStream(v.seeking || Boolean(a && a.seeking));
      return;
    }

    // El video maestro nunca se pausa mientras wantPlayRef esté activo.
    if (v.playbackRate !== rateRef.current) v.playbackRate = rateRef.current;
    if (!v.seeking && v.readyState >= 2 && v.paused) {
      lastVideoAdvanceMsRef.current = now;
      void v.play().catch(() => {});
    }

    const msSinceVideoMoved = now - lastVideoAdvanceMsRef.current;

    // Si el reloj avanza pero los fotogramas reales siguen congelados >750ms, forzar resincronización GOP.
    if (
      !v.paused &&
      !v.seeking &&
      v.readyState >= 3 &&
      timeDelta > 0.004 &&
      !framesAdvanced &&
      msSinceVideoMoved > 750 &&
      now - lastDecoderNudgeMsRef.current > 2500
    ) {
      lastDecoderNudgeMsRef.current = now;
      lastVideoAdvanceMsRef.current = now;
      v.currentTime = v.currentTime;
      if (a && !a.paused) a.pause();
      setIsLoadingStream(true);
      return;
    }

    const videoActivelyPlaying =
      !v.paused &&
      !v.seeking &&
      v.readyState >= 3 &&
      !videoStalledRef.current &&
      msSinceVideoMoved <= 260;

    if (!videoActivelyPlaying) {
      // El video está buscando, recargando o congelado en un frame -> silenciar audio al instante.
      if (a && !a.paused) a.pause();
      if (
        a &&
        !v.seeking &&
        !a.seeking &&
        a.readyState >= 1 &&
        Math.abs(a.currentTime - v.currentTime) > 0.2 &&
        now - lastAudioSeekMsRef.current > 400
      ) {
        lastAudioSeekMsRef.current = now;
        a.currentTime = v.currentTime;
      }
      setIsLoadingStream(true);
      return;
    }

    // Video rindiendo fotogramas activamente -> sincronizar audio esclavo sin pausar video.
    if (a) {
      if (a.seeking || a.readyState < 2) {
        setIsLoadingStream(true);
        return;
      }
      const drift = a.currentTime - v.currentTime;
      if (Math.abs(drift) > 0.28 && now - lastAudioSeekMsRef.current > 650) {
        lastAudioSeekMsRef.current = now;
        a.currentTime = v.currentTime;
        a.playbackRate = rateRef.current;
        return;
      }
      if (Math.abs(drift) > 0.09) {
        a.playbackRate = rateRef.current * (drift > 0 ? 0.97 : 1.03);
      } else if (a.playbackRate !== rateRef.current) {
        a.playbackRate = rateRef.current;
      }
      if (a.paused) void a.play().catch(() => {});
    }

    setIsLoadingStream(false);
    if (!isUserScrubbingRef.current) {
      setCurrentTime(v.currentTime);
    }
  }, []);

  useEffect(() => {
    if (!nativeMode) return;
    const id = window.setInterval(syncPlayback, 100);
    return () => window.clearInterval(id);
  }, [nativeMode, syncPlayback]);

  useEffect(() => {
    syncPlayback();
  }, [muted, playbackRate, activeAudioUrl, syncPlayback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || playerMode === "embed" || streamError || !isHlsUrl(activeStreamUrl)) {
      return;
    }
    return attachHlsMedia(video, activeStreamUrl, () => {
      handleVideoElementErrorRef.current();
    });
  }, [playerMode, streamError, activeStreamUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !hasAudioTrack || !isHlsUrl(activeAudioUrl)) {
      return;
    }
    return attachHlsMedia(audio, activeAudioUrl);
  }, [hasAudioTrack, activeAudioUrl, playerMode, streamError, activeStreamUrl]);

  useEffect(() => {
    setStartText(formatTimecode(activeStart));
    setEndText(formatTimecode(activeEnd));
  }, [activeStart, activeEnd]);

  const seekTo = useCallback(
    (time: number, immediate = true) => {
      const clamped = Math.max(0, Math.min(time, duration));
      setCurrentTime(clamped);

      if (seekDebounceTimerRef.current) {
        clearTimeout(seekDebounceTimerRef.current);
        seekDebounceTimerRef.current = null;
      }

      const applySeek = () => {
        const v = videoRef.current;
        if (!v || playerMode === "embed") return;
        const a = hasAudioRef.current ? audioRef.current : null;

        // Evitar cancelar una búsqueda en curso al exactamente mismo segundo (click/up)
        if (
          v.seeking &&
          lastSeekTargetRef.current != null &&
          Math.abs(lastSeekTargetRef.current - clamped) < 0.05 &&
          (!a || Math.abs(a.currentTime - clamped) < 0.08)
        ) {
          return;
        }

        lastSeekTargetRef.current = clamped;
        videoStalledRef.current = false;
        lastVideoTimeRef.current = clamped;
        lastVideoAdvanceMsRef.current = performance.now();
        lastVideoFramesRef.current = -1;

        // Pausar ambos inmediatamente durante el salto para que ninguno reproduzca datos viejos
        if (!v.paused) v.pause();
        if (a && !a.paused) a.pause();
        v.currentTime = clamped;
        if (a && a.readyState >= 1) {
          lastAudioSeekMsRef.current = performance.now();
          a.currentTime = clamped;
        }
        setIsLoadingStream(true);
        syncPlayback();
      };

      if (immediate) {
        applySeek();
      } else {
        seekDebounceTimerRef.current = window.setTimeout(applySeek, 50);
      }
    },
    [duration, playerMode, syncPlayback]
  );

  const startPlayback = () => {
    const v = videoRef.current;
    if (!v || playerMode === "embed") return;
    const lp = loopRef.current;
    if (lp.enabled && (v.currentTime < lp.start || v.currentTime >= lp.end)) {
      seekTo(lp.start, true);
    }
    videoStalledRef.current = false;
    lastVideoAdvanceMsRef.current = performance.now();
    wantPlayRef.current = true;
    setIsPlaying(true);
    const a = hasAudioRef.current ? audioRef.current : null;
    if (a) {
      a.muted = mutedRef.current;
      a.volume = 1;
      if (a.readyState >= 1 && Math.abs(a.currentTime - v.currentTime) > 0.1) {
        a.currentTime = v.currentTime;
      }
      if (!v.seeking && !a.seeking && v.readyState >= 2 && a.readyState >= 2) {
        void a.play().catch(() => {});
      }
    }
    if (!v.seeking && v.readyState >= 2) {
      void v.play().catch(() => {});
    }
    syncPlayback();
  };

  const stopPlayback = () => {
    wantPlayRef.current = false;
    setIsPlaying(false);
    syncPlayback();
  };

  useEffect(() => {
    if (!seekRequest || seekRequest.nonce === lastSeekNonceRef.current) return;
    lastSeekNonceRef.current = seekRequest.nonce;
    if (seekRequest.autoplay && playerMode !== "embed") {
      wantPlayRef.current = true;
      setIsPlaying(true);
    }
    seekTo(seekRequest.time, true);
  }, [seekRequest, seekTo, playerMode]);

  // Keyboard shortcuts (Space = Play/Pause, I = Mark Start, O = Mark End)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.code === "Space" && playerMode !== "embed") {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === "i") {
        e.preventDefault();
        markInAtCurrent();
      } else if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        markOutAtCurrent();
      } else if (e.key === "ArrowLeft" && playerMode !== "embed") {
        e.preventDefault();
        stepTime(e.shiftKey ? -1 : -5);
      } else if (e.key === "ArrowRight" && playerMode !== "embed") {
        e.preventDefault();
        stepTime(e.shiftKey ? 1 : 5);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Pointer dragging on interactive timeline
  useEffect(() => {
    if (!dragMode) return;
    let lastT: number | null = null;

    const handleMove = (e: PointerEvent) => {
      const el = timelineRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width)
      );
      const t = ratio * duration;

      if (dragMode === "playhead") {
        lastT = t;
        seekTo(t, false);
      } else if (dragMode === "start") {
        const nextStart = Math.min(t, Math.max(0, activeEnd - 0.25));
        lastT = nextStart;
        onActiveRangeChange(nextStart, activeEnd);
        seekTo(nextStart, false);
      } else if (dragMode === "end") {
        const nextEnd = Math.max(t, Math.min(duration, activeStart + 0.25));
        lastT = nextEnd;
        onActiveRangeChange(activeStart, nextEnd);
        seekTo(nextEnd, false);
      }
    };

    const handleUp = () => {
      if (lastT != null) seekTo(lastT, true);
      setDragMode(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragMode, duration, activeStart, activeEnd, onActiveRangeChange, seekTo]);

  const stepTime = (delta: number) => {
    const base =
      videoRef.current && playerMode !== "embed"
        ? videoRef.current.currentTime
        : currentTime;
    seekTo(base + delta, true);
  };

  const togglePlay = () => {
    if (playerMode === "embed") return;
    if (wantPlayRef.current) {
      stopPlayback();
    } else {
      startPlayback();
    }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    if (!isUserScrubbingRef.current && !v.seeking) {
      setCurrentTime(v.currentTime);
    }
    const lp = loopRef.current;
    if (lp.enabled && wantPlayRef.current && v.currentTime >= lp.end) {
      seekTo(lp.start, true);
    }
  };

  const getPlaybackPosition = () =>
    videoRef.current && playerMode !== "embed"
      ? videoRef.current.currentTime
      : currentTime;

  const markInAtCurrent = () => {
    const t = getPlaybackPosition();
    const nextEnd = t >= activeEnd ? Math.min(duration, t + 10) : activeEnd;
    onActiveRangeChange(t, nextEnd);
  };

  const markOutAtCurrent = () => {
    const t = getPlaybackPosition();
    const nextStart = t <= activeStart ? Math.max(0, t - 10) : activeStart;
    onActiveRangeChange(nextStart, t);
  };

  const adjustBound = (which: "start" | "end", delta: number) => {
    if (which === "start") {
      const next = Math.max(
        0,
        Math.min(activeStart + delta, Math.max(0, activeEnd - 0.2))
      );
      onActiveRangeChange(next, activeEnd);
      seekTo(next, true);
    } else {
      const next = Math.min(
        duration,
        Math.max(activeEnd + delta, activeStart + 0.2)
      );
      onActiveRangeChange(activeStart, next);
      seekTo(next, true);
    }
  };

  const previewSelection = () => {
    setLoopSelection(true);
    loopRef.current = { enabled: true, start: activeStart, end: activeEnd };
    seekTo(activeStart, true);
    startPlayback();
  };

  const switchStreamMode = (mode: PlayerSourceMode) => {
    pendingResumeRef.current = getPlaybackPosition();
    setStreamError(false);
    if (mode === "embed") {
      wantPlayRef.current = false;
      setIsPlaying(false);
      setIsLoadingStream(false);
    } else {
      setIsLoadingStream(true);
    }
    setPlayerMode(mode);
  };

  const handleVideoElementError = () => {
    if (playerMode === "mp4" && metadata.preview_webm_url) {
      switchStreamMode("webm");
    } else {
      setStreamError(true);
      setIsLoadingStream(false);
    }
  };
  handleVideoElementErrorRef.current = handleVideoElementError;

  const retryNativeStream = () => {
    setStreamError(false);
    setIsLoadingStream(true);
    pendingResumeRef.current = getPlaybackPosition();
    if (playerMode === "embed") {
      setPlayerMode(initialSourceMode(metadata));
    }
    videoRef.current?.load();
    if (hasAudioTrack) {
      audioRef.current?.load();
    }
  };

  const commitStartText = () => {
    const parsed = parseTimecode(startText);
    if (parsed == null) {
      setStartText(formatTimecode(activeStart));
      return;
    }
    const clamped = Math.max(
      0,
      Math.min(parsed, Math.max(0, activeEnd - 0.2))
    );
    onActiveRangeChange(clamped, activeEnd);
    seekTo(clamped, true);
  };

  const commitEndText = () => {
    const parsed = parseTimecode(endText);
    if (parsed == null) {
      setEndText(formatTimecode(activeEnd));
      return;
    }
    const clamped = Math.min(duration, Math.max(parsed, activeStart + 0.2));
    onActiveRangeChange(activeStart, clamped);
    seekTo(clamped, true);
  };

  const handleAdd = () => {
    const finalName = clipName.trim() || `Clip ${clips.length + 1}`;
    onAddClip(finalName, activeStart, activeEnd);
    setClipName("");
  };

  const handleDownloadSelection = () => {
    const finalName =
      clipName.trim() ||
      `Clip ${formatTimeShort(activeStart)}-${formatTimeShort(activeEnd)}`;
    onDownloadSelectionNow(finalName, activeStart, activeEnd);
  };

  const startPct = (activeStart / duration) * 100;
  const endPct = (activeEnd / duration) * 100;
  const playheadPct = (currentTime / duration) * 100;
  const selectionDuration = Math.max(0, activeEnd - activeStart);

  const rangeCards = [
    {
      key: "start" as const,
      title: "Inicio del Clip (IN)",
      accentText: "text-violet-300",
      accentBorder: "border-violet-500/30",
      accentSlider: "accent-violet-500",
      value: activeStart,
      text: startText,
      setText: setStartText,
      commit: commitStartText,
      onSlider: (v: number) => {
        const clamped = Math.min(v, Math.max(0, activeEnd - 0.2));
        onActiveRangeChange(clamped, activeEnd);
        seekTo(clamped, false);
      },
      onSliderCommit: (v: number) => {
        const clamped = Math.min(v, Math.max(0, activeEnd - 0.2));
        onActiveRangeChange(clamped, activeEnd);
        seekTo(clamped, true);
      },
    },
    {
      key: "end" as const,
      title: "Final del Clip (OUT)",
      accentText: "text-cyan-300",
      accentBorder: "border-cyan-500/30",
      accentSlider: "accent-cyan-500",
      value: activeEnd,
      text: endText,
      setText: setEndText,
      commit: commitEndText,
      onSlider: (v: number) => {
        const clamped = Math.max(v, Math.min(duration, activeStart + 0.2));
        onActiveRangeChange(activeStart, clamped);
        seekTo(clamped, false);
      },
      onSliderCommit: (v: number) => {
        const clamped = Math.max(v, Math.min(duration, activeStart + 0.2));
        onActiveRangeChange(activeStart, clamped);
        seekTo(clamped, true);
      },
    },
  ];

  return (
    <div className="studio-panel rounded-2xl p-4 sm:p-5 space-y-4">
      {/* Player Header & Source Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MonitorPlay className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white">
            Vista Previa en Vivo &amp; Selector de Clips
          </h3>
          <span className="hidden md:inline-block rounded-md bg-white/[0.05] px-2 py-0.5 text-[11px] text-slate-400">
            Atajos: <kbd className="text-slate-200">Espacio</kbd> Play •{" "}
            <kbd className="text-slate-200">I</kbd> Inicio •{" "}
            <kbd className="text-slate-200">O</kbd> Final
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {metadata.audio_tracks.length > 0 && (
            <div className="flex items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1">
              <AudioLines className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
              <span className="text-[11px] font-medium text-cyan-200">Audio:</span>
              <select
                value={activeAudioTrack?.track_id ?? ""}
                onChange={(e) => handleAudioTrackChange(e.target.value)}
                aria-label="Idioma o pista de audio"
                className="max-w-[180px] rounded-md bg-[#090A0F] px-2 py-0.5 text-xs font-medium text-white outline-none focus:ring-1 focus:ring-cyan-400"
              >
                {metadata.audio_tracks.map((track) => (
                  <option key={track.track_id} value={track.track_id}>
                    {track.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-[#090A0F] p-1">
            <button
              type="button"
              disabled={!metadata.preview_stream_url}
              onClick={() => switchStreamMode("mp4")}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                playerMode === "mp4"
                  ? "border border-violet-500/40 bg-violet-600/30 text-violet-200"
                  : "text-slate-400 hover:text-white disabled:opacity-40"
              }`}
            >
              <MonitorPlay className="h-3.5 w-3.5" />
              <span>Stream MP4</span>
            </button>
            <button
              type="button"
              disabled={!metadata.preview_webm_url}
              onClick={() => switchStreamMode("webm")}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                playerMode === "webm"
                  ? "border border-cyan-500/40 bg-cyan-600/30 text-cyan-200"
                  : "text-slate-400 hover:text-white disabled:opacity-40"
              }`}
            >
              <MonitorPlay className="h-3.5 w-3.5" />
              <span>Stream WebM</span>
            </button>
            <button
              type="button"
              onClick={() => switchStreamMode("embed")}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                playerMode === "embed"
                  ? "border border-rose-500/40 bg-rose-600/30 text-rose-200"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Youtube className="h-3.5 w-3.5" />
              <span>Embed</span>
            </button>
          </div>
        </div>
      </div>

      {/* Video Player Viewport */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-black">
        {playerMode !== "embed" && activeStreamUrl && !streamError ? (
          <>
            <video
              key={activeStreamUrl}
              ref={videoRef}
              src={isHlsUrl(activeStreamUrl) ? undefined : (activeStreamUrl ?? undefined)}
              poster={metadata.thumbnail || undefined}
              preload="auto"
              muted={muted || hasAudioTrack}
              playsInline
              onClick={togglePlay}
              onLoadedMetadata={() => {
                const v = videoRef.current;
                const resume = pendingResumeRef.current;
                const a = audioRef.current;
                if (v && resume != null) {
                  pendingResumeRef.current = null;
                  v.currentTime = resume;
                  if (a && a.readyState >= 1 && Math.abs(a.currentTime - resume) > 0.08) {
                    a.currentTime = resume;
                  }
                } else if (
                  v &&
                  a &&
                  a.readyState >= 1 &&
                  Math.abs(a.currentTime - v.currentTime) > 0.08
                ) {
                  a.currentTime = v.currentTime;
                }
                syncPlayback();
              }}
              onWaiting={() => {
                if (wantPlayRef.current) {
                  videoStalledRef.current = true;
                  setIsLoadingStream(true);
                  const a = audioRef.current;
                  if (a && !a.paused) a.pause();
                }
                syncPlayback();
              }}
              onSeeking={() => {
                setIsLoadingStream(true);
                const a = audioRef.current;
                if (a && !a.paused) a.pause();
              }}
              onSeeked={() => {
                videoStalledRef.current = false;
                syncPlayback();
              }}
              onCanPlay={() => {
                videoStalledRef.current = false;
                syncPlayback();
              }}
              onCanPlayThrough={() => {
                videoStalledRef.current = false;
                syncPlayback();
              }}
              onPlaying={() => {
                videoStalledRef.current = false;
                syncPlayback();
              }}
              onEnded={() => {
                videoStalledRef.current = false;
                wantPlayRef.current = false;
                setIsPlaying(false);
                syncPlayback();
              }}
              onTimeUpdate={handleTimeUpdate}
              onError={handleVideoElementError}
              className="h-full w-full cursor-pointer object-contain"
            />
            {hasAudioTrack && activeAudioUrl && (
              <audio
                key={activeAudioUrl}
                ref={audioRef}
                src={isHlsUrl(activeAudioUrl) ? undefined : activeAudioUrl}
                preload="auto"
                muted={muted}
                onLoadedMetadata={() => {
                  const a = audioRef.current;
                  const v = videoRef.current;
                  if (a && v) {
                    a.currentTime = v.currentTime;
                    a.playbackRate = rateRef.current;
                  }
                  syncPlayback();
                }}
                onCanPlay={syncPlayback}
                onCanPlayThrough={syncPlayback}
                onSeeked={syncPlayback}
                onWaiting={syncPlayback}
                className="hidden"
              />
            )}

            {/* Loading Spinner in Preview */}
            {isLoadingStream && (
              <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/50 backdrop-blur-[2px] transition-all duration-150">
                <Loader2 className="h-10 w-10 animate-spin text-cyan-400 drop-shadow-[0_0_12px_rgba(34,211,238,0.7)]" />
                <span className="mt-2.5 rounded-full border border-white/10 bg-black/80 px-3.5 py-1 text-xs font-semibold text-slate-100 shadow-lg">
                  Cargando vista previa...
                </span>
              </div>
            )}

            {/* Big centered play button when paused and not loading */}
            {!isPlaying && !isLoadingStream && (
              <button
                type="button"
                onClick={togglePlay}
                aria-label="Reproducir vista previa"
                className="absolute inset-0 m-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white shadow-2xl backdrop-blur-md transition hover:scale-105 hover:bg-violet-600/80"
              >
                <Play className="ml-1 h-7 w-7 fill-current" />
              </button>
            )}
          </>
        ) : playerMode !== "embed" && streamError ? (
          <div className="relative flex h-full w-full flex-col items-center justify-center p-6 text-center">
            {metadata.thumbnail && (
              <img
                src={metadata.thumbnail}
                alt={metadata.title}
                className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20 blur-sm"
              />
            )}
            <div className="relative z-10 max-w-md space-y-3 rounded-2xl border border-white/10 bg-[#090A0F]/90 p-5 backdrop-blur-md">
              <AlertTriangle className="mx-auto h-7 w-7 text-amber-400" />
              <h4 className="text-sm font-semibold text-white">
                Error cargando el stream directo
              </h4>
              <p className="text-xs text-slate-300">
                Puedes reintentar la conexión al proxy local, cambiar de formato o usar Embed YouTube.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={retryNativeStream}
                  className="studio-gradient-btn rounded-lg px-4 py-2 text-xs font-semibold text-white"
                >
                  Reintentar Stream
                </button>
                {metadata.preview_webm_url && playerMode === "mp4" && (
                  <button
                    type="button"
                    onClick={() => switchStreamMode("webm")}
                    className="rounded-lg border border-cyan-500/35 bg-cyan-500/15 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25"
                  >
                    Probar WebM
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => switchStreamMode("embed")}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10"
                >
                  Usar Embed
                </button>
              </div>
            </div>
          </div>
        ) : (
          <iframe
            src={metadata.embed_url}
            title={metadata.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="h-full w-full border-0"
          />
        )}

        {/* Current Time Overlay Badge */}
        {playerMode !== "embed" && !streamError && (
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-white/10 bg-black/70 px-2.5 py-1 font-mono text-xs text-white backdrop-blur-md">
            <span className="h-2 w-2 rounded-full bg-cyan-400" />
            <span>{formatTimecode(currentTime)}</span>
            <span className="text-slate-400">/ {formatTimeShort(duration)}</span>
          </div>
        )}
      </div>

      {/* Dedicated Video Position Scrubber + Transport Controls */}
      {playerMode !== "embed" && (
        <div className="space-y-2.5 rounded-xl border border-white/10 bg-[#090A0F]/85 p-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-cyan-300 w-20">
              {formatTimecode(currentTime)}
            </span>
            <div
              className="relative flex-1 flex items-center py-2 group cursor-pointer"
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(
                  0,
                  Math.min(1, (e.clientX - rect.left) / rect.width)
                );
                const t = ratio * duration;
                setScrubbingTime(t);
                seekTo(t, true);
              }}
              onPointerMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(
                  0,
                  Math.min(1, (e.clientX - rect.left) / rect.width)
                );
                setScrubberHover({ time: ratio * duration, pct: ratio * 100 });
              }}
              onPointerLeave={() => setScrubberHover(null)}
            >
              <input
                type="range"
                min={0}
                max={duration}
                step={0.05}
                value={Math.min(scrubbingTime ?? currentTime, duration)}
                onPointerDown={(e) => {
                  isUserScrubbingRef.current = true;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = Math.max(
                    0,
                    Math.min(1, (e.clientX - rect.left) / rect.width)
                  );
                  const t = ratio * duration;
                  scrubValueRef.current = t;
                  setScrubbingTime(t);
                  seekTo(t, true);
                }}
                onPointerUp={() => {
                  isUserScrubbingRef.current = false;
                  if (scrubValueRef.current != null) {
                    seekTo(scrubValueRef.current, true);
                  }
                  scrubValueRef.current = null;
                  setScrubbingTime(null);
                }}
                onLostPointerCapture={() => {
                  if (!isUserScrubbingRef.current) return;
                  isUserScrubbingRef.current = false;
                  if (scrubValueRef.current != null) {
                    seekTo(scrubValueRef.current, true);
                  }
                  scrubValueRef.current = null;
                  setScrubbingTime(null);
                }}
                onChange={(e) => {
                  const val = Number.parseFloat(e.target.value);
                  scrubValueRef.current = val;
                  setScrubbingTime(val);
                  // Mientras se arrastra se agrupan los saltos para no saturar la red
                  seekTo(val, !isUserScrubbingRef.current);
                }}
                aria-label="Posición actual del video"
                className="h-2 w-full cursor-pointer accent-cyan-400"
              />

              {/* Hover Tooltip and Hover Guide Line */}
              {scrubberHover && (
                <>
                  <div
                    style={{ left: `${scrubberHover.pct}%` }}
                    className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 z-30 flex flex-col items-center"
                  >
                    <span className="rounded-md border border-cyan-500/40 bg-black/95 px-2 py-0.5 font-mono text-[11px] font-semibold text-cyan-200 shadow-xl backdrop-blur-sm whitespace-nowrap">
                      {formatTimecode(scrubberHover.time)}
                    </span>
                    <div className="w-1.5 h-1.5 border-r border-b border-cyan-500/40 bg-black rotate-45 -mt-1" />
                  </div>
                  <div
                    style={{ left: `${scrubberHover.pct}%` }}
                    className="pointer-events-none absolute top-1 bottom-1 w-px bg-cyan-400/60 shadow-[0_0_4px_rgba(34,211,238,0.8)] z-10"
                  />
                </>
              )}
            </div>
            <span className="font-mono text-[11px] text-slate-400 w-16 text-right">
              {formatTimeShort(duration)}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={togglePlay}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 text-white transition hover:bg-violet-500"
                title={isPlaying ? "Pausar" : "Reproducir"}
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="ml-0.5 h-4 w-4" />
                )}
              </button>

              <button
                type="button"
                onClick={() => stepTime(-5)}
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-slate-300 hover:bg-white/[0.1]"
              >
                <RotateCcw className="h-3 w-3" />
                <span>5s</span>
              </button>
              <button
                type="button"
                onClick={() => stepTime(-1)}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-slate-300 hover:bg-white/[0.1]"
              >
                -1s
              </button>
              <button
                type="button"
                onClick={() => stepTime(-0.1)}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-slate-300 hover:bg-white/[0.1]"
              >
                -0.1s
              </button>
              <button
                type="button"
                onClick={() => stepTime(0.1)}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-slate-300 hover:bg-white/[0.1]"
              >
                +0.1s
              </button>
              <button
                type="button"
                onClick={() => stepTime(1)}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-slate-300 hover:bg-white/[0.1]"
              >
                +1s
              </button>
              <button
                type="button"
                onClick={() => stepTime(5)}
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-slate-300 hover:bg-white/[0.1]"
              >
                <span>5s</span>
                <RotateCw className="h-3 w-3" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLoopSelection((v) => !v)}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                  loopSelection
                    ? "border-violet-500/50 bg-violet-500/20 text-violet-200"
                    : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
                }`}
                title="Repetir el rango seleccionado en bucle"
              >
                <Repeat className="h-3.5 w-3.5" />
                <span>Bucle</span>
              </button>

              <select
                value={playbackRate}
                onChange={(e) =>
                  setPlaybackRate(Number.parseFloat(e.target.value))
                }
                className="rounded-lg border border-white/10 bg-[#0D101A] px-2 py-1.5 text-xs text-slate-200 outline-none"
              >
                <option value={0.5}>0.5x</option>
                <option value={1}>1.0x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
                <option value={2}>2.0x</option>
              </select>

              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-slate-300 hover:text-white"
                title={muted ? "Activar sonido" : "Silenciar"}
              >
                {muted ? (
                  <VolumeX className="h-4 w-4 text-rose-400" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prominent Mark Start / Mark End Buttons Around Current Video Position */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <button
          type="button"
          onClick={markInAtCurrent}
          className="flex items-center justify-center gap-2 rounded-xl border border-violet-500/45 bg-violet-600/20 px-4 py-3 text-xs font-semibold text-violet-100 transition hover:bg-violet-600/35"
        >
          <MapPin className="h-4 w-4 text-violet-300" />
          <span>
            Marcar INICIO aquí ({formatTimecode(getPlaybackPosition())})
          </span>
        </button>

        <button
          type="button"
          onClick={markOutAtCurrent}
          className="flex items-center justify-center gap-2 rounded-xl border border-cyan-500/45 bg-cyan-600/20 px-4 py-3 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-600/35"
        >
          <Flag className="h-4 w-4 text-cyan-300" />
          <span>
            Marcar FINAL aquí ({formatTimecode(getPlaybackPosition())})
          </span>
        </button>

        <button
          type="button"
          onClick={previewSelection}
          disabled={playerMode === "embed"}
          className="flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-600/20 px-4 py-3 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-600/35 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Play className="h-4 w-4 text-emerald-300" />
          <span>Probar Selección ({selectionDuration.toFixed(1)}s)</span>
        </button>
      </div>

      {/* Interactive Multi-Clip Timeline */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>
            Línea de Tiempo Multi-Clip (arrastra las manijas violeta/cian o haz clic para saltar)
          </span>
          <span className="font-mono text-cyan-300">
            Duración seleccionada: {formatTimecode(selectionDuration)}
          </span>
        </div>

        <div
          ref={timelineRef}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(
              0,
              Math.min(1, (e.clientX - rect.left) / rect.width)
            );
            setTimelineHover({ time: ratio * duration, pct: ratio * 100 });
          }}
          onPointerLeave={() => setTimelineHover(null)}
          onPointerDown={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-drag-handle]")) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(
              0,
              Math.min(1, (e.clientX - rect.left) / rect.width)
            );
            seekTo(ratio * duration, true);
            setDragMode("playhead");
          }}
          className="relative h-14 w-full cursor-pointer select-none overflow-hidden rounded-xl border border-white/10 bg-[#08090E]"
        >
          <div
            data-track="true"
            className="pointer-events-none absolute inset-0 flex justify-between px-2 opacity-20"
          >
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((tick) => (
              <div key={tick} className="h-full w-px bg-slate-500" />
            ))}
          </div>

          {metadata.chapters.map((ch, idx) => (
            <div
              key={`ch-${idx}`}
              style={{ left: `${(ch.start_time / duration) * 100}%` }}
              title={`Capítulo: ${ch.title}`}
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-amber-400/40"
            />
          ))}

          {clips.map((clip, idx) => {
            const cLeft = (clip.start_time / duration) * 100;
            const cWidth = Math.max(
              0.5,
              ((clip.end_time - clip.start_time) / duration) * 100
            );
            const colorClass = CLIP_COLORS[idx % CLIP_COLORS.length];
            return (
              <div
                key={clip.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onActiveRangeChange(clip.start_time, clip.end_time);
                  seekTo(clip.start_time);
                }}
                style={{ left: `${cLeft}%`, width: `${cWidth}%` }}
                title={`${clip.name} (${formatTimeShort(clip.start_time)} - ${formatTimeShort(clip.end_time)})`}
                className={`absolute top-1.5 bottom-1.5 flex items-end rounded-md border px-1 pb-0.5 transition hover:brightness-125 ${colorClass}`}
              >
                <span className="truncate text-[9px] font-semibold text-white/90">
                  {clip.name}
                </span>
              </div>
            );
          })}

          {/* Active Selection Range */}
          <div
            data-track="true"
            style={{
              left: `${startPct}%`,
              width: `${Math.max(0.4, endPct - startPct)}%`,
            }}
            className="absolute top-0 bottom-0 border-y-2 border-cyan-400 bg-gradient-to-r from-violet-500/30 to-cyan-500/30"
          >
            <div
              data-drag-handle="true"
              onPointerDown={(e) => {
                e.stopPropagation();
                setDragMode("start");
              }}
              title="Arrastrar inicio del clip"
              className="absolute -left-1.5 top-0 bottom-0 flex w-3.5 cursor-ew-resize items-center justify-center rounded-l bg-violet-500 shadow-lg hover:bg-violet-400"
            >
              <div className="h-5 w-0.5 rounded-full bg-white" />
            </div>

            <div
              data-drag-handle="true"
              onPointerDown={(e) => {
                e.stopPropagation();
                setDragMode("end");
              }}
              title="Arrastrar final del clip"
              className="absolute -right-1.5 top-0 bottom-0 flex w-3.5 cursor-ew-resize items-center justify-center rounded-r bg-cyan-500 shadow-lg hover:bg-cyan-400"
            >
              <div className="h-5 w-0.5 rounded-full bg-white" />
            </div>
          </div>

          {/* Playhead */}
          <div
            style={{ left: `${playheadPct}%` }}
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]"
          >
            <div className="-ml-1.5 h-2.5 w-3.5 rounded-b-sm bg-white" />
          </div>

          {/* Timeline Hover Timestamp & Line */}
          {timelineHover && (
            <>
              <div
                style={{ left: `${timelineHover.pct}%` }}
                className="pointer-events-none absolute top-1 z-30 -translate-x-1/2"
              >
                <span className="rounded-md border border-cyan-400/50 bg-[#090A0F]/95 px-2 py-0.5 font-mono text-[10px] font-semibold text-cyan-300 shadow-lg backdrop-blur-md whitespace-nowrap">
                  {formatTimecode(timelineHover.time)}
                </span>
              </div>
              <div
                style={{ left: `${timelineHover.pct}%` }}
                className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-cyan-400/60 shadow-[0_0_4px_rgba(34,211,238,0.6)]"
              />
            </>
          )}
        </div>
      </div>

      {/* Dedicated Start & End Adjustment Cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rangeCards.map((card) => (
          <div
            key={card.key}
            className={`rounded-xl border ${card.accentBorder} bg-[#090A0F]/80 p-3 space-y-2.5`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`text-xs font-semibold ${card.accentText}`}>
                {card.title}
              </span>
              <button
                type="button"
                onClick={() => seekTo(card.value)}
                className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/[0.1]"
              >
                Saltar aquí
              </button>
            </div>

            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={card.value}
              onChange={(e) => card.onSlider(Number.parseFloat(e.target.value))}
              className={`h-1.5 w-full cursor-pointer ${card.accentSlider}`}
            />

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={card.text}
                onChange={(e) => card.setText(e.target.value)}
                onBlur={card.commit}
                onKeyDown={(e) => e.key === "Enter" && card.commit()}
                className="w-32 rounded-lg border border-white/10 bg-[#11131C] px-2.5 py-1.5 font-mono text-xs text-white outline-none focus:border-violet-500"
              />
              <div className="flex flex-1 flex-wrap justify-end gap-1">
                {[-1, -0.1, 0.1, 1].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    onClick={() => adjustBound(card.key, delta)}
                    className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-mono text-slate-300 hover:bg-white/[0.1]"
                  >
                    {delta > 0 ? `+${delta}s` : `${delta}s`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add to Multi-Clip List or Download Selection Immediately */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-white/10 bg-[#090A0F]/80 p-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={clipName}
          onChange={(e) => setClipName(e.target.value)}
          placeholder={`Nombre del clip (ej. Clip ${clips.length + 1})`}
          className="flex-1 rounded-lg border border-white/10 bg-[#11131C] px-3 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-violet-500"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleAdd}
            className="studio-gradient-btn flex items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold text-white"
          >
            <Plus className="h-4 w-4" />
            <span>Añadir a Lista de Clips</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadSelection}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-cyan-500/45 bg-cyan-500/15 px-4 py-2.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/25"
          >
            <Download className="h-4 w-4" />
            <span>Descargar Parte Seleccionada</span>
          </button>
        </div>
      </div>

      {streamError && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>
              Error cargando stream directo. Reintenta o vuelve a analizar el enlace para refrescar los tokens.
            </span>
          </div>
          <a
            href={metadata.webpage_url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-amber-300 underline shrink-0"
          >
            <span>Abrir en navegador</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
};
