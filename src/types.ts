export interface BinaryStatus {
  ytdlp_installed: boolean;
  ytdlp_version: string | null;
  ytdlp_latest: string | null;
  ytdlp_update_available: boolean;
  ytdlp_path: string;
  ffmpeg_installed: boolean;
  ffmpeg_version: string | null;
  ffmpeg_latest: string | null;
  ffmpeg_update_available: boolean;
  ffmpeg_path: string;
}

export interface BinaryUpdateProgress {
  binary: "yt-dlp" | "ffmpeg" | string;
  stage: "checking" | "downloading" | "extracting" | "ready" | "error" | string;
  percent: number;
  message: string;
}

export interface VideoFormatOption {
  format_id: string;
  ext: string;
  resolution: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  vcodec: string;
  acodec: string;
  filesize: number | null;
  tbr: number | null;
  format_note: string;
  language: string | null;
  has_video: boolean;
  has_audio: boolean;
}

export interface AudioTrackOption {
  track_id: string;
  language: string | null;
  label: string;
  is_original: boolean;
  format_id: string;
  ext: string;
  acodec: string;
  tbr: number | null;
  preview_url: string;
}

export interface VideoChapter {
  title: string;
  start_time: number;
  end_time: number;
}

export interface PreviewResolutionOption {
  label: string;
  height: number;
  mp4_url?: string | null;
  webm_url?: string | null;
}

export interface VideoMetadata {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  view_count: number | null;
  upload_date: string | null;
  webpage_url: string;
  preview_stream_url: string | null;
  preview_combined_url: string | null;
  preview_webm_url: string | null;
  preview_audio_url: string | null;
  preview_resolutions?: PreviewResolutionOption[];
  embed_url: string;
  audio_tracks: AudioTrackOption[];
  formats: VideoFormatOption[];
  chapters: VideoChapter[];
  subtitles: string[];
}

export interface ClipSegment {
  id: string;
  name: string;
  start_time: number;
  end_time: number;
  selected?: boolean;
  notes?: string;
}

export interface SavedClipEntry {
  id: string;
  name: string;
  start_time: number;
  end_time: number;
  selected?: boolean;
  notes?: string;
  video_url: string;
  video_id: string;
  video_title: string;
  video_thumbnail: string;
  video_duration: number;
  precise_cut: boolean;
  merge_clips: boolean;
  options: ManualDownloadOptions;
}

export interface ManualDownloadOptions {
  mode: "video_audio" | "audio_only" | "video_only";
  quality_preset: "best" | "2160" | "1440" | "1080" | "720" | "480" | "360" | "custom";
  custom_video_format_id: string | null;
  custom_audio_format_id: string | null;
  audio_track_id: string | null;
  audio_format_id: string | null;
  container: "mp4" | "mkv" | "webm" | "mov";
  audio_format: "mp3" | "m4a" | "wav" | "flac" | "opus";
  audio_bitrate: "320K" | "192K" | "128K";
  embed_subtitles: boolean;
  subtitle_lang: string;
  embed_thumbnail: boolean;
  embed_metadata: boolean;
  rate_limit: string | null;
  custom_args: string | null;
  target_fps: number | null;
  output_dir: string;
  filename_format?: "clean" | "full";
  clip_start_index?: number;
}

export interface ClipExportRequest {
  url: string;
  video_title: string;
  clips: ClipSegment[];
  merge_clips: boolean;
  precise_cut: boolean;
  options: ManualDownloadOptions;
}

export interface JobProgressEvent {
  job_id: string;
  title: string;
  status:
    | "queued"
    | "downloading"
    | "cutting"
    | "merging"
    | "completed"
    | "error"
    | "cancelled"
    | string;
  percent: number;
  clip_percent?: number | null;
  clip_index?: number | null;
  clip_total?: number | null;
  clip_name?: string | null;
  speed: string;
  eta: string;
  current_step: string;
  output_files: string[];
  log_line: string | null;
}

export interface JobState extends JobProgressEvent {
  logs: string[];
  createdAt: number;
}
