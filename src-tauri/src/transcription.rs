use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::BufReader as TokioBufReader;
use tokio::sync::{mpsc, watch};

use crate::binary_manager::{
    ffmpeg_binary_path, get_binaries_dir, hidden_std_command, hidden_tokio_command,
};
use crate::models::{
    format_timestamp, sanitize_filename, TranscriptionProgressEvent, TranscriptionResult,
    TranscriptionSegment,
};
use crate::ytdlp::{
    classify_audio_track, ensure_ytdlp_ready, get_cached_raw_video_json, kill_process_tree,
    parse_ffmpeg_speed, parse_ffmpeg_time_secs, read_next_progress_line, wait_for_cancel,
};

const TRANSCRIBE_SCRIPT: &str = include_str!("../scripts/transcribe_audio.py");

static NEXT_TRANSCRIPTION_RUN_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_TRANSCRIPTION: OnceLock<Mutex<Option<ActiveTranscriptionHandle>>> = OnceLock::new();

static RE_PCT: OnceLock<Regex> = OnceLock::new();
static RE_SPEED: OnceLock<Regex> = OnceLock::new();
static RE_ETA: OnceLock<Regex> = OnceLock::new();
static RE_SIZE: OnceLock<Regex> = OnceLock::new();
static RE_FRAG: OnceLock<Regex> = OnceLock::new();

fn re_pct() -> &'static Regex {
    RE_PCT.get_or_init(|| Regex::new(r"([0-9]+(?:\.[0-9]+)?)%").unwrap())
}

fn re_speed() -> &'static Regex {
    RE_SPEED.get_or_init(|| Regex::new(r"at\s+([0-9.]+\S+/s)").unwrap())
}

fn re_eta() -> &'static Regex {
    RE_ETA.get_or_init(|| Regex::new(r"ETA\s+([0-9:]+)").unwrap())
}

fn re_size() -> &'static Regex {
    RE_SIZE.get_or_init(|| Regex::new(r"of\s+(~?\s*[0-9.]+\s*[KMGT]?i?B)").unwrap())
}

fn re_frag() -> &'static Regex {
    RE_FRAG.get_or_init(|| Regex::new(r"\(frag\s+([0-9]+/[0-9]+)\)").unwrap())
}

fn is_ignorable_ytdlp_warning(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("no supported javascript runtime")
        || lower.contains("javascript runtime could be found")
        || lower.contains("only deno is enabled by default")
        || lower.contains("youtube extraction without a js runtime has been deprecated")
        || lower.contains("wiki/ejs")
        || lower.contains("--js-runtimes")
}

struct ActiveTranscriptionHandle {
    run_id: u64,
    cancelled: Arc<AtomicBool>,
    cancel_tx: watch::Sender<bool>,
    pid: Arc<Mutex<Option<u32>>>,
}

fn active_transcription_slot() -> &'static Mutex<Option<ActiveTranscriptionHandle>> {
    ACTIVE_TRANSCRIPTION.get_or_init(|| Mutex::new(None))
}

struct ActiveTranscriptionGuard {
    run_id: u64,
}

impl Drop for ActiveTranscriptionGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = active_transcription_slot().lock() {
            if slot.as_ref().map(|h| h.run_id) == Some(self.run_id) {
                *slot = None;
            }
        }
    }
}

fn register_transcription_run() -> (
    u64,
    Arc<AtomicBool>,
    watch::Receiver<bool>,
    Arc<Mutex<Option<u32>>>,
    ActiveTranscriptionGuard,
) {
    // Cancel any previous run if still active
    if let Ok(mut slot) = active_transcription_slot().lock() {
        if let Some(prev) = slot.take() {
            prev.cancelled.store(true, Ordering::SeqCst);
            let _ = prev.cancel_tx.send(true);
            if let Ok(mut pid_guard) = prev.pid.lock() {
                if let Some(p) = pid_guard.take() {
                    kill_process_tree(p);
                }
            }
        }
    }

    let run_id = NEXT_TRANSCRIPTION_RUN_ID.fetch_add(1, Ordering::SeqCst);
    let cancelled = Arc::new(AtomicBool::new(false));
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let pid = Arc::new(Mutex::new(None));

    if let Ok(mut slot) = active_transcription_slot().lock() {
        *slot = Some(ActiveTranscriptionHandle {
            run_id,
            cancelled: Arc::clone(&cancelled),
            cancel_tx,
            pid: Arc::clone(&pid),
        });
    }

    (
        run_id,
        cancelled,
        cancel_rx,
        pid,
        ActiveTranscriptionGuard { run_id },
    )
}

fn set_active_pid(pid_slot: &Arc<Mutex<Option<u32>>>, pid: Option<u32>) {
    if let Ok(mut guard) = pid_slot.lock() {
        *guard = pid;
    }
}

fn emit_progress(
    app: &AppHandle,
    last_pct: &Arc<Mutex<f64>>,
    stage: &str,
    percent: f64,
    message: impl Into<String>,
    detail: Option<String>,
    log_line: Option<String>,
) {
    let clamped = if stage == "completed" {
        100.0
    } else if stage == "cancelled" {
        percent.clamp(0.0, 100.0)
    } else {
        let mut guard = last_pct.lock().unwrap_or_else(|e| e.into_inner());
        let next = percent.max(*guard).clamp(0.0, 99.0);
        *guard = next;
        next
    };

    let _ = app.emit(
        "transcription-progress",
        TranscriptionProgressEvent {
            stage: stage.to_string(),
            percent: clamped,
            message: message.into(),
            detail,
            log_line,
        },
    );
}

#[tauri::command]
pub async fn cancel_transcription(app: AppHandle) -> Result<(), String> {
    let pid_to_kill = {
        let Ok(mut slot) = active_transcription_slot().lock() else {
            return Ok(());
        };
        if let Some(handle) = slot.as_mut() {
            handle.cancelled.store(true, Ordering::SeqCst);
            let _ = handle.cancel_tx.send(true);
            handle.pid.lock().ok().and_then(|mut g| g.take())
        } else {
            None
        }
    };

    if let Some(pid) = pid_to_kill {
        kill_process_tree(pid);
    }

    let _ = app.emit(
        "transcription-progress",
        TranscriptionProgressEvent {
            stage: "cancelled".to_string(),
            percent: 0.0,
            message: "Transcripción cancelada por el usuario.".to_string(),
            detail: None,
            log_line: Some("⛔ Transcripción cancelada por el usuario.".to_string()),
        },
    );

    Ok(())
}

fn find_python_interpreter() -> (String, Vec<String>) {
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let py311 = Path::new(&local_appdata)
        .join("Programs")
        .join("Python")
        .join("Python311")
        .join("python.exe");
    if py311.exists() {
        return (py311.to_string_lossy().to_string(), vec![]);
    }

    // Try python in PATH
    if let Ok(output) = hidden_std_command(Path::new("python"))
        .arg("--version")
        .output()
    {
        if output.status.success() {
            return ("python".to_string(), vec![]);
        }
    }

    // Try py -3.11
    if let Ok(output) = hidden_std_command(Path::new("py"))
        .args(["-3.11", "--version"])
        .output()
    {
        if output.status.success() {
            return ("py".to_string(), vec!["-3.11".to_string()]);
        }
    }

    ("python".to_string(), vec![])
}

fn format_hms_short(secs: f64) -> String {
    let total = secs.max(0.0).floor() as u64;
    let s = total % 60;
    let m = (total / 60) % 60;
    let h = total / 3600;
    if h > 0 {
        format!("{:02}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

fn cleanup_stale_transcription_files(temp_dir: &Path) {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(7200))
        .unwrap_or(UNIX_EPOCH);
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let is_temp_artifact = name.starts_with("audio_")
            || name.ends_with(".part")
            || name.ends_with(".ytdl")
            || name.ends_with(".pcm.raw")
            || name.ends_with(".wav");
        if !is_temp_artifact {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

fn cleanup_prefix_files(temp_dir: &Path, audio_id: &str) {
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name.starts_with(audio_id) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn find_downloaded_audio(temp_dir: &Path, audio_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(temp_dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if !name.starts_with(&format!("{audio_id}.")) {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(ext.as_str(), "part" | "ytdl" | "temp" | "tmp" | "raw") {
            continue;
        }
        if entry.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

fn pick_cached_direct_audio_url(raw_json: &Value) -> Option<(String, String, String)> {
    let formats = raw_json["formats"].as_array()?;
    let candidates: Vec<&Value> = formats
        .iter()
        .filter(|f| {
            let proto = f["protocol"].as_str().unwrap_or("");
            let is_direct_http = proto == "https" || proto == "http";
            let vcodec = f["vcodec"].as_str().unwrap_or("none");
            let acodec = f["acodec"].as_str().unwrap_or("none");
            let has_frags = f["fragments"]
                .as_array()
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            let has_url = f["url"]
                .as_str()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            is_direct_http && vcodec == "none" && !acodec.is_empty() && acodec != "none" && !has_frags && has_url
        })
        .collect();

    if candidates.is_empty() {
        return None;
    }

    let meta_for = |f: &&Value| {
        let fmt_id = f["format_id"].as_str().unwrap_or("");
        let fmt_note = f["format_note"].as_str().unwrap_or("");
        let language = f["language"].as_str();
        let lang_pref = f["language_preference"].as_i64().unwrap_or(-1);
        classify_audio_track(fmt_id, fmt_note, language, lang_pref)
    };

    let originals: Vec<&Value> = candidates
        .iter()
        .copied()
        .filter(|f| meta_for(f).2)
        .collect();
    let pool = if originals.is_empty() {
        candidates
    } else {
        originals
    };

    let non_drc: Vec<&Value> = pool.iter().copied().filter(|f| !meta_for(f).3).collect();
    let final_pool = if non_drc.is_empty() { pool } else { non_drc };

    // Prefer compact audio bitrate (40-140 kbps) with lowest bitrate >= 40 to maximize speed
    let chosen = final_pool.into_iter().min_by_key(|f| {
        let abr = f["abr"]
            .as_f64()
            .or_else(|| f["tbr"].as_f64())
            .unwrap_or(128.0);
        let in_sweet_spot = u8::from(!(40.0..=140.0).contains(&abr));
        let abr_key = abr.max(1.0).round() as u64;
        (in_sweet_spot, abr_key)
    })?;

    let direct_url = chosen["url"].as_str()?.trim().to_string();
    let fmt_id = chosen["format_id"].as_str().unwrap_or("audio").to_string();
    let ua = chosen["http_headers"]["User-Agent"]
        .as_str()
        .or_else(|| raw_json["http_headers"]["User-Agent"].as_str())
        .unwrap_or("")
        .to_string();

    Some((direct_url, ua, fmt_id))
}

async fn try_fast_range_ffmpeg_audio(
    app: &AppHandle,
    ffmpeg: &Path,
    trimmed_url: &str,
    out_wav: &Path,
    start_secs: f64,
    end_secs: f64,
    cancelled: &Arc<AtomicBool>,
    mut cancel_rx: watch::Receiver<bool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
    last_pct: &Arc<Mutex<f64>>,
) -> Result<bool, String> {
    let Some(raw_json) = get_cached_raw_video_json(trimmed_url) else {
        return Ok(false);
    };
    let Some((direct_url, ua, fmt_id)) = pick_cached_direct_audio_url(&raw_json) else {
        return Ok(false);
    };

    let dur = (end_secs - start_secs).max(0.5);
    let _ = fs_remove_if_exists(out_wav);

    emit_progress(
        app,
        last_pct,
        "downloading_audio",
        4.0,
        format!("Extrayendo tramo de audio directo (formato {fmt_id})..."),
        Some(format!(
            "00:00 / {} · HTTP rango directo",
            format_hms_short(dur)
        )),
        Some(format!(
            "⚡ Fast-path FFmpeg activo: formato {fmt_id} ({} → {})",
            format_hms_short(start_secs),
            format_hms_short(end_secs)
        )),
    );

    let mut cmd = hidden_tokio_command(ffmpeg);
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-stats".to_string(),
        "-stats_period".to_string(),
        "0.25".to_string(),
        "-reconnect".to_string(),
        "1".to_string(),
        "-reconnect_streamed".to_string(),
        "1".to_string(),
        "-reconnect_delay_max".to_string(),
        "3".to_string(),
    ];
    if !ua.is_empty() {
        args.push("-user_agent".to_string());
        args.push(ua);
    }
    args.extend([
        "-ss".to_string(),
        format!("{start_secs:.3}"),
        "-i".to_string(),
        direct_url,
        "-t".to_string(),
        format!("{dur:.3}"),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-ar".to_string(),
        "16000".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        "-y".to_string(),
        out_wav.to_string_lossy().to_string(),
    ]);

    cmd.args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let Ok(mut child) = cmd.spawn() else {
        return Ok(false);
    };
    set_active_pid(pid_slot, child.id());

    let stderr = child.stderr.take();
    let (tx, mut rx) = mpsc::channel::<String>(128);
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut reader = TokioBufReader::new(err);
            let mut buf = Vec::with_capacity(512);
            while let Ok(Some(line)) = read_next_progress_line(&mut reader, &mut buf).await {
                if !line.trim().is_empty() {
                    let _ = tx.send(line).await;
                }
            }
        });
    } else {
        drop(tx);
    }

    let mut cancel_opt = Some(cancel_rx.clone());
    let mut last_log_at = Instant::now() - Duration::from_secs(2);

    loop {
        tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_opt) => {
                if let Some(pid) = child.id() {
                    kill_process_tree(pid);
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                set_active_pid(pid_slot, None);
                let _ = fs_remove_if_exists(out_wav);
                return Err("__CANCELLED__".to_string());
            }
            maybe_line = rx.recv() => {
                let Some(line) = maybe_line else {
                    break;
                };
                if let Some(t) = parse_ffmpeg_time_secs(&line) {
                    let frac = (t / dur).clamp(0.0, 1.0);
                    let pct = 4.0 + frac * 31.0;
                    let spd = parse_ffmpeg_speed(&line).unwrap_or_else(|| "--".to_string());
                    let detail = format!("{} / {} · {}", format_hms_short(t), format_hms_short(dur), spd);
                    let log_line = if last_log_at.elapsed() >= Duration::from_millis(1400) {
                        last_log_at = Instant::now();
                        Some(format!("⬇ Audio directo: {:.0}% ({detail})", frac * 100.0))
                    } else {
                        None
                    };
                    emit_progress(
                        app,
                        last_pct,
                        "downloading_audio",
                        pct,
                        format!("Descargando tramo de audio ({:.0}%)...", frac * 100.0),
                        Some(detail),
                        log_line,
                    );
                }
            }
        }
    }

    let status = child.wait().await;
    set_active_pid(pid_slot, None);

    if cancelled.load(Ordering::SeqCst) || *cancel_rx.borrow_and_update() {
        let _ = fs_remove_if_exists(out_wav);
        return Err("__CANCELLED__".to_string());
    }

    let ok = status.map(|s| s.success()).unwrap_or(false)
        && std::fs::metadata(out_wav)
            .map(|m| m.len() > 2048)
            .unwrap_or(false);

    if ok {
        emit_progress(
            app,
            last_pct,
            "downloading_audio",
            35.0,
            "Audio del tramo listo.",
            Some(format!("{} / {} · Completado", format_hms_short(dur), format_hms_short(dur))),
            Some("✓ Tramo de audio descargado con fast-path directo.".to_string()),
        );
        Ok(true)
    } else {
        let _ = fs_remove_if_exists(out_wav);
        emit_progress(
            app,
            last_pct,
            "downloading_audio",
            4.0,
            "Cambiando a descarga inteligente con yt-dlp...",
            None,
            Some("↪ Fast-path expirado o no compatible, iniciando yt-dlp multihilo...".to_string()),
        );
        Ok(false)
    }
}

fn fs_remove_if_exists(path: &Path) -> std::io::Result<()> {
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

async fn download_audio_with_ytdlp(
    app: &AppHandle,
    ytdlp: &Path,
    bin_dir: &Path,
    temp_dir: &Path,
    audio_id: &str,
    trimmed_url: &str,
    range: Option<(f64, f64)>,
    cancelled: &Arc<AtomicBool>,
    cancel_rx: watch::Receiver<bool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
    last_pct: &Arc<Mutex<f64>>,
) -> Result<(PathBuf, Option<String>), String> {
    // First attempt: moderate fragment concurrency. If Windows (antivirus / indexing / OneDrive)
    // removes a `.part-FragN` file mid-download, retry sequentially without `.part` renames.
    let first = download_audio_with_ytdlp_mode(
        app,
        ytdlp,
        bin_dir,
        temp_dir,
        audio_id,
        trimmed_url,
        range,
        cancelled,
        cancel_rx.clone(),
        pid_slot,
        last_pct,
        false,
    )
    .await;

    match first {
        Err(err)
            if err != "__CANCELLED__"
                && !cancelled.load(Ordering::SeqCst)
                && (err.contains("No such file or directory")
                    || err.contains("Errno 2")
                    || err.contains("-Frag")
                    || err.contains(".part")) =>
        {
            cleanup_prefix_files(temp_dir, audio_id);
            emit_progress(
                app,
                last_pct,
                "downloading_audio",
                4.0,
                "Reintentando descarga en modo seguro...",
                None,
                Some("↻ Falló un fragmento temporal; reintentando secuencialmente (modo seguro).".to_string()),
            );
            download_audio_with_ytdlp_mode(
                app,
                ytdlp,
                bin_dir,
                temp_dir,
                audio_id,
                trimmed_url,
                range,
                cancelled,
                cancel_rx,
                pid_slot,
                last_pct,
                true,
            )
            .await
        }
        other => other,
    }
}

async fn download_audio_with_ytdlp_mode(
    app: &AppHandle,
    ytdlp: &Path,
    bin_dir: &Path,
    temp_dir: &Path,
    audio_id: &str,
    trimmed_url: &str,
    range: Option<(f64, f64)>,
    cancelled: &Arc<AtomicBool>,
    cancel_rx: watch::Receiver<bool>,
    pid_slot: &Arc<Mutex<Option<u32>>>,
    last_pct: &Arc<Mutex<f64>>,
    safe_mode: bool,
) -> Result<(PathBuf, Option<String>), String> {
    let audio_output_template = temp_dir.join(format!("{audio_id}.%(ext)s"));

    let mut args = vec![
        "--ffmpeg-location".to_string(),
        bin_dir.to_string_lossy().to_string(),
        "--no-playlist".to_string(),
        "--no-simulate".to_string(),
        "--print".to_string(),
        "before_dl:__CLIPGEN_TITLE__:%(title)s".to_string(),
        "--newline".to_string(),
        "--progress".to_string(),
        "--encoding".to_string(),
        "utf-8".to_string(),
        "--concurrent-fragments".to_string(),
        if safe_mode { "1".to_string() } else { "4".to_string() },
        "--buffer-size".to_string(),
        "64K".to_string(),
        "--retries".to_string(),
        "5".to_string(),
        "--fragment-retries".to_string(),
        "10".to_string(),
    ];
    if safe_mode {
        args.push("--no-part".to_string());
        args.push("--no-mtime".to_string());
    }
    args.push("-f".to_string());
    args.push("ba[protocol=https][abr<=96]/ba[protocol=https]/ba[protocol=http][abr<=96]/ba[protocol=http]/ba[abr<=96]/ba/audio_only/b[height<=480]/b".to_string());

    let range_dur = if let Some((s, e)) = range {
        let s_str = format_timestamp(s);
        let e_str = format_timestamp(e);
        args.push("--download-sections".to_string());
        args.push(format!("*{s_str}-{e_str}"));
        args.push("--downloader-args".to_string());
        args.push("ffmpeg:-stats -stats_period 0.25".to_string());
        Some((e - s).max(0.5))
    } else {
        args.push("--http-chunk-size".to_string());
        args.push("10M".to_string());
        None
    };

    args.push("-o".to_string());
    args.push(audio_output_template.to_string_lossy().to_string());
    args.push(trimmed_url.to_string());

    let mut cmd = hidden_tokio_command(ytdlp);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo iniciar yt-dlp: {e}"))?;
    set_active_pid(pid_slot, child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = mpsc::channel::<String>(256);

    if let Some(out) = stdout {
        let tx_out = tx.clone();
        tokio::spawn(async move {
            let mut reader = TokioBufReader::new(out);
            let mut buf = Vec::with_capacity(512);
            while let Ok(Some(line)) = read_next_progress_line(&mut reader, &mut buf).await {
                if !line.trim().is_empty() {
                    let _ = tx_out.send(line).await;
                }
            }
        });
    }
    if let Some(err) = stderr {
        let tx_err = tx.clone();
        tokio::spawn(async move {
            let mut reader = TokioBufReader::new(err);
            let mut buf = Vec::with_capacity(512);
            while let Ok(Some(line)) = read_next_progress_line(&mut reader, &mut buf).await {
                if !line.trim().is_empty() {
                    let _ = tx_err.send(line).await;
                }
            }
        });
    }
    drop(tx);

    let mut cancel_opt = Some(cancel_rx.clone());
    let mut last_error_lines: Vec<String> = Vec::new();
    let mut logged_pct_bucket: i32 = -10;
    let mut last_log_at = Instant::now() - Duration::from_secs(2);
    let mut seen_formats: HashSet<String> = HashSet::new();
    let mut detected_title: Option<String> = None;

    loop {
        tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_opt) => {
                if let Some(pid) = child.id() {
                    kill_process_tree(pid);
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                set_active_pid(pid_slot, None);
                tokio::time::sleep(Duration::from_millis(120)).await;
                cleanup_prefix_files(temp_dir, audio_id);
                return Err("__CANCELLED__".to_string());
            }
            maybe_line = rx.recv() => {
                let Some(line) = maybe_line else {
                    break;
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Some(raw_title) = trimmed.strip_prefix("__CLIPGEN_TITLE__:") {
                    let clean_title = raw_title.trim();
                    if !clean_title.is_empty() && clean_title != "NA" {
                        detected_title = Some(clean_title.to_string());
                    }
                    continue;
                }
                if is_ignorable_ytdlp_warning(trimmed) {
                    continue;
                }

                if trimmed.contains("ERROR:") {
                    last_error_lines.push(trimmed.to_string());
                    emit_progress(
                        app,
                        last_pct,
                        "downloading_audio",
                        2.0,
                        "Aviso descargando audio...",
                        None,
                        Some(trimmed.to_string()),
                    );
                    continue;
                }

                if trimmed.contains("Downloading 1 format(s):") || trimmed.contains("Downloading 2 format(s):") {
                    if seen_formats.insert(trimmed.to_string()) {
                        emit_progress(
                            app,
                            last_pct,
                            "downloading_audio",
                            3.0,
                            "Stream de audio localizado, iniciando descarga...",
                            None,
                            Some(format!("⚡ {trimmed}")),
                        );
                    }
                    continue;
                }

                if let Some(dest) = trimmed.strip_prefix("[download] Destination:") {
                    let base = dest.trim().split(['/', '\\']).last().unwrap_or(dest.trim());
                    emit_progress(
                        app,
                        last_pct,
                        "downloading_audio",
                        4.0,
                        "Descargando pista de audio ligera...",
                        Some(base.to_string()),
                        Some(format!("⬇ Destino temporal: {base}")),
                    );
                    continue;
                }

                if trimmed.contains("has already been downloaded") {
                    emit_progress(
                        app,
                        last_pct,
                        "downloading_audio",
                        35.0,
                        "Audio obtenido de caché.",
                        None,
                        Some("⚡ Audio ya disponible localmente.".to_string()),
                    );
                    continue;
                }

                if trimmed.contains("[download]") {
                    if let Some(caps) = re_pct().captures(trimmed) {
                        if let Ok(local_pct) = caps[1].parse::<f64>() {
                            let local = local_pct.clamp(0.0, 100.0);
                            let overall = 2.0 + (local / 100.0) * 33.0;
                            let size_s = re_size().captures(trimmed).map(|c| c[1].trim().to_string());
                            let spd_s = re_speed().captures(trimmed).map(|c| c[1].trim().to_string());
                            let eta_s = re_eta().captures(trimmed).map(|c| c[1].trim().to_string());
                            let frag_s = re_frag().captures(trimmed).map(|c| c[1].trim().to_string());

                            let mut parts: Vec<String> = Vec::new();
                            if let Some(sz) = size_s {
                                parts.push(sz);
                            }
                            if let Some(sp) = spd_s {
                                parts.push(sp);
                            }
                            if let Some(et) = eta_s {
                                parts.push(format!("ETA {et}"));
                            }
                            if let Some(fr) = frag_s {
                                parts.push(format!("frag {fr}"));
                            }
                            let detail = if parts.is_empty() { None } else { Some(parts.join(" · ")) };

                            let bucket = (local as i32) / 5 * 5;
                            let should_log = bucket >= logged_pct_bucket + 5 || last_log_at.elapsed() >= Duration::from_millis(1600);
                            let log_line = if should_log {
                                logged_pct_bucket = bucket;
                                last_log_at = Instant::now();
                                Some(match &detail {
                                    Some(d) => format!("⬇ Descarga de audio: {local:.1}% ({d})"),
                                    None => format!("⬇ Descarga de audio: {local:.1}%"),
                                })
                            } else {
                                None
                            };

                            emit_progress(
                                app,
                                last_pct,
                                "downloading_audio",
                                overall,
                                format!("Descargando audio ({local:.0}%)..."),
                                detail,
                                log_line,
                            );
                        }
                    }
                    continue;
                }

                if let Some(t) = parse_ffmpeg_time_secs(trimmed) {
                    let spd = parse_ffmpeg_speed(trimmed).unwrap_or_else(|| "--".to_string());
                    let (overall, frac_msg, detail) = if let Some(dur) = range_dur {
                        let frac = (t / dur).clamp(0.0, 1.0);
                        (
                            4.0 + frac * 31.0,
                            format!("Descargando tramo de audio ({:.0}%)...", frac * 100.0),
                            format!("{} / {} · {}", format_hms_short(t), format_hms_short(dur), spd),
                        )
                    } else {
                        (
                            18.0,
                            "Procesando descarga de audio con FFmpeg...".to_string(),
                            format!("{} · {}", format_hms_short(t), spd),
                        )
                    };
                    let log_line = if last_log_at.elapsed() >= Duration::from_millis(1500) {
                        last_log_at = Instant::now();
                        Some(format!("⬇ FFmpeg tramo: {detail}"))
                    } else {
                        None
                    };
                    emit_progress(
                        app,
                        last_pct,
                        "downloading_audio",
                        overall,
                        frac_msg,
                        Some(detail),
                        log_line,
                    );
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Error esperando yt-dlp: {e}"))?;
    set_active_pid(pid_slot, None);

    if cancelled.load(Ordering::SeqCst) {
        cleanup_prefix_files(temp_dir, audio_id);
        return Err("__CANCELLED__".to_string());
    }

    if !status.success() {
        cleanup_prefix_files(temp_dir, audio_id);
        let detail = if last_error_lines.is_empty() {
            "Código de salida distinto de cero.".to_string()
        } else {
            last_error_lines.join("\n")
        };
        return Err(format!("Error descargando audio del stream: {detail}"));
    }

    let audio_file = find_downloaded_audio(temp_dir, audio_id)
        .ok_or_else(|| "No se encontró el archivo de audio descargado.".to_string())?;

    emit_progress(
        app,
        last_pct,
        "downloading_audio",
        35.0,
        "Audio descargado correctamente.",
        audio_file
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from),
        Some("✓ Audio descargado. Iniciando análisis local con IA...".to_string()),
    );

    Ok((audio_file, detected_title))
}

#[tauri::command]
pub async fn start_transcription(
    app: AppHandle,
    url: String,
    language: Option<String>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    detect_emotions: Option<bool>,
    model_size: Option<String>,
) -> Result<TranscriptionResult, String> {
    let trimmed_url = url.trim().to_string();
    if trimmed_url.is_empty() {
        return Err("Por favor introduce una URL válida para transcribir.".to_string());
    }

    let ytdlp = ensure_ytdlp_ready()?;
    let ffmpeg = ffmpeg_binary_path();
    let bin_dir = get_binaries_dir();

    let (_run_id, cancelled, cancel_rx, pid_slot, _guard) = register_transcription_run();
    let last_pct = Arc::new(Mutex::new(0.0_f64));

    let temp_dir = std::env::temp_dir().join("clipgen_transcriptions");
    let _ = std::fs::create_dir_all(&temp_dir);
    cleanup_stale_transcription_files(&temp_dir);

    let script_path = temp_dir.join("transcribe_audio.py");
    let _ = std::fs::write(&script_path, TRANSCRIBE_SCRIPT);

    let audio_id = format!(
        "audio_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let range = match (start_time, end_time) {
        (Some(s), Some(e)) if e > s => Some((s.max(0.0), e)),
        _ => None,
    };

    emit_progress(
        &app,
        &last_pct,
        "downloading_audio",
        1.0,
        "Preparando descarga de pista de audio ligera...",
        range.map(|(s, e)| format!("Tramo {} → {}", format_hms_short(s), format_hms_short(e))),
        Some(if let Some((s, e)) = range {
            format!(
                "▶ Iniciando transcripción de tramo ({} → {})",
                format_hms_short(s),
                format_hms_short(e)
            )
        } else {
            "▶ Iniciando descarga de audio completo (formato ligero directo)".to_string()
        }),
    );

    let cached_title = get_cached_raw_video_json(&trimmed_url).and_then(|json| {
        json["title"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });

    let (audio_file, dl_title): (PathBuf, Option<String>) = if let Some((s, e)) = range {
        let fast_wav = temp_dir.join(format!("{audio_id}.wav"));
        match try_fast_range_ffmpeg_audio(
            &app,
            &ffmpeg,
            &trimmed_url,
            &fast_wav,
            s,
            e,
            &cancelled,
            cancel_rx.clone(),
            &pid_slot,
            &last_pct,
        )
        .await?
        {
            true => (fast_wav, None),
            false => {
                download_audio_with_ytdlp(
                    &app,
                    &ytdlp,
                    &bin_dir,
                    &temp_dir,
                    &audio_id,
                    &trimmed_url,
                    Some((s, e)),
                    &cancelled,
                    cancel_rx.clone(),
                    &pid_slot,
                    &last_pct,
                )
                .await?
            }
        }
    } else {
        download_audio_with_ytdlp(
            &app,
            &ytdlp,
            &bin_dir,
            &temp_dir,
            &audio_id,
            &trimmed_url,
            None,
            &cancelled,
            cancel_rx.clone(),
            &pid_slot,
            &last_pct,
        )
        .await?
    };

    if cancelled.load(Ordering::SeqCst) {
        cleanup_prefix_files(&temp_dir, &audio_id);
        return Err("__CANCELLED__".to_string());
    }

    let (py_bin, py_args) = find_python_interpreter();
    let app_clone = app.clone();
    let audio_file_clone = audio_file.clone();
    let script_path_clone = script_path.clone();
    let ffmpeg_str = ffmpeg.to_string_lossy().to_string();
    let target_lang = language.unwrap_or_else(|| "es".to_string());
    let chosen_model = match model_size.as_deref() {
        Some("medium") => "medium".to_string(),
        Some("base") => "base".to_string(),
        _ => "small".to_string(),
    };
    let emotions_enabled = detect_emotions.unwrap_or(true);
    let time_offset = range.map(|(s, _)| s).unwrap_or(0.0);
    let cancelled_clone = Arc::clone(&cancelled);
    let pid_slot_clone = Arc::clone(&pid_slot);
    let last_pct_clone = Arc::clone(&last_pct);

    let py_result = tokio::task::spawn_blocking(move || -> Result<TranscriptionResult, String> {
        let mut cmd = hidden_std_command(Path::new(&py_bin));
        for arg in &py_args {
            cmd.arg(arg);
        }
        cmd.arg(&script_path_clone);
        cmd.args([
            "--audio",
            &audio_file_clone.to_string_lossy(),
            "--language",
            &target_lang,
            "--model",
            &chosen_model,
            "--ffmpeg",
            &ffmpeg_str,
            "--time-offset",
            &format!("{time_offset:.3}"),
            if emotions_enabled {
                "--detect-emotions"
            } else {
                "--no-detect-emotions"
            },
        ]);
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.env("PYTHONUTF8", "1");
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("No se pudo iniciar Python ({py_bin}): {e}"))?;
        set_active_pid(&pid_slot_clone, Some(child.id()));

        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;

        let stderr_handle = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut lines = Vec::new();
            for l in reader.lines().flatten() {
                lines.push(l);
            }
            lines.join("\n")
        });

        let reader = BufReader::new(stdout);
        let mut final_result: Option<TranscriptionResult> = None;

        for line in reader.lines().flatten() {
            if cancelled_clone.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if val["type"] == "progress" {
                    let stage = val["stage"].as_str().unwrap_or("transcribing");
                    let percent = val["percent"].as_f64().unwrap_or(35.0);
                    let message = val["message"].as_str().unwrap_or("");
                    let detail = val["detail"].as_str().map(String::from);
                    let log_line = val["log_line"].as_str().map(String::from);
                    emit_progress(
                        &app_clone,
                        &last_pct_clone,
                        stage,
                        percent,
                        message,
                        detail,
                        log_line,
                    );
                } else if val["type"] == "result" {
                    let device = val["device"].as_str().unwrap_or("cpu").to_string();
                    let duration = val["duration"].as_f64().unwrap_or(0.0);
                    let formatted_text = val["formatted_text"].as_str().unwrap_or("").to_string();
                    let mut segments = Vec::new();
                    if let Some(arr) = val["segments"].as_array() {
                        for s in arr {
                            let events = s["events"]
                                .as_array()
                                .map(|ev_arr| {
                                    ev_arr
                                        .iter()
                                        .filter_map(|e| e.as_str().map(String::from))
                                        .collect()
                                })
                                .unwrap_or_default();
                            segments.push(TranscriptionSegment {
                                start: s["start"].as_i64().unwrap_or(0),
                                end: s["end"].as_i64().unwrap_or(0),
                                is_peak: s["is_peak"].as_bool().unwrap_or(false),
                                emotion: s["emotion"].as_str().map(String::from),
                                events,
                                text: s["text"].as_str().unwrap_or("").to_string(),
                            });
                        }
                    }
                    final_result = Some(TranscriptionResult {
                        url: String::new(),
                        video_title: None,
                        duration,
                        device,
                        segments,
                        formatted_text,
                    });
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        set_active_pid(&pid_slot_clone, None);
        let stderr_logs = stderr_handle.join().unwrap_or_default();

        if cancelled_clone.load(Ordering::SeqCst) {
            return Err("__CANCELLED__".to_string());
        }

        if !status.success() {
            let msg = if stderr_logs.trim().is_empty() {
                "El proceso de transcripción finalizó con error desconocido.".to_string()
            } else {
                format!("El proceso de transcripción falló:\n{}", stderr_logs.trim())
            };
            return Err(msg);
        }

        final_result.ok_or_else(|| {
            if !stderr_logs.trim().is_empty() {
                format!(
                    "No se recibieron resultados de la transcripción. Logs:\n{}",
                    stderr_logs.trim()
                )
            } else {
                "No se recibieron resultados de la transcripción.".to_string()
            }
        })
    })
    .await
    .map_err(|e| format!("Error en tarea de transcripción: {e}"))?;

    cleanup_prefix_files(&temp_dir, &audio_id);

    let mut complete_res = py_result?;
    complete_res.url = trimmed_url;
    complete_res.video_title = dl_title.or(cached_title);

    emit_progress(
        &app,
        &last_pct,
        "completed",
        100.0,
        "¡Transcripción y análisis emocional completados!",
        Some(format!("{} segmentos listos", complete_res.segments.len())),
        Some(format!(
            "🎉 Transcripción lista ({} segmentos en {}).",
            complete_res.segments.len(),
            complete_res.device.to_uppercase()
        )),
    );

    Ok(complete_res)
}

#[tauri::command]
pub async fn save_transcription_txt(
    content: String,
    default_filename: Option<String>,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    let raw_name = default_filename.unwrap_or_default();
    let stem = raw_name
        .trim()
        .strip_suffix(".txt")
        .or_else(|| raw_name.trim().strip_suffix(".TXT"))
        .unwrap_or(raw_name.trim());
    let clean_stem = sanitize_filename(stem);
    let final_name = if clean_stem.is_empty() {
        "transcripcion_stream.txt".to_string()
    } else {
        format!("{clean_stem}.txt")
    };

    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Guardar transcripción como .txt")
        .set_file_name(&final_name)
        .add_filter("Archivo de texto (.txt)", &["txt"]);

    let initial_dir = default_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| dirs::download_dir().filter(|p| p.is_dir()));

    if let Some(dir) = initial_dir {
        dialog = dialog.set_directory(dir);
    }

    let Some(file_handle) = dialog.save_file().await else {
        return Ok(None);
    };

    let mut save_path = file_handle.path().to_path_buf();
    if save_path.extension().is_none() {
        let mut os = save_path.into_os_string();
        os.push(".txt");
        save_path = PathBuf::from(os);
    }

    std::fs::write(&save_path, content.as_bytes())
        .map_err(|e| format!("No se pudo guardar el archivo .txt: {e}"))?;

    Ok(Some(save_path.to_string_lossy().to_string()))
}
