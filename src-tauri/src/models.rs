use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryStatus {
    pub ytdlp_installed: bool,
    pub ytdlp_version: Option<String>,
    pub ytdlp_latest: Option<String>,
    pub ytdlp_update_available: bool,
    pub ytdlp_path: String,
    pub ffmpeg_installed: bool,
    pub ffmpeg_version: Option<String>,
    pub ffmpeg_latest: Option<String>,
    pub ffmpeg_update_available: bool,
    pub ffmpeg_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryUpdateProgress {
    pub binary: String,  // "yt-dlp" | "ffmpeg"
    pub stage: String,   // "checking" | "downloading" | "extracting" | "ready" | "error"
    pub percent: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoFormatOption {
    pub format_id: String,
    pub ext: String,
    pub resolution: String,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: String,
    pub acodec: String,
    pub filesize: Option<u64>,
    pub tbr: Option<f64>,
    pub format_note: String,
    pub language: Option<String>,
    pub has_video: bool,
    pub has_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTrackOption {
    pub track_id: String,
    pub language: Option<String>,
    pub label: String,
    pub is_original: bool,
    pub format_id: String,
    pub ext: String,
    pub acodec: String,
    pub tbr: Option<f64>,
    pub preview_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoChapter {
    pub title: String,
    pub start_time: f64,
    pub end_time: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResolutionEntry {
    pub label: String,
    pub height: u32,
    pub mp4_url: Option<String>,
    pub webm_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub id: String,
    pub title: String,
    pub uploader: String,
    pub duration: f64,
    pub thumbnail: String,
    pub view_count: Option<u64>,
    pub upload_date: Option<String>,
    pub webpage_url: String,
    pub preview_stream_url: Option<String>,
    pub preview_combined_url: Option<String>,
    pub preview_webm_url: Option<String>,
    pub preview_audio_url: Option<String>,
    #[serde(default)]
    pub preview_resolutions: Vec<PreviewResolutionEntry>,
    pub embed_url: String,
    pub audio_tracks: Vec<AudioTrackOption>,
    pub formats: Vec<VideoFormatOption>,
    pub chapters: Vec<VideoChapter>,
    pub subtitles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipSegment {
    pub id: String,
    pub name: String,
    pub start_time: f64,
    pub end_time: f64,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedClipEntry {
    pub id: String,
    pub name: String,
    pub start_time: f64,
    pub end_time: f64,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub notes: Option<String>,
    pub video_url: String,
    pub video_id: String,
    pub video_title: String,
    #[serde(default)]
    pub video_thumbnail: String,
    #[serde(default)]
    pub video_duration: f64,
    pub precise_cut: bool,
    pub merge_clips: bool,
    pub options: ManualDownloadOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualDownloadOptions {
    pub mode: String, // "video_audio" | "audio_only" | "video_only"
    pub quality_preset: String, // "best" | "2160" | "1440" | "1080" | "720" | "480" | "360" | "custom"
    pub custom_video_format_id: Option<String>,
    pub custom_audio_format_id: Option<String>,
    #[serde(default)]
    pub audio_track_id: Option<String>,
    #[serde(default)]
    pub audio_format_id: Option<String>,
    pub container: String,     // "mp4" | "mkv" | "webm" | "mov"
    pub audio_format: String,  // "mp3" | "m4a" | "wav" | "flac" | "opus"
    pub audio_bitrate: String, // "320K" | "192K" | "128K"
    pub embed_subtitles: bool,
    pub subtitle_lang: String,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub rate_limit: Option<String>,
    pub custom_args: Option<String>,
    #[serde(default)]
    pub target_fps: Option<u32>,
    pub output_dir: String,
    #[serde(default)]
    pub filename_format: Option<String>, // "clean" | "full"
    #[serde(default)]
    pub clip_start_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionSegment {
    pub start: i64,
    pub end: i64,
    pub is_peak: bool,
    #[serde(default)]
    pub emotion: Option<String>,
    #[serde(default)]
    pub events: Vec<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    pub url: String,
    #[serde(default)]
    pub video_title: Option<String>,
    pub duration: f64,
    pub device: String,
    pub segments: Vec<TranscriptionSegment>,
    pub formatted_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionProgressEvent {
    pub stage: String,
    pub percent: f64,
    pub message: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub log_line: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipExportRequest {
    pub url: String,
    pub video_title: String,
    pub clips: Vec<ClipSegment>,
    pub merge_clips: bool,
    pub precise_cut: bool,
    pub options: ManualDownloadOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobProgressEvent {
    pub job_id: String,
    pub title: String,
    pub status: String, // "queued" | "downloading" | "cutting" | "merging" | "completed" | "error" | "cancelled"
    pub percent: f64,
    #[serde(default)]
    pub clip_percent: Option<f64>,
    #[serde(default)]
    pub clip_index: Option<usize>,
    #[serde(default)]
    pub clip_total: Option<usize>,
    #[serde(default)]
    pub clip_name: Option<String>,
    pub speed: String,
    pub eta: String,
    pub current_step: String,
    pub output_files: Vec<String>,
    pub log_line: Option<String>,
}

/// Formats seconds into `HH:MM:SS.mmm` for yt-dlp `--download-sections` and FFmpeg.
pub fn format_timestamp(seconds: f64) -> String {
    let clamped = if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    };
    let total_ms = (clamped * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_secs = total_ms / 1000;
    let secs = total_secs % 60;
    let mins = (total_secs / 60) % 60;
    let hrs = total_secs / 3600;
    format!("{:02}:{:02}:{:02}.{:03}", hrs, mins, secs, ms)
}

/// Replaces characters not allowed in Windows/Unix filenames.
pub fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "clipgen_output".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

/// Splits a shell-like argument string respecting single and double quotes.
pub fn split_shell_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
            }
            '"' if !in_single => {
                in_double = !in_double;
            }
            '\\' if in_double => {
                if let Some(&next) = chars.peek() {
                    if next == '"' || next == '\\' {
                        current.push(chars.next().unwrap());
                    } else {
                        current.push(ch);
                    }
                } else {
                    current.push(ch);
                }
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }

    if !current.is_empty() {
        args.push(current);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_timestamp() {
        assert_eq!(format_timestamp(0.0), "00:00:00.000");
        assert_eq!(format_timestamp(65.5), "00:01:05.500");
        assert_eq!(format_timestamp(3661.123), "01:01:01.123");
        assert_eq!(format_timestamp(-5.0), "00:00:00.000");
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("My: Cool / Video?"), "My_ Cool _ Video_");
        assert_eq!(sanitize_filename("   ...  "), "clipgen_output");
    }

    #[test]
    fn test_split_shell_args() {
        assert_eq!(
            split_shell_args("--cookies-from-browser chrome --user-agent \"Mozilla 5.0\" -N 4"),
            vec![
                "--cookies-from-browser",
                "chrome",
                "--user-agent",
                "Mozilla 5.0",
                "-N",
                "4"
            ]
        );
    }
}
