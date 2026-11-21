use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::AppHandle;
use tokio::io::BufReader;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::binary_manager::{
    ffmpeg_binary_path, ffprobe_binary_path, get_binaries_dir, hidden_std_command,
    hidden_tokio_command, ytdlp_binary_path,
};
use crate::models::{
    format_timestamp, sanitize_filename, ClipExportRequest, ClipSegment, JobProgressEvent,
    ManualDownloadOptions, SavedClipEntry,
};
use crate::ytdlp::{
    append_format_and_option_args_ext, append_h264_encoder_args, cache_raw_video_json,
    classify_audio_track, detect_hw_video_encoder, emit_job_event, ensure_file_target_fps,
    ensure_ytdlp_ready, extract_format_fragment_urls, extract_mp4_init_segment,
    extract_mp4_media_segment, get_cached_raw_video_json, hw_encoder_display_name,
    invalidate_cached_raw_video_json, is_job_cancelled, kill_process_tree, parse_ffmpeg_speed,
    parse_ffmpeg_time_secs, parse_mp4_init_and_sidx, read_next_progress_line, register_job,
    run_ytdlp_with_progress, set_job_pid, subscribe_job_cancel, unregister_job, wait_for_cancel,
    HwVideoEncoder, SidxSegment, YtdlpRunConfig,
};

const DASH_CONCURRENCY: usize = 8;
const SIDX_RANGE_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const DASH_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

static DASH_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DASH_EPOCH: OnceLock<Instant> = OnceLock::new();
static DASH_COOLDOWN_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static SIDX_CACHE: OnceLock<Mutex<HashMap<String, (Vec<u8>, Vec<SidxSegment>)>>> = OnceLock::new();

fn sidx_cache() -> &'static Mutex<HashMap<String, (Vec<u8>, Vec<SidxSegment>)>> {
    SIDX_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dash_now_ms() -> u64 {
    DASH_EPOCH
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis() as u64
}

fn extend_dash_cooldown(backoff_ms: u64) {
    let target = dash_now_ms().saturating_add(backoff_ms);
    DASH_COOLDOWN_UNTIL_MS.fetch_max(target, Ordering::SeqCst);
}

fn remaining_dash_cooldown() -> Option<Duration> {
    let now = dash_now_ms();
    let until = DASH_COOLDOWN_UNTIL_MS.load(Ordering::SeqCst);
    if until > now {
        Some(Duration::from_millis(until - now))
    } else {
        None
    }
}

fn dash_http_client() -> &'static reqwest::Client {
    DASH_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(DASH_USER_AGENT)
            .tcp_nodelay(true)
            .pool_max_idle_per_host(32)
            .timeout(Duration::from_secs(60))
            .build()
            .expect("Failed to build DASH download reqwest client")
    })
}

fn format_concat_entry(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
    format!("file '{normalized}'")
}

fn next_unique_path(base_dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let candidate = base_dir.join(format!("{stem}.{ext}"));
    if !candidate.exists() {
        return candidate;
    }
    for i in 1..1000 {
        let alt = base_dir.join(format!("{stem} ({i}).{ext}"));
        if !alt.exists() {
            return alt;
        }
    }
    base_dir.join(format!("{stem}_{}.{}", Uuid::new_v4(), ext))
}

fn push_merge_codec_args(
    args: &mut Vec<String>,
    mode: &str,
    is_webm: bool,
    include_audio_map: bool,
    hw_enc: HwVideoEncoder,
) {
    match mode {
        "audio_only" => {
            if !include_audio_map {
                args.push("-vn".to_string());
            }
        }
        "video_only" => {
            if !include_audio_map {
                args.push("-an".to_string());
            }
            if is_webm {
                args.extend([
                    "-c:v".to_string(),
                    "libvpx-vp9".to_string(),
                    "-crf".to_string(),
                    "28".to_string(),
                    "-b:v".to_string(),
                    "0".to_string(),
                    "-deadline".to_string(),
                    "good".to_string(),
                    "-cpu-used".to_string(),
                    "4".to_string(),
                    "-row-mt".to_string(),
                    "1".to_string(),
                ]);
            } else {
                append_h264_encoder_args(args, hw_enc);
            }
        }
        _ => {
            if is_webm {
                args.extend([
                    "-c:v".to_string(),
                    "libvpx-vp9".to_string(),
                    "-crf".to_string(),
                    "28".to_string(),
                    "-b:v".to_string(),
                    "0".to_string(),
                    "-deadline".to_string(),
                    "good".to_string(),
                    "-cpu-used".to_string(),
                    "4".to_string(),
                    "-row-mt".to_string(),
                    "1".to_string(),
                    "-c:a".to_string(),
                    "libopus".to_string(),
                    "-b:a".to_string(),
                    "192k".to_string(),
                ]);
            } else {
                append_h264_encoder_args(args, hw_enc);
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "192k".to_string(),
                ]);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum ProgressSink<'a> {
    App(&'a AppHandle),
    #[cfg(test)]
    Buffer(&'a std::sync::Mutex<Vec<JobProgressEvent>>),
}

impl<'a> ProgressSink<'a> {
    fn emit(&self, event: JobProgressEvent) {
        match self {
            ProgressSink::App(app) => emit_job_event(app, event),
            #[cfg(test)]
            ProgressSink::Buffer(buf) => {
                if let Ok(mut guard) = buf.lock() {
                    guard.push(event);
                }
            }
        }
    }
}

struct FfmpegProgressScope<'a> {
    status: &'a str,
    overall_base: f64,
    overall_span: f64,
    clip_base: f64,
    clip_span: f64,
    clip_index: Option<usize>,
    clip_total: Option<usize>,
    clip_name: Option<&'a str>,
    total_duration_secs: f64,
    step_prefix: &'a str,
}

async fn run_ffmpeg_child_monitored(
    sink: ProgressSink<'_>,
    job_id: &str,
    title: &str,
    ffmpeg: &Path,
    args: &[String],
    output_file: &Path,
    scope: &FfmpegProgressScope<'_>,
) -> Result<(), (bool, String)> {
    let mut cmd_args = vec![
        "-stats".to_string(),
        "-stats_period".to_string(),
        "0.25".to_string(),
    ];
    cmd_args.extend_from_slice(args);

    let mut cmd = hidden_tokio_command(ffmpeg);
    cmd.args(&cmd_args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| (false, format!("Error lanzando FFmpeg: {e}")))?;
    set_job_pid(job_id, child.id());

    let stderr = child.stderr.take();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(128);
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut reader = BufReader::new(err);
            let mut buf = Vec::new();
            while let Ok(Some(line)) = read_next_progress_line(&mut reader, &mut buf).await {
                if tx.send(line).await.is_err() {
                    break;
                }
            }
        });
    }

    let mut cancel_rx = subscribe_job_cancel(job_id);
    let started_at = Instant::now();
    let mut err_lines: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_rx) => {
                if let Some(pid) = child.id() {
                    kill_process_tree(pid);
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                set_job_pid(job_id, None);
                tokio::time::sleep(Duration::from_millis(120)).await;
                let _ = fs::remove_file(output_file);
                return Err((true, "__CANCELLED__".to_string()));
            }
            maybe_line = rx.recv() => {
                let Some(line) = maybe_line else {
                    break;
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.contains("Error")
                    || trimmed.contains("Invalid")
                    || trimmed.contains("No such")
                    || trimmed.contains("Conversion failed")
                {
                    err_lines.push(trimmed.to_string());
                }
                if let Some(secs) = parse_ffmpeg_time_secs(trimmed) {
                    let frac = if scope.total_duration_secs > 0.0 {
                        (secs / scope.total_duration_secs).clamp(0.0, 0.99)
                    } else {
                        0.5
                    };
                    let clip_pct = (scope.clip_base + frac * scope.clip_span).clamp(0.0, 100.0);
                    let total_pct = (scope.overall_base + frac * scope.overall_span).clamp(0.0, 100.0);
                    let speed = parse_ffmpeg_speed(trimmed).unwrap_or_else(|| "--".to_string());
                    let eta_str = if scope.total_duration_secs > 0.0 && frac > 0.03 {
                        let wall = started_at.elapsed().as_secs_f64();
                        let rem = ((wall / frac) - wall).max(0.0).round() as u64;
                        format!("{:02}:{:02}", rem / 60, rem % 60)
                    } else {
                        "--".to_string()
                    };
                    let step = format!(
                        "{} ({secs:.1}s / {:.1}s)...",
                        scope.step_prefix,
                        scope.total_duration_secs
                    );
                    sink.emit(
                        JobProgressEvent {
                            job_id: job_id.to_string(),
                            title: title.to_string(),
                            status: scope.status.to_string(),
                            percent: total_pct,
                            clip_percent: Some(clip_pct),
                            clip_index: scope.clip_index,
                            clip_total: scope.clip_total,
                            clip_name: scope.clip_name.map(|s| s.to_string()),
                            speed,
                            eta: eta_str,
                            current_step: step,
                            output_files: vec![],
                            log_line: None,
                        },
                    );
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| (false, format!("Error esperando FFmpeg: {e}")))?;
    set_job_pid(job_id, None);

    if is_job_cancelled(job_id) {
        let _ = fs::remove_file(output_file);
        return Err((true, "__CANCELLED__".to_string()));
    }

    if status.success() && output_file.exists() {
        Ok(())
    } else {
        let msg = if err_lines.is_empty() {
            format!("FFmpeg terminó con código {:?}", status.code())
        } else {
            err_lines.join(" | ")
        };
        Err((false, msg))
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_ffmpeg_with_hw_fallback<F>(
    sink: ProgressSink<'_>,
    job_id: &str,
    title: &str,
    ffmpeg: &Path,
    output_file: &Path,
    scope: &FfmpegProgressScope<'_>,
    allow_hw: bool,
    build_args: F,
) -> Result<(), (bool, String)>
where
    F: Fn(HwVideoEncoder) -> Vec<String>,
{
    let initial = if allow_hw {
        detect_hw_video_encoder()
    } else {
        HwVideoEncoder::CpuSoftware
    };
    let attempts = if initial != HwVideoEncoder::CpuSoftware {
        vec![initial, HwVideoEncoder::CpuSoftware]
    } else {
        vec![HwVideoEncoder::CpuSoftware]
    };

    let mut last_err: (bool, String) = (false, "Error desconocido de FFmpeg".to_string());
    for (attempt_idx, enc) in attempts.into_iter().enumerate() {
        if attempt_idx > 0 {
            let _ = fs::remove_file(output_file);
            sink.emit(JobProgressEvent {
                job_id: job_id.to_string(),
                title: title.to_string(),
                status: scope.status.to_string(),
                percent: scope.overall_base,
                clip_percent: Some(scope.clip_base),
                clip_index: scope.clip_index,
                clip_total: scope.clip_total,
                clip_name: scope.clip_name.map(str::to_string),
                speed: "--".to_string(),
                eta: "--".to_string(),
                current_step: format!("{} (respaldo CPU libx264)...", scope.step_prefix),
                output_files: vec![],
                log_line: Some(
                    "⚠ Aceleración GPU no disponible para este paso; cambiando a CPU (libx264)..."
                        .to_string(),
                ),
            });
        }
        let args = build_args(enc);
        match run_ffmpeg_child_monitored(sink, job_id, title, ffmpeg, &args, output_file, scope)
            .await
        {
            Ok(()) => return Ok(()),
            Err((true, msg)) => return Err((true, msg)),
            Err((false, msg)) => {
                last_err = (false, msg);
            }
        }
    }

    Err(last_err)
}

#[allow(clippy::too_many_arguments)]
async fn run_ffmpeg_merge(
    app: &AppHandle,
    job_id: &str,
    title: &str,
    clip_files: &[String],
    output_file: &Path,
    mode: &str,
    precise_cut: bool,
    target_fps: Option<u32>,
    total_duration_secs: f64,
    overall_base: f64,
    overall_span: f64,
    global_clip_total: usize,
) -> Result<PathBuf, String> {
    if is_job_cancelled(job_id) {
        return Err("__CANCELLED__".to_string());
    }

    let ffmpeg = ffmpeg_binary_path();
    let total_clips = clip_files.len();
    let active_fps = if mode != "audio_only" {
        target_fps.filter(|&f| f > 0)
    } else {
        None
    };
    let is_webm = output_file
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("webm"))
        .unwrap_or(false);
    let needs_video_reencode = mode != "audio_only" && (precise_cut || active_fps.is_some());
    let allow_hw = needs_video_reencode && !is_webm;
    let accel_tag = if allow_hw {
        hw_encoder_display_name(detect_hw_video_encoder())
    } else if is_webm && needs_video_reencode {
        "VP9"
    } else {
        "Copy"
    };
    let merge_label = if let Some(fps) = active_fps {
        format!("Uniendo {total_clips} clips ({fps} FPS · {accel_tag})")
    } else {
        format!("Uniendo {total_clips} clips ({accel_tag})")
    };
    let step_prefix = format!("Uniendo {total_clips} clips ({accel_tag})");

    emit_job_event(
        app,
        JobProgressEvent {
            job_id: job_id.to_string(),
            title: title.to_string(),
            status: "merging".to_string(),
            percent: overall_base,
            clip_percent: Some(0.0),
            clip_index: None,
            clip_total: Some(global_clip_total),
            clip_name: Some(merge_label.clone()),
            speed: "--".to_string(),
            eta: "--".to_string(),
            current_step: format!("Uniendo {total_clips} clips con FFmpeg ({accel_tag})..."),
            output_files: vec![],
            log_line: Some(format!(
                "Iniciando unión de {total_clips} clips ({accel_tag})..."
            )),
        },
    );

    let list_path = output_file.with_extension("concat.txt");
    let list_content: String = clip_files
        .iter()
        .map(|f| format_concat_entry(Path::new(f)))
        .collect::<Vec<_>>()
        .join("\n");

    fs::write(&list_path, &list_content)
        .map_err(|e| format!("Error creando lista concat de FFmpeg: {e}"))?;

    let merge_scope = FfmpegProgressScope {
        status: "merging",
        overall_base,
        overall_span,
        clip_base: 0.0,
        clip_span: 100.0,
        clip_index: None,
        clip_total: Some(global_clip_total),
        clip_name: Some(&merge_label),
        total_duration_secs,
        step_prefix: &step_prefix,
    };

    let list_path_str = list_path.to_string_lossy().to_string();
    let out_path_str = output_file.to_string_lossy().to_string();
    let fast_res = run_ffmpeg_with_hw_fallback(
        ProgressSink::App(app),
        job_id,
        title,
        &ffmpeg,
        output_file,
        &merge_scope,
        allow_hw,
        |hw_enc| {
            let mut fast_args = vec!["-y".to_string()];
            if needs_video_reencode && !is_webm && hw_enc != HwVideoEncoder::CpuSoftware {
                fast_args.extend(["-hwaccel".to_string(), "auto".to_string()]);
            }
            fast_args.extend([
                "-f".to_string(),
                "concat".to_string(),
                "-safe".to_string(),
                "0".to_string(),
                "-i".to_string(),
                list_path_str.clone(),
            ]);
            if precise_cut || active_fps.is_some() {
                if let Some(fps) = active_fps {
                    fast_args.extend(["-vf".to_string(), format!("fps={fps}")]);
                }
                push_merge_codec_args(&mut fast_args, mode, is_webm, false, hw_enc);
            } else {
                fast_args.extend(["-c".to_string(), "copy".to_string()]);
            }
            fast_args.push(out_path_str.clone());
            fast_args
        },
    )
    .await;

    let _ = fs::remove_file(&list_path);

    match fast_res {
        Ok(()) => return Ok(output_file.to_path_buf()),
        Err((true, msg)) => return Err(msg),
        Err((false, _)) => {
            let _ = fs::remove_file(output_file);
        }
    }

    if is_job_cancelled(job_id) {
        return Err("__CANCELLED__".to_string());
    }

    // Fallback: filter_complex concat for clips with differing stream parameters
    let filter_inputs: String = match mode {
        "audio_only" => (0..total_clips).map(|i| format!("[{i}:a]")).collect(),
        "video_only" => (0..total_clips).map(|i| format!("[{i}:v]")).collect(),
        _ => (0..total_clips)
            .map(|i| format!("[{i}:v][{i}:a]"))
            .collect(),
    };

    let allow_fallback_hw = mode != "audio_only" && !is_webm;
    match run_ffmpeg_with_hw_fallback(
        ProgressSink::App(app),
        job_id,
        title,
        &ffmpeg,
        output_file,
        &merge_scope,
        allow_fallback_hw,
        |hw_enc| {
            let mut fallback_args = vec!["-y".to_string()];
            for file in clip_files {
                fallback_args.push("-i".to_string());
                fallback_args.push(file.clone());
            }

            let mut map_args: Vec<String> = Vec::new();
            let filter_str = match mode {
                "audio_only" => {
                    map_args.extend(["-map".to_string(), "[outa]".to_string()]);
                    format!("{filter_inputs}concat=n={total_clips}:v=0:a=1[outa]")
                }
                "video_only" => {
                    map_args.extend(["-map".to_string(), "[outv]".to_string()]);
                    push_merge_codec_args(&mut map_args, mode, is_webm, true, hw_enc);
                    if let Some(fps) = active_fps {
                        format!("{filter_inputs}concat=n={total_clips}:v=1:a=0[vcat];[vcat]fps={fps}[outv]")
                    } else {
                        format!("{filter_inputs}concat=n={total_clips}:v=1:a=0[outv]")
                    }
                }
                _ => {
                    map_args.extend([
                        "-map".to_string(),
                        "[outv]".to_string(),
                        "-map".to_string(),
                        "[outa]".to_string(),
                    ]);
                    push_merge_codec_args(&mut map_args, mode, is_webm, true, hw_enc);
                    if let Some(fps) = active_fps {
                        format!("{filter_inputs}concat=n={total_clips}:v=1:a=1[vcat][outa];[vcat]fps={fps}[outv]")
                    } else {
                        format!("{filter_inputs}concat=n={total_clips}:v=1:a=1[outv][outa]")
                    }
                }
            };

            fallback_args.push("-filter_complex".to_string());
            fallback_args.push(filter_str);
            fallback_args.extend(map_args);
            fallback_args.push(out_path_str.clone());
            fallback_args
        },
    )
    .await
    {
        Ok(()) => Ok(output_file.to_path_buf()),
        Err((_, msg)) => Err(msg),
    }
}

#[derive(Debug, Clone)]
struct DashStreamInfo {
    frag_urls: Vec<String>,
    direct_url: Option<String>,
    ext: String,
    codec: String,
    frag_durations: Vec<Option<f64>>,
    user_agent: String,
    fps: Option<f64>,
}

#[derive(Debug, Clone)]
enum DashSelection {
    VideoAudio {
        video: DashStreamInfo,
        audio: DashStreamInfo,
        total_duration: f64,
    },
    VideoOnly {
        video: DashStreamInfo,
        total_duration: f64,
    },
    AudioOnly {
        audio: DashStreamInfo,
        total_duration: f64,
    },
}

pub(crate) fn compute_end_pts(start_time: f64, reported_duration: f64) -> f64 {
    if start_time > 0.5 && reported_duration >= start_time {
        reported_duration
    } else {
        start_time + reported_duration.max(0.0)
    }
}

fn is_dash_format(f: &Value) -> bool {
    let proto = f["protocol"].as_str().unwrap_or("");
    if proto == "http_dash_segments" && !extract_format_fragment_urls(f).is_empty() {
        return true;
    }
    if matches!(proto, "https" | "http") {
        let ext = f["ext"].as_str().unwrap_or("");
        let is_isobmff = ext.eq_ignore_ascii_case("mp4") || ext.eq_ignore_ascii_case("m4a");
        let vcodec = f["vcodec"].as_str().unwrap_or("none");
        let acodec = f["acodec"].as_str().unwrap_or("none");
        let is_adaptive =
            (vcodec != "none" && acodec == "none") || (acodec != "none" && vcodec == "none");
        let has_url = f["url"].as_str().map(|s| !s.is_empty()).unwrap_or(false);
        return is_isobmff && is_adaptive && has_url;
    }
    false
}

pub(crate) fn select_dash_video_format<'a>(
    formats: &'a [Value],
    options: &ManualDownloadOptions,
) -> Option<&'a Value> {
    let candidates: Vec<&Value> = formats
        .iter()
        .filter(|f| {
            let vcodec = f["vcodec"].as_str().unwrap_or("");
            !vcodec.is_empty() && vcodec != "none" && is_dash_format(f)
        })
        .collect();

    if candidates.is_empty() {
        return None;
    }

    if options.quality_preset == "custom" {
        if let Some(custom_id) = options
            .custom_video_format_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Some(found) = candidates
                .iter()
                .find(|f| f["format_id"].as_str() == Some(custom_id))
            {
                return Some(*found);
            }
        }
    }

    let max_height: Option<f64> = match options.quality_preset.as_str() {
        "best" | "custom" | "" => None,
        other => other.parse::<f64>().ok(),
    };

    let filtered: Vec<&Value> = if let Some(max_h) = max_height {
        let within: Vec<&Value> = candidates
            .iter()
            .copied()
            .filter(|f| f["height"].as_f64().unwrap_or(0.0) <= max_h + 0.1)
            .collect();
        if within.is_empty() {
            candidates
        } else {
            within
        }
    } else {
        candidates
    };

    filtered
        .into_iter()
        .max_by_key(|f| {
            let ext = f["ext"].as_str().unwrap_or("");
            let vcodec = f["vcodec"].as_str().unwrap_or("");
            let is_isobmff = u8::from(ext.eq_ignore_ascii_case("mp4"));
            let is_h264 = u8::from(vcodec.contains("avc") || vcodec.contains("h264"));
            let is_video_only = u8::from(f["acodec"].as_str().unwrap_or("none") == "none");
            let height = f["height"].as_f64().unwrap_or(0.0).round() as u64;
            let fps = f["fps"].as_f64().unwrap_or(0.0).round() as u64;
            let tbr = f["tbr"]
                .as_f64()
                .or_else(|| f["vbr"].as_f64())
                .unwrap_or(0.0)
                .round() as u64;
            (is_isobmff, height, is_video_only, is_h264, fps, tbr)
        })
}

pub(crate) fn select_dash_audio_format<'a>(
    formats: &'a [Value],
    options: &ManualDownloadOptions,
) -> Option<&'a Value> {
    let audio_only: Vec<&Value> = formats
        .iter()
        .filter(|f| {
            let acodec = f["acodec"].as_str().unwrap_or("");
            let vcodec = f["vcodec"].as_str().unwrap_or("none");
            !acodec.is_empty() && acodec != "none" && vcodec == "none" && is_dash_format(f)
        })
        .collect();

    let candidates: Vec<&Value> = if audio_only.is_empty() {
        formats
            .iter()
            .filter(|f| {
                let acodec = f["acodec"].as_str().unwrap_or("");
                !acodec.is_empty() && acodec != "none" && is_dash_format(f)
            })
            .collect()
    } else {
        audio_only
    };

    if candidates.is_empty() {
        return None;
    }

    if let Some(aid) = options
        .audio_format_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(found) = candidates
            .iter()
            .find(|f| f["format_id"].as_str() == Some(aid))
        {
            return Some(*found);
        }
    }

    if options.quality_preset == "custom" {
        if let Some(aid) = options
            .custom_audio_format_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Some(found) = candidates
                .iter()
                .find(|f| f["format_id"].as_str() == Some(aid))
            {
                return Some(*found);
            }
        }
    }

    let meta_for = |f: &&Value| {
        let fmt_id = f["format_id"].as_str().unwrap_or("");
        let fmt_note = f["format_note"].as_str().unwrap_or("");
        let language = f["language"].as_str();
        let lang_pref = f["language_preference"].as_i64().unwrap_or(-1);
        classify_audio_track(fmt_id, fmt_note, language, lang_pref)
    };

    let selected_track = options
        .audio_track_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "default");

    let track_filtered: Vec<&Value> = if let Some(track) = selected_track {
        let matched: Vec<&Value> = candidates
            .iter()
            .copied()
            .filter(|f| meta_for(f).0 == track)
            .collect();
        if matched.is_empty() {
            candidates
        } else {
            matched
        }
    } else {
        let originals: Vec<&Value> = candidates
            .iter()
            .copied()
            .filter(|f| meta_for(f).2)
            .collect();
        if originals.is_empty() {
            candidates
        } else {
            originals
        }
    };

    track_filtered.into_iter().max_by_key(|f| {
        let (_, _, _, is_drc) = meta_for(f);
        let ext = f["ext"].as_str().unwrap_or("");
        let acodec = f["acodec"].as_str().unwrap_or("");
        let is_isobmff = u8::from(
            ext.eq_ignore_ascii_case("m4a")
                || ext.eq_ignore_ascii_case("mp4")
                || acodec.contains("mp4a"),
        );
        let abr = f["abr"]
            .as_f64()
            .or_else(|| f["tbr"].as_f64())
            .unwrap_or(0.0)
            .round() as u64;
        (is_isobmff, u8::from(!is_drc), abr)
    })
}

fn to_dash_stream_info(f: &Value) -> DashStreamInfo {
    let frag_urls = extract_format_fragment_urls(f);
    let direct_url = f["url"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let frag_durations = f["fragments"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|frag| frag["duration"].as_f64().filter(|&d| d > 0.0))
                .collect()
        })
        .unwrap_or_default();
    let ext = f["ext"].as_str().unwrap_or("mp4").to_string();
    let codec = f["vcodec"]
        .as_str()
        .filter(|s| *s != "none" && !s.is_empty())
        .or_else(|| f["acodec"].as_str())
        .unwrap_or("")
        .to_string();
    let user_agent = f["http_headers"]["User-Agent"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DASH_USER_AGENT)
        .to_string();
    let fps = f["fps"].as_f64();
    DashStreamInfo {
        frag_urls,
        direct_url,
        ext,
        codec,
        frag_durations,
        user_agent,
        fps,
    }
}

fn resolve_dash_selection(
    raw_json: &Value,
    options: &ManualDownloadOptions,
) -> Option<DashSelection> {
    let formats = raw_json["formats"].as_array()?;
    let total_duration = raw_json["duration"].as_f64().unwrap_or(0.0);

    match options.mode.as_str() {
        "audio_only" => {
            let a = select_dash_audio_format(formats, options)?;
            Some(DashSelection::AudioOnly {
                audio: to_dash_stream_info(a),
                total_duration,
            })
        }
        "video_only" => {
            let v = select_dash_video_format(formats, options)?;
            Some(DashSelection::VideoOnly {
                video: to_dash_stream_info(v),
                total_duration,
            })
        }
        _ => {
            let v = select_dash_video_format(formats, options)?;
            let a = select_dash_audio_format(formats, options)?;
            Some(DashSelection::VideoAudio {
                video: to_dash_stream_info(v),
                audio: to_dash_stream_info(a),
                total_duration,
            })
        }
    }
}

async fn fetch_raw_video_json(job_id: &str, url: &str) -> Result<Value, (bool, String)> {
    if is_job_cancelled(job_id) {
        return Err((true, "__CANCELLED__".to_string()));
    }

    if let Some(cached) = get_cached_raw_video_json(url) {
        return Ok(cached);
    }

    let ytdlp = ytdlp_binary_path();
    let mut cmd = hidden_tokio_command(&ytdlp);
    cmd.args(["--no-playlist", "--no-warnings", "-J", url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| (false, format!("Error iniciando análisis de streams: {e}")))?;
    let pid = child.id();
    set_job_pid(job_id, pid);

    let mut cancel_rx = subscribe_job_cancel(job_id);
    let output_res = tokio::select! {
        biased;
        _ = wait_for_cancel(&mut cancel_rx) => {
            if let Some(p) = pid {
                kill_process_tree(p);
            }
            set_job_pid(job_id, None);
            return Err((true, "__CANCELLED__".to_string()));
        }
        res = child.wait_with_output() => res,
    };

    set_job_pid(job_id, None);

    if is_job_cancelled(job_id) {
        return Err((true, "__CANCELLED__".to_string()));
    }

    let output = output_res
        .map_err(|e| (false, format!("Error obteniendo metadata de video: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((false, format!("yt-dlp -J falló: {}", stderr.trim())));
    }

    let json = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|e| (false, format!("Error parseando JSON de streams: {e}")))?;
    let webp = json["webpage_url"].as_str().unwrap_or_default().to_string();
    let vid = json["id"].as_str().unwrap_or_default().to_string();
    cache_raw_video_json(&[url.to_string(), webp, vid], json.clone());
    Ok(json)
}

async fn sleep_cancellable(job_id: &str, dur: Duration) -> Result<(), (bool, String)> {
    if is_job_cancelled(job_id) {
        return Err((true, "__CANCELLED__".to_string()));
    }
    let mut cancel_rx = subscribe_job_cancel(job_id);
    tokio::select! {
        biased;
        _ = wait_for_cancel(&mut cancel_rx) => Err((true, "__CANCELLED__".to_string())),
        _ = tokio::time::sleep(dur) => Ok(()),
    }
}

async fn fetch_fragment_bytes(
    job_id: &str,
    url: &str,
    user_agent: &str,
) -> Result<Vec<u8>, (bool, String)> {
    let client = dash_http_client();
    let mut last_err = String::new();

    for attempt in 0..8usize {
        if is_job_cancelled(job_id) {
            return Err((true, "__CANCELLED__".to_string()));
        }

        if let Some(wait_dur) = remaining_dash_cooldown() {
            sleep_cancellable(job_id, wait_dur).await?;
        }

        let mut cancel_rx = subscribe_job_cancel(job_id);
        let resp_res = tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_rx) => {
                return Err((true, "__CANCELLED__".to_string()));
            }
            res = client.get(url).header("User-Agent", user_agent).send() => res,
        };

        let mut backoff_sleep: Option<Duration> = None;

        match resp_res {
            Ok(resp) if resp.status().is_success() => {
                let mut cancel_rx_body = subscribe_job_cancel(job_id);
                let body_res = tokio::select! {
                    biased;
                    _ = wait_for_cancel(&mut cancel_rx_body) => {
                        return Err((true, "__CANCELLED__".to_string()));
                    }
                    res = resp.bytes() => res,
                };
                match body_res {
                    Ok(bytes) if !bytes.is_empty() => return Ok(bytes.to_vec()),
                    Ok(_) => {
                        last_err = "Fragmento HTTP vacío".to_string();
                        if attempt < 7 {
                            backoff_sleep = Some(Duration::from_millis(500 * (attempt as u64 + 1)));
                        }
                    }
                    Err(e) => {
                        last_err = format!("Error leyendo cuerpo HTTP: {e}");
                        if attempt < 7 {
                            backoff_sleep = Some(Duration::from_millis(500 * (attempt as u64 + 1)));
                        }
                    }
                }
            }
            Ok(resp) => {
                let status = resp.status();
                let code = status.as_u16();
                last_err = format!("HTTP {status} descargando fragmento DASH");
                if matches!(code, 401 | 403 | 429 | 500 | 502 | 503 | 504) {
                    if attempt < 7 {
                        extend_dash_cooldown(1500 * (attempt as u64 + 1));
                        backoff_sleep = Some(Duration::from_millis(200 * (attempt as u64 + 1)));
                    }
                } else if attempt < 7 {
                    backoff_sleep = Some(Duration::from_millis(400 * (attempt as u64 + 1)));
                }
            }
            Err(e) => {
                last_err = format!("Error de red descargando fragmento DASH: {e}");
                if attempt < 7 {
                    backoff_sleep = Some(Duration::from_millis(500 * (attempt as u64 + 1)));
                }
            }
        }

        if let Some(dur) = backoff_sleep {
            sleep_cancellable(job_id, dur).await?;
        }
    }

    Err((false, last_err))
}

async fn fetch_range_bytes(
    job_id: &str,
    url: &str,
    user_agent: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, (bool, String)> {
    let client = dash_http_client();
    let range_hdr = format!("bytes={start}-{end}");
    let mut last_err = String::new();

    for attempt in 0..8usize {
        if is_job_cancelled(job_id) {
            return Err((true, "__CANCELLED__".to_string()));
        }

        if let Some(wait_dur) = remaining_dash_cooldown() {
            sleep_cancellable(job_id, wait_dur).await?;
        }

        let mut cancel_rx = subscribe_job_cancel(job_id);
        let resp_res = tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_rx) => {
                return Err((true, "__CANCELLED__".to_string()));
            }
            res = client
                .get(url)
                .header("User-Agent", user_agent)
                .header("Range", &range_hdr)
                .send() => res,
        };

        let mut backoff_sleep: Option<Duration> = None;

        match resp_res {
            Ok(resp) if resp.status().is_success() => {
                let mut cancel_rx_body = subscribe_job_cancel(job_id);
                let body_res = tokio::select! {
                    biased;
                    _ = wait_for_cancel(&mut cancel_rx_body) => {
                        return Err((true, "__CANCELLED__".to_string()));
                    }
                    res = resp.bytes() => res,
                };
                match body_res {
                    Ok(bytes) if !bytes.is_empty() => return Ok(bytes.to_vec()),
                    Ok(_) => {
                        last_err = "Rango HTTP vacío".to_string();
                        if attempt < 7 {
                            backoff_sleep = Some(Duration::from_millis(500 * (attempt as u64 + 1)));
                        }
                    }
                    Err(e) => {
                        last_err = format!("Error leyendo rango HTTP: {e}");
                        if attempt < 7 {
                            backoff_sleep = Some(Duration::from_millis(500 * (attempt as u64 + 1)));
                        }
                    }
                }
            }
            Ok(resp) => {
                let status = resp.status();
                let code = status.as_u16();
                last_err = format!("HTTP {status} descargando rango DASH");
                if matches!(code, 401 | 403 | 429 | 500 | 502 | 503 | 504) {
                    if attempt < 7 {
                        extend_dash_cooldown(1500 * (attempt as u64 + 1));
                        backoff_sleep = Some(Duration::from_millis(200 * (attempt as u64 + 1)));
                    }
                } else if attempt < 7 {
                    backoff_sleep = Some(Duration::from_millis(400 * (attempt as u64 + 1)));
                }
            }
            Err(e) => {
                last_err = format!("Error de red descargando rango DASH: {e}");
                if attempt < 7 {
                    backoff_sleep = Some(Duration::from_millis(500 * (attempt as u64 + 1)));
                }
            }
        }

        if let Some(dur) = backoff_sleep {
            sleep_cancellable(job_id, dur).await?;
        }
    }

    Err((false, last_err))
}

async fn fetch_or_cache_sidx(
    job_id: &str,
    url: &str,
    user_agent: &str,
) -> Result<(Vec<u8>, Vec<SidxSegment>), (bool, String)> {
    if let Ok(map) = sidx_cache().lock() {
        if let Some(entry) = map.get(url) {
            return Ok(entry.clone());
        }
    }

    let head = fetch_range_bytes(job_id, url, user_agent, 0, 131_071).await?;
    let parsed = match parse_mp4_init_and_sidx(&head) {
        Some((init, segs, None)) => (init, segs),
        Some((_, _, Some(needed))) if needed <= 4 * 1024 * 1024 => {
            let full_head =
                fetch_range_bytes(job_id, url, user_agent, 0, (needed as u64).saturating_sub(1))
                    .await?;
            match parse_mp4_init_and_sidx(&full_head) {
                Some((init, segs, None)) => (init, segs),
                _ => return Err((false, "Stream MP4 sin índice sidx completo.".to_string())),
            }
        }
        _ => return Err((false, "Stream MP4 no contiene índice sidx.".to_string())),
    };

    if let Ok(mut map) = sidx_cache().lock() {
        if map.len() >= 32 {
            map.clear();
        }
        map.insert(url.to_string(), parsed.clone());
    }

    Ok(parsed)
}

async fn download_sidx_stream_for_clip(
    ctx: &DashDownloadContext<'_>,
    url: &str,
    user_agent: &str,
    clip_start: f64,
    clip_end: f64,
    out_path: &Path,
) -> Result<f64, (bool, String)> {
    let (init_bytes, segs) = fetch_or_cache_sidx(ctx.job_id, url, user_agent).await?;
    let s_idx = segs
        .iter()
        .rposition(|s| s.start_time <= clip_start)
        .unwrap_or(0);
    let e_idx = segs
        .iter()
        .position(|s| s.start_time + s.duration >= clip_end + 0.25)
        .unwrap_or(segs.len().saturating_sub(1))
        .max(s_idx);

    let byte_start = segs[s_idx].byte_offset;
    let byte_end = segs[e_idx]
        .byte_offset
        .saturating_add(segs[e_idx].byte_size.saturating_sub(1));
    if byte_end < byte_start {
        return Err((false, "Rango de bytes sidx inválido.".to_string()));
    }

    let mut ranges: Vec<(u64, u64)> = Vec::new();
    let mut cur = byte_start;
    while cur <= byte_end {
        let end = cur
            .saturating_add(SIDX_RANGE_CHUNK_BYTES - 1)
            .min(byte_end);
        ranges.push((cur, end));
        cur = end + 1;
    }
    let chunk_count = ranges.len().max(1);

    let mut out_file = std::io::BufWriter::new(
        fs::File::create(out_path)
            .map_err(|e| (false, format!("Error creando temporal sidx DASH: {e}")))?,
    );
    out_file
        .write_all(&init_bytes)
        .map_err(|e| (false, format!("Error escribiendo cabecera MP4 sidx: {e}")))?;

    let dl_started = Instant::now();
    let mut bytes_total: u64 = 0;
    let mut completed_count: usize = 0;
    let mut next_write_pos: usize = 0;
    let mut ready_chunks: Vec<Option<Vec<u8>>> = vec![None; chunk_count];

    let sem = Arc::new(Semaphore::new(DASH_CONCURRENCY));
    let mut join_set: JoinSet<Result<(usize, Vec<u8>), (bool, String)>> = JoinSet::new();

    for (pos, (r_start, r_end)) in ranges.into_iter().enumerate() {
        let sem_clone = Arc::clone(&sem);
        let url_clone = url.to_string();
        let ua_clone = user_agent.to_string();
        let jid = ctx.job_id.to_string();
        join_set.spawn(async move {
            let _permit = sem_clone
                .acquire_owned()
                .await
                .map_err(|_| (false, "Semaphore cerrado".to_string()))?;
            let bytes = fetch_range_bytes(&jid, &url_clone, &ua_clone, r_start, r_end).await?;
            Ok((pos, bytes))
        });
    }

    let mut cancel_rx = subscribe_job_cancel(ctx.job_id);
    loop {
        while next_write_pos < chunk_count {
            if let Some(chunk) = ready_chunks[next_write_pos].take() {
                out_file
                    .write_all(&chunk)
                    .map_err(|e| (false, format!("Error escribiendo bloque sidx DASH: {e}")))?;
                next_write_pos += 1;
            } else {
                break;
            }
        }

        if next_write_pos >= chunk_count {
            break;
        }

        tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_rx) => {
                join_set.abort_all();
                drop(out_file);
                let _ = fs::remove_file(out_path);
                return Err((true, "__CANCELLED__".to_string()));
            }
            joined = join_set.join_next() => {
                match joined {
                    Some(Ok(Ok((pos, chunk)))) => {
                        bytes_total += chunk.len() as u64;
                        completed_count += 1;
                        ready_chunks[pos] = Some(chunk);

                        let frac = (completed_count as f64 / chunk_count as f64).clamp(0.0, 1.0);
                        let clip_pct = ctx.clip_base + frac * ctx.clip_span;
                        let total_pct = ctx.overall_base + frac * ctx.overall_span;
                        let wall = dl_started.elapsed().as_secs_f64();
                        let eta_str = if frac > 0.05 && frac < 1.0 {
                            let rem = ((wall / frac) - wall).max(0.0).round() as u64;
                            format!("{:02}:{:02}", rem / 60, rem % 60)
                        } else if frac >= 1.0 {
                            "00:00".to_string()
                        } else {
                            "--".to_string()
                        };

                        ctx.sink.emit(JobProgressEvent {
                            job_id: ctx.job_id.to_string(),
                            title: ctx.job_title.to_string(),
                            status: "downloading".to_string(),
                            percent: total_pct,
                            clip_percent: Some(clip_pct),
                            clip_index: Some(ctx.clip_index),
                            clip_total: Some(ctx.clip_total),
                            clip_name: Some(ctx.clip_name.to_string()),
                            speed: format_dl_speed(bytes_total, wall),
                            eta: eta_str,
                            current_step: format!(
                                "Descargando {} ({}/{}) para \"{}\"...",
                                ctx.stream_label, completed_count, chunk_count, ctx.clip_name
                            ),
                            output_files: vec![],
                            log_line: None,
                        });
                    }
                    Some(Ok(Err((cancelled, err)))) => {
                        join_set.abort_all();
                        drop(out_file);
                        let _ = fs::remove_file(out_path);
                        return Err((cancelled, err));
                    }
                    Some(Err(join_err)) => {
                        join_set.abort_all();
                        drop(out_file);
                        let _ = fs::remove_file(out_path);
                        return Err((false, format!("Error en tarea paralela sidx DASH: {join_err}")));
                    }
                    None => break,
                }
            }
        }
    }

    out_file
        .flush()
        .map_err(|e| (false, format!("Error cerrando buffer sidx DASH: {e}")))?;
    drop(out_file);

    Ok(segs[s_idx].start_time)
}

async fn probe_media_bounds(file: &Path) -> Option<(f64, f64)> {
    let ffprobe = ffprobe_binary_path();
    if !ffprobe.exists() {
        return None;
    }

    let output = hidden_tokio_command(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=start_time,duration:stream=start_time,duration",
            "-of",
            "json",
        ])
        .arg(file)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json: Value = serde_json::from_slice(&output.stdout).ok()?;
    let parse_f64 = |val: &Value| -> Option<f64> {
        val.as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| val.as_f64())
            .filter(|v| v.is_finite())
    };

    let start = parse_f64(&json["format"]["start_time"])
        .or_else(|| {
            json["streams"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|s| parse_f64(&s["start_time"]))
        })
        .unwrap_or(0.0);

    let duration = parse_f64(&json["format"]["duration"])
        .or_else(|| {
            json["streams"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|s| parse_f64(&s["duration"]))
        })
        .unwrap_or(0.0);

    Some((start, compute_end_pts(start, duration)))
}

async fn probe_single_frag_start(
    init_bytes: &[u8],
    frag_bytes: &[u8],
    probe_path: &Path,
) -> Option<f64> {
    let media = extract_mp4_media_segment(frag_bytes);
    {
        let mut f = fs::File::create(probe_path).ok()?;
        if init_bytes.windows(4).any(|w| w == b"moov") {
            f.write_all(init_bytes).ok()?;
            f.write_all(&media).ok()?;
        } else {
            f.write_all(frag_bytes).ok()?;
        }
    }
    let bounds = probe_media_bounds(probe_path).await;
    let _ = fs::remove_file(probe_path);
    bounds.map(|(start, _)| start)
}

fn estimate_frag_range(
    frag_durations: &[Option<f64>],
    frag_count: usize,
    total_duration: f64,
    start_time: f64,
    end_time: f64,
) -> (usize, usize, f64) {
    if frag_count == 0 {
        return (0, 0, 2.0);
    }

    let known: Vec<f64> = frag_durations.iter().filter_map(|&d| d).collect();
    if known.len() * 2 >= frag_count && known.len() > 1 {
        let mut cum = 0.0;
        let mut s_idx = 0usize;
        let mut found_start = false;
        let mut e_idx = frag_count.saturating_sub(1);
        for (i, d_opt) in frag_durations.iter().enumerate() {
            let d = d_opt.unwrap_or(0.0);
            if !found_start && cum + d > start_time {
                s_idx = i.saturating_sub(1);
                found_start = true;
            }
            cum += d;
            if cum >= end_time {
                e_idx = (i + 1).min(frag_count.saturating_sub(1));
                break;
            }
        }
        let avg = (cum / known.len() as f64).max(0.5);
        return (s_idx.min(e_idx), e_idx.max(s_idx), avg);
    }

    let avg_dur = if total_duration > 0.0 {
        (total_duration / frag_count as f64).max(0.5)
    } else {
        2.0
    };
    let s_est = (start_time / avg_dur).min(start_time / 2.0);
    let e_est = (end_time / avg_dur).max(end_time / 2.0);
    let s_idx = (s_est.floor() as isize - 2).clamp(0, frag_count as isize - 1) as usize;
    let e_idx = (e_est.ceil() as isize + 2).clamp(s_idx as isize, frag_count as isize - 1) as usize;
    (s_idx, e_idx, avg_dur)
}

struct DashDownloadContext<'a> {
    sink: ProgressSink<'a>,
    job_id: &'a str,
    job_title: &'a str,
    clip_index: usize,
    clip_total: usize,
    clip_name: &'a str,
    overall_base: f64,
    overall_span: f64,
    clip_base: f64,
    clip_span: f64,
    stream_label: &'a str,
}

fn format_dl_speed(bytes: u64, elapsed_secs: f64) -> String {
    if elapsed_secs <= 0.05 || bytes == 0 {
        return "--".to_string();
    }
    let bps = bytes as f64 / elapsed_secs;
    if bps >= 1_048_576.0 {
        format!("{:.2}MiB/s", bps / 1_048_576.0)
    } else {
        format!("{:.1}KiB/s", bps / 1024.0)
    }
}

async fn download_dash_stream_for_clip(
    ctx: &DashDownloadContext<'_>,
    stream: &DashStreamInfo,
    total_duration: f64,
    clip_start: f64,
    clip_end: f64,
    out_path: &Path,
    probe_dir: &Path,
) -> Result<f64, (bool, String)> {
    if is_job_cancelled(ctx.job_id) {
        return Err((true, "__CANCELLED__".to_string()));
    }
    if stream.frag_urls.is_empty() {
        if let Some(ref direct_url) = stream.direct_url {
            return download_sidx_stream_for_clip(
                ctx,
                direct_url,
                &stream.user_agent,
                clip_start,
                clip_end,
                out_path,
            )
            .await;
        }
        return Err((false, "Stream DASH sin URLs de fragmentos.".to_string()));
    }

    let (mut start_idx, end_idx, avg_dur) = estimate_frag_range(
        &stream.frag_durations,
        stream.frag_urls.len(),
        total_duration,
        clip_start,
        clip_end,
    );

    let ua = stream.user_agent.as_str();
    let mut prefetched: HashMap<usize, Vec<u8>> = HashMap::new();
    let initial_raw = fetch_fragment_bytes(ctx.job_id, &stream.frag_urls[start_idx], ua).await?;
    prefetched.insert(start_idx, initial_raw.clone());

    let (init_bytes, separate_init) = if initial_raw.windows(4).any(|w| w == b"moov") {
        (extract_mp4_init_segment(&initial_raw), false)
    } else {
        let frag0 = if start_idx == 0 {
            initial_raw.clone()
        } else {
            fetch_fragment_bytes(ctx.job_id, &stream.frag_urls[0], ua).await?
        };
        let init = extract_mp4_init_segment(&frag0);
        let sep = !frag0.windows(4).any(|w| w == b"moof");
        if sep && start_idx == 0 && stream.frag_urls.len() > 1 {
            start_idx = 1;
            let raw1 = fetch_fragment_bytes(ctx.job_id, &stream.frag_urls[1], ua).await?;
            prefetched.insert(1, raw1);
        }
        (init, sep)
    };

    let has_isobmff_init = init_bytes.windows(4).any(|w| w == b"moov");
    let probe_path = probe_dir.join(format!("probe_{}.mp4", ctx.stream_label));
    let mut stream_start_pts: Option<f64> = None;

    if has_isobmff_init {
        let min_idx = usize::from(separate_init);
        for _ in 0..6 {
            let raw = match prefetched.get(&start_idx) {
                Some(b) => b.clone(),
                None => {
                    let b = fetch_fragment_bytes(ctx.job_id, &stream.frag_urls[start_idx], ua).await?;
                    prefetched.insert(start_idx, b.clone());
                    b
                }
            };
            let Some(frag_start) = probe_single_frag_start(&init_bytes, &raw, &probe_path).await
            else {
                break;
            };
            stream_start_pts = Some(frag_start);
            if frag_start > clip_start + 0.05 && start_idx > min_idx {
                let back = (((frag_start - clip_start) / avg_dur).ceil() as usize + 1).max(1);
                let next_start = start_idx.saturating_sub(back).max(min_idx);
                if next_start == start_idx {
                    break;
                }
                start_idx = next_start;
            } else {
                break;
            }
        }
    }

    let mut cur_end = if let Some(start_pts) = stream_start_pts {
        let span_est = ((clip_end - start_pts).max(1.0) / avg_dur).ceil() as usize + 2;
        end_idx
            .max(start_idx + span_est)
            .min(stream.frag_urls.len() - 1)
    } else {
        end_idx.max(start_idx).min(stream.frag_urls.len() - 1)
    };
    let initial_count = (cur_end - start_idx + 1).max(1);

    let mut out_file = std::io::BufWriter::new(
        fs::File::create(out_path)
            .map_err(|e| (false, format!("Error creando temporal DASH: {e}")))?,
    );
    if has_isobmff_init {
        out_file
            .write_all(&init_bytes)
            .map_err(|e| (false, format!("Error escribiendo cabecera MP4 DASH: {e}")))?;
    }

    let dl_started = Instant::now();
    let mut bytes_total: u64 = 0;
    let mut completed_count: usize = 0;
    let mut next_write_pos: usize = 0;
    let mut last_raw: Vec<u8> = Vec::new();
    let mut ready_raw: Vec<Option<Vec<u8>>> = vec![None; initial_count];

    let sem = Arc::new(Semaphore::new(DASH_CONCURRENCY));
    let mut join_set: JoinSet<Result<(usize, Vec<u8>), (bool, String)>> = JoinSet::new();

    for (pos, idx) in (start_idx..=cur_end).enumerate() {
        if let Some(cached) = prefetched.remove(&idx) {
            bytes_total += cached.len() as u64;
            completed_count += 1;
            ready_raw[pos] = Some(cached);
        } else {
            let sem_clone = Arc::clone(&sem);
            let url = stream.frag_urls[idx].clone();
            let ua_clone = stream.user_agent.clone();
            let jid = ctx.job_id.to_string();
            join_set.spawn(async move {
                let _permit = sem_clone
                    .acquire_owned()
                    .await
                    .map_err(|_| (false, "Semaphore cerrado".to_string()))?;
                let bytes = fetch_fragment_bytes(&jid, &url, &ua_clone).await?;
                Ok((pos, bytes))
            });
        }
    }

    if join_set.is_empty() && completed_count > 0 {
        let wall = dl_started.elapsed().as_secs_f64();
        ctx.sink.emit(JobProgressEvent {
            job_id: ctx.job_id.to_string(),
            title: ctx.job_title.to_string(),
            status: "downloading".to_string(),
            percent: ctx.overall_base + ctx.overall_span,
            clip_percent: Some(ctx.clip_base + ctx.clip_span),
            clip_index: Some(ctx.clip_index),
            clip_total: Some(ctx.clip_total),
            clip_name: Some(ctx.clip_name.to_string()),
            speed: format_dl_speed(bytes_total, wall),
            eta: "00:00".to_string(),
            current_step: format!(
                "Descargando {} ({}/{}) para \"{}\"...",
                ctx.stream_label, completed_count, initial_count, ctx.clip_name
            ),
            output_files: vec![],
            log_line: None,
        });
    }

    let mut cancel_rx = subscribe_job_cancel(ctx.job_id);
    loop {
        while next_write_pos < initial_count {
            if let Some(raw) = ready_raw[next_write_pos].take() {
                let payload = if has_isobmff_init {
                    extract_mp4_media_segment(&raw)
                } else {
                    raw.clone()
                };
                out_file
                    .write_all(&payload)
                    .map_err(|e| (false, format!("Error escribiendo fragmento DASH: {e}")))?;
                last_raw = raw;
                next_write_pos += 1;
            } else {
                break;
            }
        }

        if next_write_pos >= initial_count {
            break;
        }

        tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_rx) => {
                join_set.abort_all();
                drop(out_file);
                let _ = fs::remove_file(out_path);
                return Err((true, "__CANCELLED__".to_string()));
            }
            joined = join_set.join_next() => {
                match joined {
                    Some(Ok(Ok((pos, raw)))) => {
                        bytes_total += raw.len() as u64;
                        completed_count += 1;
                        ready_raw[pos] = Some(raw);

                        let frac = (completed_count as f64 / initial_count as f64).clamp(0.0, 1.0);
                        let clip_pct = ctx.clip_base + frac * ctx.clip_span;
                        let total_pct = ctx.overall_base + frac * ctx.overall_span;
                        let wall = dl_started.elapsed().as_secs_f64();
                        let eta_str = if frac > 0.05 && frac < 1.0 {
                            let rem = ((wall / frac) - wall).max(0.0).round() as u64;
                            format!("{:02}:{:02}", rem / 60, rem % 60)
                        } else if frac >= 1.0 {
                            "00:00".to_string()
                        } else {
                            "--".to_string()
                        };

                        ctx.sink.emit(
                            JobProgressEvent {
                                job_id: ctx.job_id.to_string(),
                                title: ctx.job_title.to_string(),
                                status: "downloading".to_string(),
                                percent: total_pct,
                                clip_percent: Some(clip_pct),
                                clip_index: Some(ctx.clip_index),
                                clip_total: Some(ctx.clip_total),
                                clip_name: Some(ctx.clip_name.to_string()),
                                speed: format_dl_speed(bytes_total, wall),
                                eta: eta_str,
                                current_step: format!(
                                    "Descargando {} ({}/{}) para \"{}\"...",
                                    ctx.stream_label,
                                    completed_count,
                                    initial_count,
                                    ctx.clip_name
                                ),
                                output_files: vec![],
                                log_line: None,
                            },
                        );
                    }
                    Some(Ok(Err((cancelled, err)))) => {
                        join_set.abort_all();
                        drop(out_file);
                        let _ = fs::remove_file(out_path);
                        return Err((cancelled, err));
                    }
                    Some(Err(join_err)) => {
                        join_set.abort_all();
                        drop(out_file);
                        let _ = fs::remove_file(out_path);
                        return Err((false, format!("Error en tarea paralela DASH: {join_err}")));
                    }
                    None => break,
                }
            }
        }
    }

    // Extend tail if last downloaded fragment still starts before clip_end + safety margin
    if has_isobmff_init && !last_raw.is_empty() {
        let mut last_start = probe_single_frag_start(&init_bytes, &last_raw, &probe_path).await;
        let mut ext_steps = 0usize;
        while cur_end + 1 < stream.frag_urls.len()
            && ext_steps < 40
            && last_start.map(|t| t < clip_end + 0.15).unwrap_or(false)
        {
            cur_end += 1;
            ext_steps += 1;
            let raw = fetch_fragment_bytes(ctx.job_id, &stream.frag_urls[cur_end], ua).await?;
            let payload = extract_mp4_media_segment(&raw);
            out_file
                .write_all(&payload)
                .map_err(|e| (false, format!("Error extendiendo fragmento DASH: {e}")))?;
            last_start = probe_single_frag_start(&init_bytes, &raw, &probe_path).await;
        }
    }

    out_file
        .flush()
        .map_err(|e| (false, format!("Error cerrando buffer DASH: {e}")))?;
    drop(out_file);

    let probed_start = probe_media_bounds(out_path).await.map(|(s, _)| s);
    Ok(probed_start
        .or(stream_start_pts)
        .unwrap_or_else(|| start_idx as f64 * avg_dur))
}

fn push_audio_codec_args(args: &mut Vec<String>, format: &str, bitrate: &str) {
    let br = bitrate.trim().to_lowercase();
    let br_arg = if br.is_empty() {
        "192k".to_string()
    } else {
        br
    };
    match format {
        "mp3" => args.extend(["-c:a".into(), "libmp3lame".into(), "-b:a".into(), br_arg]),
        "m4a" => args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), br_arg]),
        "opus" => args.extend(["-c:a".into(), "libopus".into(), "-b:a".into(), br_arg]),
        "flac" => args.extend(["-c:a".into(), "flac".into()]),
        "wav" => args.extend(["-c:a".into(), "pcm_s16le".into()]),
        _ => args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), br_arg]),
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_and_cut_dash_clip(
    sink: ProgressSink<'_>,
    job_id: &str,
    job_title: &str,
    dash: &DashSelection,
    clip: &ClipSegment,
    request: &ClipExportRequest,
    file_stem: &str,
    dest_dir: &Path,
    tmp_dir: &Path,
    active_fps: Option<u32>,
    global_clip_idx: usize,
    grand_total_clips: usize,
    clip_overall_base: f64,
    clip_overall_span: f64,
    display_clip_name: &str,
) -> Result<Vec<String>, (bool, String)> {
    let clip_tmp = tmp_dir.join(format!("c_{global_clip_idx}"));
    fs::create_dir_all(&clip_tmp)
        .map_err(|e| (false, format!("Error creando carpeta temporal del clip: {e}")))?;

    let ffmpeg = ffmpeg_binary_path();
    let clip_dur = (clip.end_time - clip.start_time).max(0.1);
    let out_ext = if request.options.mode == "audio_only" {
        request.options.audio_format.as_str()
    } else {
        request.options.container.as_str()
    };
    let out_path = next_unique_path(dest_dir, file_stem, out_ext);

    let res: Result<(), (bool, String)> = async {
        match dash {
            DashSelection::AudioOnly {
                audio,
                total_duration,
            } => {
                let a_raw = clip_tmp.join(format!("a.{}", audio.ext));
                let ctx = DashDownloadContext {
                    sink,
                    job_id,
                    job_title,
                    clip_index: global_clip_idx,
                    clip_total: grand_total_clips,
                    clip_name: display_clip_name,
                    overall_base: clip_overall_base,
                    overall_span: clip_overall_span * 0.65,
                    clip_base: 0.0,
                    clip_span: 65.0,
                    stream_label: "audio",
                };
                let a_start = download_dash_stream_for_clip(
                    &ctx,
                    audio,
                    *total_duration,
                    clip.start_time,
                    clip.end_time,
                    &a_raw,
                    &clip_tmp,
                )
                .await?;

                let rel_ss = (clip.start_time - a_start).max(0.0);
                let mut ff_args = vec![
                    "-y".to_string(),
                    "-ss".to_string(),
                    format!("{rel_ss:.3}"),
                    "-i".to_string(),
                    a_raw.to_string_lossy().to_string(),
                    "-vn".to_string(),
                    "-t".to_string(),
                    format!("{clip_dur:.3}"),
                ];
                let can_copy = !request.precise_cut
                    && request.options.audio_format.eq_ignore_ascii_case("m4a")
                    && audio.ext.eq_ignore_ascii_case("m4a");
                if can_copy {
                    ff_args.extend([
                        "-c:a".to_string(),
                        "copy".to_string(),
                        "-avoid_negative_ts".to_string(),
                        "make_zero".to_string(),
                    ]);
                } else {
                    push_audio_codec_args(
                        &mut ff_args,
                        &request.options.audio_format,
                        &request.options.audio_bitrate,
                    );
                }
                if request.options.embed_metadata {
                    ff_args.extend(["-metadata".to_string(), format!("title={}", clip.name)]);
                }
                ff_args.push(out_path.to_string_lossy().to_string());

                let scope = FfmpegProgressScope {
                    status: "cutting",
                    overall_base: clip_overall_base + clip_overall_span * 0.65,
                    overall_span: clip_overall_span * 0.35,
                    clip_base: 65.0,
                    clip_span: 35.0,
                    clip_index: Some(global_clip_idx),
                    clip_total: Some(grand_total_clips),
                    clip_name: Some(display_clip_name),
                    total_duration_secs: clip_dur,
                    step_prefix: "Cortando audio",
                };
                run_ffmpeg_child_monitored(
                    sink,
                    job_id,
                    job_title,
                    &ffmpeg,
                    &ff_args,
                    &out_path,
                    &scope,
                )
                .await?;
            }
            DashSelection::VideoOnly {
                video,
                total_duration,
            } => {
                let v_raw = clip_tmp.join(format!("v.{}", video.ext));
                let ctx = DashDownloadContext {
                    sink,
                    job_id,
                    job_title,
                    clip_index: global_clip_idx,
                    clip_total: grand_total_clips,
                    clip_name: display_clip_name,
                    overall_base: clip_overall_base,
                    overall_span: clip_overall_span * 0.65,
                    clip_base: 0.0,
                    clip_span: 65.0,
                    stream_label: "video",
                };
                let v_start = download_dash_stream_for_clip(
                    &ctx,
                    video,
                    *total_duration,
                    clip.start_time,
                    clip.end_time,
                    &v_raw,
                    &clip_tmp,
                )
                .await?;

                let rel_ss = (clip.start_time - v_start).max(0.0);
                let stream_fps = video.fps;
                let needs_fps_conversion = active_fps.map_or(false, |req_fps| {
                    stream_fps.map_or(true, |nfps| (nfps - req_fps as f64).abs() > 0.6)
                });
                let is_webm = out_ext.eq_ignore_ascii_case("webm");
                let can_copy = !request.precise_cut
                    && !needs_fps_conversion
                    && !is_webm
                    && (!out_ext.eq_ignore_ascii_case("mov")
                        || video.codec.contains("avc")
                        || video.codec.contains("h264"));
                let allow_hw = !can_copy && !is_webm;
                let step_prefix = if can_copy {
                    "Remuxando video".to_string()
                } else if is_webm {
                    "Procesando video (VP9)".to_string()
                } else {
                    format!(
                        "Procesando video ({})",
                        hw_encoder_display_name(detect_hw_video_encoder())
                    )
                };

                let scope = FfmpegProgressScope {
                    status: "cutting",
                    overall_base: clip_overall_base + clip_overall_span * 0.65,
                    overall_span: clip_overall_span * 0.35,
                    clip_base: 65.0,
                    clip_span: 35.0,
                    clip_index: Some(global_clip_idx),
                    clip_total: Some(grand_total_clips),
                    clip_name: Some(display_clip_name),
                    total_duration_secs: clip_dur,
                    step_prefix: &step_prefix,
                };
                let v_raw_str = v_raw.to_string_lossy().to_string();
                let out_path_str = out_path.to_string_lossy().to_string();
                run_ffmpeg_with_hw_fallback(
                    sink,
                    job_id,
                    job_title,
                    &ffmpeg,
                    &out_path,
                    &scope,
                    allow_hw,
                    |hw_enc| {
                        let mut ff_args = vec![
                            "-y".to_string(),
                            "-ss".to_string(),
                            format!("{rel_ss:.3}"),
                        ];
                        if !can_copy && !is_webm && hw_enc != HwVideoEncoder::CpuSoftware {
                            ff_args.extend(["-hwaccel".to_string(), "auto".to_string()]);
                        }
                        ff_args.extend([
                            "-i".to_string(),
                            v_raw_str.clone(),
                            "-an".to_string(),
                            "-t".to_string(),
                            format!("{clip_dur:.3}"),
                        ]);
                        if can_copy {
                            ff_args.extend([
                                "-c:v".to_string(),
                                "copy".to_string(),
                                "-avoid_negative_ts".to_string(),
                                "make_zero".to_string(),
                            ]);
                        } else {
                            if needs_fps_conversion {
                                if let Some(fps) = active_fps {
                                    ff_args.extend(["-vf".to_string(), format!("fps={fps}")]);
                                }
                            }
                            push_merge_codec_args(&mut ff_args, "video_only", is_webm, true, hw_enc);
                        }
                        if !is_webm
                            && matches!(out_ext.to_ascii_lowercase().as_str(), "mp4" | "mov")
                        {
                            ff_args.extend(["-movflags".to_string(), "+faststart".to_string()]);
                        }
                        if request.options.embed_metadata {
                            ff_args.extend([
                                "-metadata".to_string(),
                                format!("title={}", clip.name),
                            ]);
                        }
                        ff_args.push(out_path_str.clone());
                        ff_args
                    },
                )
                .await?;
            }
            DashSelection::VideoAudio {
                video,
                audio,
                total_duration,
            } => {
                let v_raw = clip_tmp.join(format!("v.{}", video.ext));
                let a_raw = clip_tmp.join(format!("a.{}", audio.ext));

                let v_ctx = DashDownloadContext {
                    sink,
                    job_id,
                    job_title,
                    clip_index: global_clip_idx,
                    clip_total: grand_total_clips,
                    clip_name: display_clip_name,
                    overall_base: clip_overall_base,
                    overall_span: clip_overall_span * 0.45,
                    clip_base: 0.0,
                    clip_span: 45.0,
                    stream_label: "video",
                };
                let v_start = download_dash_stream_for_clip(
                    &v_ctx,
                    video,
                    *total_duration,
                    clip.start_time,
                    clip.end_time,
                    &v_raw,
                    &clip_tmp,
                )
                .await?;

                let a_ctx = DashDownloadContext {
                    sink,
                    job_id,
                    job_title,
                    clip_index: global_clip_idx,
                    clip_total: grand_total_clips,
                    clip_name: display_clip_name,
                    overall_base: clip_overall_base + clip_overall_span * 0.45,
                    overall_span: clip_overall_span * 0.20,
                    clip_base: 45.0,
                    clip_span: 20.0,
                    stream_label: "audio",
                };
                let a_start = download_dash_stream_for_clip(
                    &a_ctx,
                    audio,
                    *total_duration,
                    clip.start_time,
                    clip.end_time,
                    &a_raw,
                    &clip_tmp,
                )
                .await?;

                let rel_v_ss = (clip.start_time - v_start).max(0.0);
                let rel_a_ss = (clip.start_time - a_start).max(0.0);
                let stream_fps = video.fps;
                let needs_fps_conversion = active_fps.map_or(false, |req_fps| {
                    stream_fps.map_or(true, |nfps| (nfps - req_fps as f64).abs() > 0.6)
                });
                let is_webm = out_ext.eq_ignore_ascii_case("webm");
                let can_copy = !request.precise_cut
                    && !needs_fps_conversion
                    && !is_webm
                    && (!out_ext.eq_ignore_ascii_case("mov")
                        || video.codec.contains("avc")
                        || video.codec.contains("h264"));
                let allow_hw = !can_copy && !is_webm;
                let step_prefix = if can_copy {
                    "Remuxando clip".to_string()
                } else if is_webm {
                    "Procesando clip (VP9)".to_string()
                } else {
                    format!(
                        "Procesando clip ({})",
                        hw_encoder_display_name(detect_hw_video_encoder())
                    )
                };

                let scope = FfmpegProgressScope {
                    status: "cutting",
                    overall_base: clip_overall_base + clip_overall_span * 0.65,
                    overall_span: clip_overall_span * 0.35,
                    clip_base: 65.0,
                    clip_span: 35.0,
                    clip_index: Some(global_clip_idx),
                    clip_total: Some(grand_total_clips),
                    clip_name: Some(display_clip_name),
                    total_duration_secs: clip_dur,
                    step_prefix: &step_prefix,
                };
                let v_raw_str = v_raw.to_string_lossy().to_string();
                let a_raw_str = a_raw.to_string_lossy().to_string();
                let out_path_str = out_path.to_string_lossy().to_string();
                run_ffmpeg_with_hw_fallback(
                    sink,
                    job_id,
                    job_title,
                    &ffmpeg,
                    &out_path,
                    &scope,
                    allow_hw,
                    |hw_enc| {
                        let mut ff_args = vec![
                            "-y".to_string(),
                            "-ss".to_string(),
                            format!("{rel_v_ss:.3}"),
                        ];
                        if !can_copy && !is_webm && hw_enc != HwVideoEncoder::CpuSoftware {
                            ff_args.extend(["-hwaccel".to_string(), "auto".to_string()]);
                        }
                        ff_args.extend([
                            "-i".to_string(),
                            v_raw_str.clone(),
                            "-ss".to_string(),
                            format!("{rel_a_ss:.3}"),
                            "-i".to_string(),
                            a_raw_str.clone(),
                            "-map".to_string(),
                            "0:v:0".to_string(),
                            "-map".to_string(),
                            "1:a:0".to_string(),
                            "-t".to_string(),
                            format!("{clip_dur:.3}"),
                        ]);
                        if can_copy {
                            ff_args.extend([
                                "-c".to_string(),
                                "copy".to_string(),
                                "-avoid_negative_ts".to_string(),
                                "make_zero".to_string(),
                            ]);
                        } else {
                            if needs_fps_conversion {
                                if let Some(fps) = active_fps {
                                    ff_args.extend(["-vf".to_string(), format!("fps={fps}")]);
                                }
                            }
                            push_merge_codec_args(&mut ff_args, "video_audio", is_webm, true, hw_enc);
                        }
                        if !is_webm
                            && matches!(out_ext.to_ascii_lowercase().as_str(), "mp4" | "mov")
                        {
                            ff_args.extend(["-movflags".to_string(), "+faststart".to_string()]);
                        }
                        if request.options.embed_metadata {
                            ff_args.extend([
                                "-metadata".to_string(),
                                format!("title={}", clip.name),
                            ]);
                        }
                        ff_args.push(out_path_str.clone());
                        ff_args
                    },
                )
                .await?;
            }
        }
        Ok(())
    }
    .await;

    let _ = fs::remove_dir_all(&clip_tmp);
    res?;
    Ok(vec![out_path.to_string_lossy().to_string()])
}

fn resolve_existing_clip_files(
    reported: Vec<String>,
    dest_dir: &Path,
    file_stem: &str,
) -> Vec<String> {
    let valid_reported: Vec<String> = reported
        .into_iter()
        .filter(|p| fs::metadata(p).map(|m| m.len() >= 4096).unwrap_or(false))
        .collect();
    if !valid_reported.is_empty() {
        return valid_reported;
    }

    let mut scanned: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(dest_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if fname.ends_with(".part") || fname.ends_with(".ytdl") || fname.ends_with(".temp") {
                continue;
            }
            let matches_stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s == file_stem || s.starts_with(file_stem))
                .unwrap_or(false);
            if matches_stem && fs::metadata(&path).map(|m| m.len() >= 4096).unwrap_or(false) {
                scanned.push(path.to_string_lossy().to_string());
            }
        }
    }
    scanned
}

#[allow(clippy::too_many_arguments)]
async fn fallback_ytdlp_cut_clip(
    app: &AppHandle,
    job_id: &str,
    job_title: &str,
    request: &ClipExportRequest,
    dest_dir: &Path,
    file_stem: &str,
    step_msg: &str,
    start_str: &str,
    end_str: &str,
    clip_dur: f64,
    target_fps: Option<u32>,
    global_idx: usize,
    grand_total_clips: usize,
    display_clip_name: &str,
    clip_base_overall: f64,
    span_per_clip: f64,
    precise_cut: bool,
) -> Result<Vec<String>, (bool, String)> {
    let mut args = Vec::new();
    append_format_and_option_args_ext(&mut args, &request.options, true);
    args.push("--download-sections".to_string());
    args.push(format!("*{start_str}-{end_str}"));
    if precise_cut {
        args.push("--force-keyframes-at-cuts".to_string());
    }
    let template = dest_dir
        .join(format!("{file_stem}.%(ext)s"))
        .to_string_lossy()
        .to_string();
    args.push("-o".to_string());
    args.push(template);
    args.push("--print".to_string());
    args.push("after_move:__CLIPGEN_FILE__:%(filepath)s".to_string());
    args.push(request.url.clone());

    let dl_clip_span = if target_fps.is_some() { 75.0 } else { 100.0 };
    let dl_overall_span = span_per_clip * (dl_clip_span / 100.0);

    match run_ytdlp_with_progress(YtdlpRunConfig {
        app,
        job_id,
        title: job_title,
        args,
        base_percent: clip_base_overall,
        percent_span: dl_overall_span,
        clip_percent_base: 0.0,
        clip_percent_span: dl_clip_span,
        step_label: step_msg,
        clip_duration_secs: Some(clip_dur),
        clip_index: Some(global_idx),
        clip_total: Some(grand_total_clips),
        clip_name: Some(display_clip_name),
    })
    .await
    {
        Ok(raw_files) => {
            let files = resolve_existing_clip_files(raw_files, dest_dir, file_stem);
            if files.is_empty() {
                Err((
                    false,
                    "El archivo generado está vacío o corrupto (<4KB).".to_string(),
                ))
            } else if let Some(fps) = target_fps {
                let file_count = files.len().max(1);
                let per_file_overall = (span_per_clip - dl_overall_span) / file_count as f64;
                let per_file_clip = 25.0 / file_count as f64;
                let mut fps_err: Option<String> = None;
                for (fi, file_str) in files.iter().enumerate() {
                    let base_pct =
                        clip_base_overall + dl_overall_span + (fi as f64) * per_file_overall;
                    let base_clip_pct = 75.0 + (fi as f64) * per_file_clip;
                    if let Err(err) = ensure_file_target_fps(
                        app,
                        job_id,
                        job_title,
                        Path::new(file_str),
                        fps,
                        base_pct,
                        per_file_overall,
                        base_clip_pct,
                        per_file_clip,
                        Some(global_idx),
                        Some(grand_total_clips),
                        Some(display_clip_name),
                        Some(clip_dur),
                    )
                    .await
                    {
                        fps_err = Some(err);
                        break;
                    }
                }
                if let Some(err) = fps_err {
                    let cancelled = err == "__CANCELLED__" || is_job_cancelled(job_id);
                    Err((cancelled, err))
                } else {
                    Ok(files)
                }
            } else {
                Ok(files)
            }
        }
        Err(err) => {
            let cancelled = err == "__CANCELLED__" || is_job_cancelled(job_id);
            Err((cancelled, err))
        }
    }
}

fn clean_clip_title_prefix(name: &str) -> String {
    let re = regex::Regex::new(r"^(?i:(?:clip\s*#?\d+\s*[-:.]\s*|\d+[\.\-_)\s]+\s*))").unwrap();
    let cleaned = re.replace(name.trim(), "").trim().to_string();
    if cleaned.is_empty() {
        "Clip".to_string()
    } else {
        cleaned
    }
}

#[allow(clippy::too_many_arguments)]
async fn process_video_clip_group(
    app: &AppHandle,
    job_id: &str,
    job_title: &str,
    request: &ClipExportRequest,
    out_dir: &Path,
    group_base_pct: f64,
    group_span_pct: f64,
    global_clip_offset: usize,
    grand_total_clips: usize,
    is_multi_video: bool,
) -> Result<Vec<String>, (bool, String)> {
    let total = request.clips.len();
    let should_merge = request.merge_clips && total > 1;
    let session_tmp = out_dir.join(format!(".clipgen_tmp_{}_{}", job_id, global_clip_offset));
    fs::create_dir_all(&session_tmp)
        .map_err(|e| (false, format!("Error creando directorio temporal: {e}")))?;

    let dest_dir = if should_merge {
        session_tmp.clone()
    } else {
        out_dir.to_path_buf()
    };

    emit_job_event(
        app,
        JobProgressEvent {
            job_id: job_id.to_string(),
            title: job_title.to_string(),
            status: "queued".to_string(),
            percent: group_base_pct,
            clip_percent: Some(0.0),
            clip_index: Some(global_clip_offset + 1),
            clip_total: Some(grand_total_clips),
            clip_name: request.clips.first().map(|c| {
                if is_multi_video {
                    format!("{} — {}", request.video_title, c.name)
                } else {
                    c.name.clone()
                }
            }),
            speed: "--".to_string(),
            eta: "--".to_string(),
            current_step: format!("Analizando formato de \"{}\"...", request.video_title),
            output_files: vec![],
            log_line: Some(format!("Analizando streams para \"{}\"", request.video_title)),
        },
    );

    let mut dash_selection = match fetch_raw_video_json(job_id, &request.url).await {
        Ok(raw_json) => resolve_dash_selection(&raw_json, &request.options),
        Err((true, msg)) => {
            let _ = fs::remove_dir_all(&session_tmp);
            return Err((true, msg));
        }
        Err((false, _)) => None,
    };

    let native_fps = match dash_selection {
        Some(DashSelection::VideoAudio { ref video, .. }) => video.fps,
        Some(DashSelection::VideoOnly { ref video, .. }) => video.fps,
        _ => None,
    };
    let target_fps = if !should_merge && request.options.mode != "audio_only" {
        request.options.target_fps.filter(|&f| {
            if f == 0 {
                return false;
            }
            if let Some(nfps) = native_fps {
                if (nfps - f as f64).abs() <= 0.6 {
                    return false;
                }
            }
            true
        })
    } else {
        None
    };

    let safe_video_title = sanitize_filename(&request.video_title);
    let max_group_before_merge = if should_merge {
        group_span_pct * 0.88
    } else {
        group_span_pct
    };
    let span_per_clip = max_group_before_merge / total as f64;
    let mut group_files: Vec<String> = Vec::new();
    let total_clip_duration: f64 = request
        .clips
        .iter()
        .map(|c| (c.end_time - c.start_time).max(0.1))
        .sum();

    let clip_start_offset = request.options.clip_start_index.unwrap_or(1);
    let grand_max_number = grand_total_clips + clip_start_offset.saturating_sub(1);

    for (idx, clip) in request.clips.iter().enumerate() {
        let global_idx = global_clip_offset + idx + clip_start_offset;
        if is_job_cancelled(job_id) {
            let _ = fs::remove_dir_all(&session_tmp);
            return Err((true, "__CANCELLED__".to_string()));
        }

        let start_str = format_timestamp(clip.start_time);
        let end_str = format_timestamp(clip.end_time);
        let clip_dur = (clip.end_time - clip.start_time).max(0.1);
        let clean_clip_title = clean_clip_title_prefix(&clip.name);
        let safe_clip_name = sanitize_filename(&clean_clip_title);
        let display_clip_name = if is_multi_video {
            format!("{} — {}", request.video_title, clean_clip_title)
        } else {
            clean_clip_title.clone()
        };
        let step_msg = if is_multi_video {
            format!(
                "Clip {}/{}: \"{}\" ({} → {})",
                global_idx, grand_total_clips, display_clip_name, start_str, end_str
            )
        } else {
            format!(
                "Clip {}/{}: \"{}\" ({} → {})",
                idx + clip_start_offset,
                total + clip_start_offset - 1,
                clip.name,
                start_str,
                end_str
            )
        };

        let clip_base_overall = group_base_pct + (idx as f64) * span_per_clip;

        emit_job_event(
            app,
            JobProgressEvent {
                job_id: job_id.to_string(),
                title: job_title.to_string(),
                status: "cutting".to_string(),
                percent: clip_base_overall,
                clip_percent: Some(0.0),
                clip_index: Some(global_idx),
                clip_total: Some(grand_total_clips),
                clip_name: Some(display_clip_name.clone()),
                speed: "--".to_string(),
                eta: "--".to_string(),
                current_step: step_msg.clone(),
                output_files: group_files.clone(),
                log_line: Some(format!("▶ Iniciando {}", step_msg)),
            },
        );

        let is_clean_format = request
            .options
            .filename_format
            .as_deref()
            .unwrap_or("clean") != "full";
        let file_stem = if is_clean_format {
            if grand_max_number >= 10 {
                format!("{:02}. {safe_clip_name}", global_idx)
            } else {
                format!("{}. {safe_clip_name}", global_idx)
            }
        } else {
            if grand_max_number >= 10 {
                format!("{safe_video_title} - {:02}. {safe_clip_name}", global_idx)
            } else {
                format!("{safe_video_title} - {}. {safe_clip_name}", global_idx)
            }
        };
        let clip_res: Result<Vec<String>, (bool, String)> = if let Some(ref dash) = dash_selection {
            let first_attempt = download_and_cut_dash_clip(
                ProgressSink::App(app),
                job_id,
                job_title,
                dash,
                clip,
                request,
                &file_stem,
                &dest_dir,
                &session_tmp,
                target_fps,
                global_idx,
                grand_total_clips,
                clip_base_overall,
                span_per_clip,
                &display_clip_name,
            )
            .await;

            match first_attempt {
                Ok(files) => Ok(files),
                Err((true, msg)) => Err((true, msg)),
                Err((false, _first_err)) => {
                    invalidate_cached_raw_video_json(&request.url);
                    let mut refreshed_res: Option<Result<Vec<String>, (bool, String)>> = None;
                    match fetch_raw_video_json(job_id, &request.url).await {
                        Ok(fresh_json) => {
                            dash_selection = resolve_dash_selection(&fresh_json, &request.options);
                            if let Some(ref fresh_dash) = dash_selection {
                                refreshed_res = Some(
                                    download_and_cut_dash_clip(
                                        ProgressSink::App(app),
                                        job_id,
                                        job_title,
                                        fresh_dash,
                                        clip,
                                        request,
                                        &file_stem,
                                        &dest_dir,
                                        &session_tmp,
                                        target_fps,
                                        global_idx,
                                        grand_total_clips,
                                        clip_base_overall,
                                        span_per_clip,
                                        &display_clip_name,
                                    )
                                    .await,
                                );
                            }
                        }
                        Err((true, msg)) => {
                            refreshed_res = Some(Err((true, msg)));
                        }
                        Err((false, _)) => {}
                    }

                    match refreshed_res {
                        Some(Ok(files)) => Ok(files),
                        Some(Err((true, msg))) => Err((true, msg)),
                        _ if is_job_cancelled(job_id) => Err((true, "__CANCELLED__".to_string())),
                        _ => {
                            fallback_ytdlp_cut_clip(
                                app,
                                job_id,
                                job_title,
                                request,
                                &dest_dir,
                                &file_stem,
                                &step_msg,
                                &start_str,
                                &end_str,
                                clip_dur,
                                target_fps,
                                global_idx,
                                grand_total_clips,
                                &display_clip_name,
                                clip_base_overall,
                                span_per_clip,
                                request.precise_cut,
                            )
                            .await
                        }
                    }
                }
            }
        } else {
            fallback_ytdlp_cut_clip(
                app,
                job_id,
                job_title,
                request,
                &dest_dir,
                &file_stem,
                &step_msg,
                &start_str,
                &end_str,
                clip_dur,
                target_fps,
                global_idx,
                grand_total_clips,
                &display_clip_name,
                clip_base_overall,
                span_per_clip,
                request.precise_cut,
            )
            .await
        };

        match clip_res {
            Ok(files) => {
                group_files.extend(files);
                let done_pct = clip_base_overall + span_per_clip;
                emit_job_event(
                    app,
                    JobProgressEvent {
                        job_id: job_id.to_string(),
                        title: job_title.to_string(),
                        status: "cutting".to_string(),
                        percent: done_pct,
                        clip_percent: Some(100.0),
                        clip_index: Some(global_idx),
                        clip_total: Some(grand_total_clips),
                        clip_name: Some(display_clip_name.clone()),
                        speed: "--".to_string(),
                        eta: "00:00".to_string(),
                        current_step: format!(
                            "✓ Clip {}/{} finalizado: {}",
                            global_idx, grand_total_clips, clip.name
                        ),
                        output_files: group_files.clone(),
                        log_line: Some(format!(
                            "✓ Clip {}/{} completado: \"{}\"",
                            global_idx, grand_total_clips, clip.name
                        )),
                    },
                );
            }
            Err((cancelled, err)) => {
                let _ = fs::remove_dir_all(&session_tmp);
                return Err((cancelled, format!("Error en clip {global_idx}: {err}")));
            }
        }
    }

    if should_merge {
        let ext = if request.options.mode == "audio_only" {
            request.options.audio_format.as_str()
        } else {
            request.options.container.as_str()
        };
        let merged_path = next_unique_path(
            out_dir,
            &format!("{safe_video_title} - Clips Unidos ({total})"),
            ext,
        );

        let merge_res = run_ffmpeg_merge(
            app,
            job_id,
            job_title,
            &group_files,
            &merged_path,
            &request.options.mode,
            request.precise_cut,
            request.options.target_fps,
            total_clip_duration,
            group_base_pct + max_group_before_merge,
            group_span_pct * 0.12,
            grand_total_clips,
        )
        .await;

        let _ = fs::remove_dir_all(&session_tmp);
        match merge_res {
            Ok(final_path) => Ok(vec![final_path.to_string_lossy().to_string()]),
            Err(err) => {
                let cancelled = err == "__CANCELLED__" || is_job_cancelled(job_id);
                Err((cancelled, format!("Error uniendo clips: {err}")))
            }
        }
    } else {
        let _ = fs::remove_dir_all(&session_tmp);
        Ok(group_files)
    }
}

async fn run_export_batch_task(
    app: AppHandle,
    job_id: String,
    job_title: String,
    requests: Vec<ClipExportRequest>,
) {
    let grand_total_clips: usize = requests.iter().map(|r| r.clips.len()).sum();
    let is_multi_video = requests.len() > 1;
    let mut produced_files: Vec<String> = Vec::new();
    let mut processed_clips: usize = 0;

    for req in &requests {
        let out_dir = PathBuf::from(&req.options.output_dir);
        let group_count = req.clips.len();
        let group_base_pct = (processed_clips as f64 / grand_total_clips.max(1) as f64) * 100.0;
        let group_span_pct = (group_count as f64 / grand_total_clips.max(1) as f64) * 100.0;

        match process_video_clip_group(
            &app,
            &job_id,
            &job_title,
            req,
            &out_dir,
            group_base_pct,
            group_span_pct,
            processed_clips,
            grand_total_clips,
            is_multi_video,
        )
        .await
        {
            Ok(files) => {
                produced_files.extend(files);
                processed_clips += group_count;
            }
            Err((cancelled, err)) => {
                emit_job_event(
                    &app,
                    JobProgressEvent {
                        job_id: job_id.clone(),
                        title: job_title.clone(),
                        status: if cancelled { "cancelled" } else { "error" }.to_string(),
                        percent: 0.0,
                        clip_percent: None,
                        clip_index: Some((processed_clips + 1).min(grand_total_clips)),
                        clip_total: Some(grand_total_clips),
                        clip_name: None,
                        speed: "--".to_string(),
                        eta: "--".to_string(),
                        current_step: if cancelled {
                            "Descarga cancelada por el usuario".to_string()
                        } else {
                            err.clone()
                        },
                        output_files: if cancelled { produced_files } else { vec![] },
                        log_line: if cancelled {
                            None
                        } else {
                            Some(format!("ERROR: {err}"))
                        },
                    },
                );
                return;
            }
        }
    }

    emit_job_event(
        &app,
        JobProgressEvent {
            job_id,
            title: job_title,
            status: "completed".to_string(),
            percent: 100.0,
            clip_percent: Some(100.0),
            clip_index: Some(grand_total_clips),
            clip_total: Some(grand_total_clips),
            clip_name: requests
                .last()
                .and_then(|r| r.clips.last())
                .map(|c| c.name.clone()),
            speed: "--".to_string(),
            eta: "00:00".to_string(),
            current_step: format!(
                "{grand_total_clips} clip(s) en {} archivo(s) exportado(s)",
                produced_files.len()
            ),
            output_files: produced_files,
            log_line: Some(format!(
                "✓ Exportación finalizada: {grand_total_clips} clip(s) completado(s)."
            )),
        },
    );
}

fn validate_export_requests(requests: &[ClipExportRequest]) -> Result<(), String> {
    if requests.is_empty() {
        return Err("No hay clips seleccionados para exportar.".to_string());
    }
    for req in requests {
        if req.clips.is_empty() {
            return Err("Debes seleccionar al menos un clip para exportar.".to_string());
        }
        for clip in &req.clips {
            if clip.end_time <= clip.start_time {
                return Err(format!(
                    "El clip '{}' tiene un rango de tiempo inválido.",
                    clip.name
                ));
            }
        }
        let out_dir = PathBuf::from(&req.options.output_dir);
        fs::create_dir_all(&out_dir)
            .map_err(|e| format!("No se pudo crear la carpeta de salida: {e}"))?;
    }
    Ok(())
}

fn start_batch_job(app: AppHandle, requests: Vec<ClipExportRequest>) -> Result<String, String> {
    validate_export_requests(&requests)?;
    let _ = ensure_ytdlp_ready()?;

    let grand_total: usize = requests.iter().map(|r| r.clips.len()).sum();
    let job_id = Uuid::new_v4().to_string();
    let job_id_clone = job_id.clone();

    let job_title = if requests.len() == 1 {
        let req = &requests[0];
        if grand_total == 1 {
            format!("Clip: {}", req.clips[0].name)
        } else if req.merge_clips {
            format!("Highlight Reel ({grand_total} clips) — {}", req.video_title)
        } else {
            format!("Exportación de {grand_total} clips — {}", req.video_title)
        }
    } else {
        format!(
            "Exportación por lotes ({grand_total} clips de {} videos)",
            requests.len()
        )
    };

    register_job(&job_id, &job_title);

    let first_clip_name = requests
        .first()
        .and_then(|r| r.clips.first())
        .map(|c| c.name.clone());

    emit_job_event(
        &app,
        JobProgressEvent {
            job_id: job_id.clone(),
            title: job_title.clone(),
            status: "queued".to_string(),
            percent: 0.0,
            clip_percent: Some(0.0),
            clip_index: Some(1),
            clip_total: Some(grand_total),
            clip_name: first_clip_name,
            speed: "--".to_string(),
            eta: "--".to_string(),
            current_step: format!("Preparando extracción de {grand_total} clip(s)..."),
            output_files: vec![],
            log_line: None,
        },
    );

    tokio::spawn(async move {
        run_export_batch_task(app, job_id_clone.clone(), job_title, requests).await;
        unregister_job(&job_id_clone);
    });

    Ok(job_id)
}

#[tauri::command]
pub async fn export_clips(
    app: AppHandle,
    request: ClipExportRequest,
) -> Result<String, String> {
    start_batch_job(app, vec![request])
}

#[tauri::command]
pub async fn export_clips_batch(
    app: AppHandle,
    requests: Vec<ClipExportRequest>,
) -> Result<String, String> {
    start_batch_job(app, requests)
}

pub fn persistent_clips_path() -> PathBuf {
    let app_dir = get_binaries_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    app_dir.join("saved_clips.json")
}

fn load_persistent_clips_from_path(path: &Path) -> Result<Vec<SavedClipEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Error leyendo {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<SavedClipEntry>>(&content)
        .map_err(|e| format!("Error parseando {}: {e}", path.display()))
}

fn save_persistent_clips_to_path(path: &Path, clips: &[SavedClipEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear carpeta de datos: {e}"))?;
    }
    let json = serde_json::to_string_pretty(clips)
        .map_err(|e| format!("Error serializando clips guardados: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, &json).is_ok() && fs::rename(&tmp, path).is_ok() {
        return Ok(());
    }
    let _ = fs::remove_file(&tmp);
    fs::write(path, json).map_err(|e| format!("Error guardando clips en JSON: {e}"))
}

#[tauri::command]
pub fn get_persistent_clips_file_path() -> String {
    persistent_clips_path().to_string_lossy().to_string()
}

#[tauri::command]
pub fn load_persistent_clips() -> Result<Vec<SavedClipEntry>, String> {
    load_persistent_clips_from_path(&persistent_clips_path())
}

#[tauri::command]
pub fn save_persistent_clips(clips: Vec<SavedClipEntry>) -> Result<(), String> {
    save_persistent_clips_to_path(&persistent_clips_path(), &clips)
}

#[tauri::command]
pub fn get_default_download_dir() -> Result<String, String> {
    let base = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let target = base.join("ClipGen");
    fs::create_dir_all(&target)
        .map_err(|e| format!("No se pudo inicializar la carpeta de descargas: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn clean_windows_path(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = resolved.to_string_lossy();
    let stripped = s.strip_prefix(r"\\?\").unwrap_or(&s);
    stripped.replace('/', "\\")
}

#[tauri::command]
pub fn open_output_folder(path: String) -> Result<(), String> {
    let raw_target = PathBuf::from(path.trim());
    let _ = fs::create_dir_all(&raw_target);
    let target = if raw_target.exists() {
        raw_target
    } else if let Some(parent) = raw_target.parent().filter(|p| p.exists()) {
        parent.to_path_buf()
    } else {
        return Err(format!("La ruta no existe: {path}"));
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let clean_path = clean_windows_path(&target);
        let mut cmd = hidden_std_command(Path::new("explorer.exe"));
        if target.is_file() {
            // explorer.exe fails to parse /select when quoted as a single argument
            cmd.raw_arg(format!("/select,\"{clean_path}\""));
        } else {
            cmd.raw_arg(format!("\"{clean_path}\""));
        }
        cmd.spawn()
            .map_err(|e| format!("No se pudo abrir el Explorador: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = hidden_std_command(Path::new("open"));
        if target.is_file() {
            cmd.arg("-R").arg(&target);
        } else {
            cmd.arg(&target);
        }
        cmd.spawn()
            .map_err(|e| format!("No se pudo abrir Finder: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if target.is_file() {
            target.parent().unwrap_or(&target)
        } else {
            &target
        };
        hidden_std_command(Path::new("xdg-open"))
            .arg(dir)
            .spawn()
            .map_err(|e| format!("No se pudo abrir el gestor de archivos: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn pick_download_folder(initial_dir: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Selecciona la carpeta para guardar tus clips y descargas");

    if let Some(dir) = initial_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = Path::new(dir);
        if p.exists() {
            dialog = dialog.set_directory(p);
        }
    }

    let folder = dialog.pick_folder().await;
    if let Some(f) = folder {
        let path = f.path().to_string_lossy().to_string();
        let _ = fs::create_dir_all(&path);
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_options() -> ManualDownloadOptions {
        ManualDownloadOptions {
            mode: "video_audio".to_string(),
            quality_preset: "1080".to_string(),
            custom_video_format_id: None,
            custom_audio_format_id: None,
            audio_track_id: None,
            audio_format_id: None,
            container: "mp4".to_string(),
            audio_format: "mp3".to_string(),
            audio_bitrate: "192K".to_string(),
            embed_subtitles: false,
            subtitle_lang: "es".to_string(),
            embed_thumbnail: false,
            embed_metadata: true,
            rate_limit: None,
            custom_args: None,
            target_fps: None,
            output_dir: "C:/Downloads/ClipGen".to_string(),
            filename_format: None,
            clip_start_index: None,
        }
    }

    #[test]
    fn test_format_concat_entry() {
        let p = Path::new(r"C:\Users\Test\clip'1.mp4");
        assert_eq!(format_concat_entry(p), "file 'C:/Users/Test/clip'\\''1.mp4'");
    }

    #[test]
    fn test_compute_end_pts_handles_manifestless_and_standard() {
        // Post-live manifestless lavf reports duration = last_pts when start_time > 0.5
        assert!((compute_end_pts(2125.4, 2139.4) - 2139.4).abs() < 1e-6);
        // Standard relative duration from start_time = 0
        assert!((compute_end_pts(0.0, 14.0) - 14.0).abs() < 1e-6);
        // Relative duration reported smaller than non-zero start_time
        assert!((compute_end_pts(120.0, 14.0) - 134.0).abs() < 1e-6);
    }

    #[test]
    fn test_select_dash_video_and_audio_formats() {
        let formats = vec![
            json!({
                "format_id": "298",
                "ext": "mp4",
                "vcodec": "avc1.640020",
                "acodec": "none",
                "height": 720,
                "fps": 60,
                "tbr": 2200.0,
                "protocol": "http_dash_segments",
                "fragments": [{"url": "https://cdn.example/v720/0"}]
            }),
            json!({
                "format_id": "299",
                "ext": "mp4",
                "vcodec": "avc1.64002a",
                "acodec": "none",
                "height": 1080,
                "fps": 60,
                "tbr": 4200.0,
                "protocol": "http_dash_segments",
                "fragments": [{"url": "https://cdn.example/v1080/0"}]
            }),
            json!({
                "format_id": "315",
                "ext": "webm",
                "vcodec": "vp9",
                "acodec": "none",
                "height": 2160,
                "fps": 60,
                "tbr": 12000.0,
                "protocol": "http_dash_segments",
                "fragments": [{"url": "https://cdn.example/v2160/0"}]
            }),
            json!({
                "format_id": "140-drc",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "language": "es",
                "language_preference": 10,
                "format_note": "Spanish original, DRC",
                "abr": 128.0,
                "protocol": "http_dash_segments",
                "fragments": [{"url": "https://cdn.example/a_drc/0"}]
            }),
            json!({
                "format_id": "140",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "language": "es",
                "language_preference": 10,
                "format_note": "Spanish original, medium",
                "abr": 128.0,
                "protocol": "http_dash_segments",
                "fragments": [{"url": "https://cdn.example/a_es/0"}]
            }),
            json!({
                "format_id": "140-en",
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "language": "en",
                "language_preference": 1,
                "format_note": "English, medium",
                "abr": 130.0,
                "protocol": "http_dash_segments",
                "fragments": [{"url": "https://cdn.example/a_en/0"}]
            }),
        ];

        let mut opts = sample_options();
        let v = select_dash_video_format(&formats, &opts).unwrap();
        assert_eq!(v["format_id"].as_str(), Some("299"));

        opts.quality_preset = "720".to_string();
        let v720 = select_dash_video_format(&formats, &opts).unwrap();
        assert_eq!(v720["format_id"].as_str(), Some("298"));

        // Non-DRC original Spanish track should beat DRC & English
        let a_default = select_dash_audio_format(&formats, &opts).unwrap();
        assert_eq!(a_default["format_id"].as_str(), Some("140"));

        // Explicit audio_track_id selects English
        opts.audio_track_id = Some("en".to_string());
        let a_en = select_dash_audio_format(&formats, &opts).unwrap();
        assert_eq!(a_en["format_id"].as_str(), Some("140-en"));
    }

    #[test]
    fn test_saved_clips_json_roundtrip() {
        let dir = std::env::temp_dir().join(format!("clipgen_test_{}", Uuid::new_v4()));
        let file = dir.join("saved_clips.json");

        let entries = vec![SavedClipEntry {
            id: "clip-1".to_string(),
            name: "plip plop plip plop".to_string(),
            start_time: 2130.275,
            end_time: 2220.4,
            video_url: "https://www.youtube.com/watch?v=ioGKn5lS1_Q".to_string(),
            video_id: "ioGKn5lS1_Q".to_string(),
            video_title: "Bloodborne DLC".to_string(),
            video_thumbnail: "https://i.ytimg.com/vi/ioGKn5lS1_Q/maxresdefault.jpg".to_string(),
            video_duration: 6419.0,
            precise_cut: true,
            merge_clips: false,
            options: sample_options(),
            notes: None,
            selected: Some(false),
        }];

        save_persistent_clips_to_path(&file, &entries).unwrap();
        let loaded = load_persistent_clips_from_path(&file).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "clip-1");
        assert_eq!(loaded[0].name, "plip plop plip plop");
        assert_eq!(loaded[0].video_id, "ioGKn5lS1_Q");
        assert_eq!(loaded[0].options.quality_preset, "1080");
        assert!((loaded[0].start_time - 2130.275).abs() < 1e-6);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_existing_clip_files_recovers_accented_stem() {
        let dir = std::env::temp_dir().join(format!("clipgen_stem_test_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let stem = "Me dijeron que jugara al DLC de BLOODBORNE y es mucho más difícil - 01_rakuyo";
        let real_file = dir.join(format!("{stem}.mp4"));
        fs::write(&real_file, vec![0u8; 8192]).unwrap();

        let corrupted_reported = vec![dir
            .join("Me dijeron que jugara al DLC de BLOODBORNE y es mucho m\u{FFFD}s dif\u{FFFD}cil - 01_rakuyo.mp4")
            .to_string_lossy()
            .to_string()];
        let resolved = resolve_existing_clip_files(corrupted_reported, &dir, stem);
        assert_eq!(resolved.len(), 1);
        assert_eq!(PathBuf::from(&resolved[0]), real_file);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[ignore = "Live network test requiring YouTube access"]
    async fn e2e_verify_dash_clip_export_bloodborne() {
        let _ = ensure_ytdlp_ready().expect("yt-dlp ready");
        let url = "https://www.youtube.com/watch?v=ioGKn5lS1_Q";
        let job_id = format!("e2e_{}", Uuid::new_v4());
        register_job(&job_id, "E2E Bloodborne DASH");

        let raw_json = fetch_raw_video_json(&job_id, url)
            .await
            .expect("fetch_raw_video_json failed");

        let mut opts = sample_options();
        opts.quality_preset = "1080".to_string();
        let dash = resolve_dash_selection(&raw_json, &opts)
            .expect("Expected DASH selection on ioGKn5lS1_Q");

        let dir = std::env::temp_dir().join(format!("clipgen_e2e_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let tmp_dir = dir.join("tmp");
        fs::create_dir_all(&tmp_dir).unwrap();

        let clip1 = ClipSegment {
            id: "c1".to_string(),
            name: "plip plop plip plop".to_string(),
            start_time: 2103.725, // 00:35:03.725
            end_time: 2230.027,   // 00:37:10.027
            notes: None,
            selected: Some(false),
        };
        let clip2 = ClipSegment {
            id: "c2".to_string(),
            name: "boss cosmico Fracasos Vivientes".to_string(),
            start_time: 2261.850, // 00:37:41.850
            end_time: 2746.450,   // 00:45:46.450
            notes: None,
            selected: Some(false),
        };
        let req = ClipExportRequest {
            url: url.to_string(),
            video_title: "Bloodborne DLC".to_string(),
            clips: vec![clip1.clone(), clip2.clone()],
            merge_clips: false,
            precise_cut: true,
            options: opts,
        };

        let events = std::sync::Mutex::new(Vec::<JobProgressEvent>::new());
        let produced1 = download_and_cut_dash_clip(
            ProgressSink::Buffer(&events),
            &job_id,
            "E2E Bloodborne",
            &dash,
            &clip1,
            &req,
            "bloodborne_test_1",
            &dir,
            &tmp_dir,
            None,
            1,
            2,
            0.0,
            50.0,
            "plip plop plip plop",
        )
        .await;

        let produced2 = download_and_cut_dash_clip(
            ProgressSink::Buffer(&events),
            &job_id,
            "E2E Bloodborne",
            &dash,
            &clip2,
            &req,
            "bloodborne_test_2",
            &dir,
            &tmp_dir,
            None,
            2,
            2,
            50.0,
            50.0,
            "boss cosmico Fracasos Vivientes",
        )
        .await;

        unregister_job(&job_id);
        let files1 = produced1.expect("Clip 1 download_and_cut_dash_clip failed");
        let files2 = produced2.expect("Clip 2 download_and_cut_dash_clip failed");
        assert_eq!(files1.len(), 1);
        assert_eq!(files2.len(), 1);
        let out_file1 = PathBuf::from(&files1[0]);
        let out_file2 = PathBuf::from(&files2[0]);
        let size1 = fs::metadata(&out_file1).unwrap().len();
        let size2 = fs::metadata(&out_file2).unwrap().len();
        assert!(size1 > 1_000_000, "Clip 1 output unexpectedly small: {size1} bytes");
        assert!(size2 > 5_000_000, "Clip 2 output unexpectedly small: {size2} bytes");

        let ev_list = events.lock().unwrap();
        let has_dl_progress = ev_list.iter().any(|e| {
            e.status == "downloading"
                && e.percent > 1.0
                && e.clip_percent.unwrap_or(0.0) > 1.0
        });
        let has_cut_progress = ev_list.iter().any(|e| {
            e.status == "cutting"
                && e.percent > 65.0
                && e.clip_percent.unwrap_or(0.0) > 65.0
        });
        println!(
            "E2E clip1: {:?} ({} bytes), clip2: {:?} ({} bytes), events={}, dl_prog={}, cut_prog={}",
            out_file1,
            size1,
            out_file2,
            size2,
            ev_list.len(),
            has_dl_progress,
            has_cut_progress
        );
        assert!(has_dl_progress, "Expected moving download progress events");
        assert!(has_cut_progress, "Expected moving cutting progress events");

        let ffprobe = ffprobe_binary_path();
        for (out_file, expected_dur) in [(&out_file1, 126.302f64), (&out_file2, 484.600f64)] {
            let probe_out = hidden_tokio_command(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate",
                    "-of",
                    "json",
                ])
                .arg(out_file)
                .output()
                .await
                .unwrap();
            assert!(probe_out.status.success(), "ffprobe failed for {:?}", out_file);
            let probe_json: Value = serde_json::from_slice(&probe_out.stdout).unwrap();
            println!(
                "ffprobe ({:?}): {}",
                out_file.file_name().unwrap(),
                serde_json::to_string_pretty(&probe_json).unwrap()
            );

            let streams = probe_json["streams"].as_array().unwrap();
            assert!(streams.iter().any(|s| s["codec_type"] == "video"
                && s["width"].as_u64() == Some(1920)
                && s["height"].as_u64() == Some(1080)));
            assert!(streams.iter().any(|s| s["codec_type"] == "audio"));
            let dur: f64 = probe_json["format"]["duration"].as_str().unwrap().parse().unwrap();
            assert!(
                (dur - expected_dur).abs() < 2.0,
                "Unexpected duration for {:?}: {dur} vs {expected_dur}",
                out_file
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[ignore = "Live network test requiring YouTube access"]
    async fn e2e_verify_sidx_range_clip_export_bloodborne_vod() {
        let _ = ensure_ytdlp_ready().expect("yt-dlp ready");
        let url = "https://www.youtube.com/watch?v=t0zmFmfvd9c";
        let job_id = format!("e2e_sidx_{}", Uuid::new_v4());
        register_job(&job_id, "E2E Bloodborne VOD sidx");

        let raw_json = fetch_raw_video_json(&job_id, url)
            .await
            .expect("fetch_raw_video_json failed");

        let mut opts = sample_options();
        opts.quality_preset = "best".to_string();
        let dash = resolve_dash_selection(&raw_json, &opts)
            .expect("Expected sidx/DASH selection on t0zmFmfvd9c");

        let dir = std::env::temp_dir().join(format!("clipgen_sidx_e2e_{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let tmp_dir = dir.join("tmp");
        fs::create_dir_all(&tmp_dir).unwrap();

        let clip = ClipSegment {
            id: "c_perro".to_string(),
            name: "perro de bolivia".to_string(),
            start_time: 1838.05,
            end_time: 1866.6534,
            notes: None,
            selected: Some(false),
        };
        let req = ClipExportRequest {
            url: url.to_string(),
            video_title: "Me dijeron que jugara al DLC de BLOODBORNE y es mucho más difícil de lo que esperaba!".to_string(),
            clips: vec![clip.clone()],
            merge_clips: false,
            precise_cut: false,
            options: opts,
        };

        let events = std::sync::Mutex::new(Vec::<JobProgressEvent>::new());
        let t0 = Instant::now();
        let produced = download_and_cut_dash_clip(
            ProgressSink::Buffer(&events),
            &job_id,
            "E2E Bloodborne VOD",
            &dash,
            &clip,
            &req,
            "Me dijeron que jugara al DLC de BLOODBORNE y es mucho más difícil - 02_perro de bolivia",
            &dir,
            &tmp_dir,
            None,
            1,
            1,
            0.0,
            100.0,
            "perro de bolivia",
        )
        .await;
        let elapsed = t0.elapsed().as_secs_f64();

        unregister_job(&job_id);
        let files = produced.expect("sidx download_and_cut_dash_clip failed");
        assert_eq!(files.len(), 1);
        let out_file = PathBuf::from(&files[0]);
        let size = fs::metadata(&out_file).unwrap().len();
        assert!(size > 5_000_000, "Output file unexpectedly small: {size} bytes");

        let ffprobe = ffprobe_binary_path();
        let probe_out = hidden_tokio_command(&ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate",
                "-of",
                "json",
            ])
            .arg(&out_file)
            .output()
            .await
            .unwrap();
        assert!(probe_out.status.success(), "ffprobe failed");
        let probe_json: Value = serde_json::from_slice(&probe_out.stdout).unwrap();
        println!(
            "SIDX E2E completed in {elapsed:.2}s ({size} bytes): {}",
            serde_json::to_string_pretty(&probe_json).unwrap()
        );

        let streams = probe_json["streams"].as_array().unwrap();
        assert!(streams.iter().any(|s| s["codec_type"] == "video" && s["height"].as_u64() == Some(1440)));
        assert!(streams.iter().any(|s| s["codec_type"] == "audio"));

        let _ = fs::remove_dir_all(&dir);
    }
}
