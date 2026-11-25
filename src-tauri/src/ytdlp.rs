use std::collections::{BTreeSet, HashMap};
use std::net::{Ipv6Addr, SocketAddr};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use regex::Regex;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, OnceCell, RwLock};
use uuid::Uuid;

use crate::binary_manager::{
    ffmpeg_binary_path, ffprobe_binary_path, get_binaries_dir, hidden_std_command,
    hidden_tokio_command, ytdlp_binary_path,
};
use crate::models::{
    split_shell_args, AudioTrackOption, JobProgressEvent, ManualDownloadOptions, VideoChapter,
    VideoFormatOption, VideoMetadata,
};

static RE_PERCENT: OnceLock<Regex> = OnceLock::new();
static RE_SPEED: OnceLock<Regex> = OnceLock::new();
static RE_ETA: OnceLock<Regex> = OnceLock::new();
static RE_SIZE: OnceLock<Regex> = OnceLock::new();
static RE_FRAG: OnceLock<Regex> = OnceLock::new();
static RE_FFMPEG_TIME: OnceLock<Regex> = OnceLock::new();
static RE_FFMPEG_SPEED: OnceLock<Regex> = OnceLock::new();

const MAX_AUDIO_CACHE: u64 = 64 * 1024 * 1024;
const MAX_VIDEO_PRECACHE: u64 = 12 * 1024 * 1024;
const MAX_CACHED_CHUNKS_PER_STREAM: usize = 32; // 32 * 4 MB = 128 MB max per stream
const RAW_JSON_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const RAW_JSON_CACHE_MAX_ENTRIES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwVideoEncoder {
    NvidiaNvenc,
    AmdAmf,
    CpuSoftware,
}

static HW_VIDEO_ENCODER: OnceLock<HwVideoEncoder> = OnceLock::new();
static RAW_VIDEO_JSON_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();

fn raw_json_cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    RAW_VIDEO_JSON_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Caches parsed yt-dlp `-J` JSON metadata under multiple keys (URL, webpage_url, id)
/// so subsequent clip exports skip re-running `yt-dlp -J`.
pub fn cache_raw_video_json(keys: &[String], val: Value) {
    if let Ok(mut map) = raw_json_cache().lock() {
        let now = Instant::now();
        map.retain(|_, (ts, _)| now.saturating_duration_since(*ts) < RAW_JSON_CACHE_TTL);
        if map.len() >= RAW_JSON_CACHE_MAX_ENTRIES {
            map.clear();
        }
        for key in keys {
            let k = key.trim();
            if !k.is_empty() {
                map.insert(k.to_string(), (now, val.clone()));
            }
        }
    }
}

/// Returns fresh cached yt-dlp JSON metadata for a video URL or ID if present and unexpired.
pub fn get_cached_raw_video_json(url_or_id: &str) -> Option<Value> {
    let key = url_or_id.trim();
    if key.is_empty() {
        return None;
    }
    let mut map = raw_json_cache().lock().ok()?;
    let now = Instant::now();
    if let Some((ts, val)) = map.get(key) {
        if now.saturating_duration_since(*ts) < RAW_JSON_CACHE_TTL {
            return Some(val.clone());
        }
        map.remove(key);
    }
    None
}

/// Removes a cached yt-dlp JSON entry (or clears the cache if keys are cross-indexed)
/// so the next `fetch_raw_video_json` call fetches fresh signed URLs from YouTube.
pub fn invalidate_cached_raw_video_json(url_or_id: &str) {
    let key = url_or_id.trim();
    if let Ok(mut map) = raw_json_cache().lock() {
        if key.is_empty() || map.remove(key).is_none() {
            map.clear();
        }
    }
}

fn probe_ffmpeg_hw_encoder(ffmpeg: &Path, encoder_args: &[&str]) -> bool {
    let mut args = vec![
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=256x256:d=0.1",
        "-frames:v",
        "1",
    ];
    args.extend_from_slice(encoder_args);
    args.extend_from_slice(&["-f", "null", "-"]);

    hidden_std_command(ffmpeg)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Probes FFmpeg once to detect working NVIDIA NVENC or AMD AMF hardware H.264 encoders.
pub fn detect_hw_video_encoder() -> HwVideoEncoder {
    let ffmpeg = ffmpeg_binary_path();
    if !ffmpeg.exists() {
        return HwVideoEncoder::CpuSoftware;
    }
    *HW_VIDEO_ENCODER.get_or_init(|| {
        if probe_ffmpeg_hw_encoder(
            &ffmpeg,
            &[
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p4",
                "-cq",
                "19",
                "-pix_fmt",
                "yuv420p",
            ],
        ) {
            return HwVideoEncoder::NvidiaNvenc;
        }
        if probe_ffmpeg_hw_encoder(
            &ffmpeg,
            &[
                "-c:v",
                "h264_amf",
                "-quality",
                "balanced",
                "-rc",
                "cqp",
                "-qp_i",
                "19",
                "-qp_p",
                "19",
                "-pix_fmt",
                "yuv420p",
            ],
        ) {
            return HwVideoEncoder::AmdAmf;
        }
        HwVideoEncoder::CpuSoftware
    })
}

/// Returns a concise human-readable label for the selected H.264 encoder backend.
pub fn hw_encoder_display_name(encoder: HwVideoEncoder) -> &'static str {
    match encoder {
        HwVideoEncoder::NvidiaNvenc => "NVIDIA NVENC",
        HwVideoEncoder::AmdAmf => "AMD AMF",
        HwVideoEncoder::CpuSoftware => "CPU (libx264)",
    }
}

/// Appends FFmpeg H.264 encoder arguments tuned for NVIDIA NVENC, AMD AMF, or CPU libx264.
pub fn append_h264_encoder_args(args: &mut Vec<String>, encoder: HwVideoEncoder) {
    match encoder {
        HwVideoEncoder::NvidiaNvenc => {
            args.extend([
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p4".to_string(),
                "-tune".to_string(),
                "hq".to_string(),
                "-rc".to_string(),
                "vbr".to_string(),
                "-cq".to_string(),
                "19".to_string(),
                "-b:v".to_string(),
                "0".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
        HwVideoEncoder::AmdAmf => {
            args.extend([
                "-c:v".to_string(),
                "h264_amf".to_string(),
                "-quality".to_string(),
                "balanced".to_string(),
                "-rc".to_string(),
                "cqp".to_string(),
                "-qp_i".to_string(),
                "19".to_string(),
                "-qp_p".to_string(),
                "19".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
        HwVideoEncoder::CpuSoftware => {
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "veryfast".to_string(),
                "-crf".to_string(),
                "18".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
    }
}

#[derive(Clone)]
struct StreamEntry {
    url: String,
    user_agent: String,
    content_type: String,
    is_audio: bool,
    precache_started: Arc<AtomicBool>,
    cached_bytes: Arc<OnceCell<Arc<Vec<u8>>>>,
    total_size: Arc<OnceCell<u64>>,
    chunks: Arc<RwLock<HashMap<u64, Arc<Vec<u8>>>>>,
}

#[derive(Clone)]
struct DashHlsEntry {
    fragments: Vec<String>,
    user_agent: String,
    is_audio: bool,
    duration_secs: f64,
    init_bytes: Arc<OnceCell<Arc<Vec<u8>>>>,
}

static STREAM_REGISTRY: OnceLock<RwLock<HashMap<String, StreamEntry>>> = OnceLock::new();
static DASH_HLS_REGISTRY: OnceLock<RwLock<HashMap<String, DashHlsEntry>>> = OnceLock::new();
static PROXY_PORT: OnceCell<u16> = OnceCell::const_new();
static PROXY_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PRECACHE_GENERATION: AtomicU64 = AtomicU64::new(0);

fn stream_registry() -> &'static RwLock<HashMap<String, StreamEntry>> {
    STREAM_REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

fn dash_hls_registry() -> &'static RwLock<HashMap<String, DashHlsEntry>> {
    DASH_HLS_REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

fn proxy_http_client() -> &'static reqwest::Client {
    PROXY_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(20))
            .tcp_keepalive(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .build()
            .expect("Failed to build proxy reqwest client")
    })
}

async fn ensure_proxy_server() -> Result<u16, String> {
    let port = PROXY_PORT
        .get_or_try_init(|| async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| format!("No se pudo iniciar proxy local de video: {e}"))?;
            let bound_port = listener
                .local_addr()
                .map_err(|e| format!("Error obteniendo puerto del proxy: {e}"))?
                .port();

            tokio::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((socket, _)) => {
                            tokio::spawn(async move {
                                handle_proxy_connection(socket).await;
                            });
                        }
                        Err(_) => break,
                    }
                }
            });

            // Also bind IPv6 loopback on the same port if available so `http://localhost:{port}`
            // never stalls waiting for Happy Eyeballs fallback in WebView2 on Windows.
            if let Ok(listener_v6) =
                TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, bound_port))).await
            {
                tokio::spawn(async move {
                    loop {
                        match listener_v6.accept().await {
                            Ok((socket, _)) => {
                                tokio::spawn(async move {
                                    handle_proxy_connection(socket).await;
                                });
                            }
                            Err(_) => break,
                        }
                    }
                });
            }

            Ok::<u16, String>(bound_port)
        })
        .await?;
    Ok(*port)
}

async fn write_simple_http_error(socket: &mut TcpStream, code: u16, reason: &str) {
    let resp = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    let _ = socket.write_all(resp.as_bytes()).await;
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.trim().as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = match pair[0] {
            b'0'..=b'9' => pair[0] - b'0',
            b'a'..=b'f' => pair[0] - b'a' + 10,
            b'A'..=b'F' => pair[0] - b'A' + 10,
            _ => return None,
        };
        let lo = match pair[1] {
            b'0'..=b'9' => pair[1] - b'0',
            b'a'..=b'f' => pair[1] - b'a' + 10,
            b'A'..=b'F' => pair[1] - b'A' + 10,
            _ => return None,
        };
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn rewrite_hls_reference(reference: &str, base: Option<&reqwest::Url>, proxy_prefix: &str) -> String {
    let resolved_opt = base
        .and_then(|b| b.join(reference).ok())
        .or_else(|| reqwest::Url::parse(reference).ok());
    let (resolved_str, is_m3u8) = match resolved_opt {
        Some(url) => {
            let m3u8 = url.path().to_ascii_lowercase().ends_with(".m3u8");
            (url.to_string(), m3u8)
        }
        None => {
            let path_part = reference.split(['?', '#']).next().unwrap_or(reference);
            let m3u8 = path_part.to_ascii_lowercase().ends_with(".m3u8");
            (reference.to_string(), m3u8)
        }
    };
    let endpoint = if is_m3u8 { "sub.m3u8" } else { "seg.ts" };
    let hex = hex_encode(resolved_str.as_bytes());
    format!("{proxy_prefix}/{endpoint}?u={hex}")
}

fn rewrite_hls_tag_uris(line: &str, base: Option<&reqwest::Url>, proxy_prefix: &str) -> String {
    if !line.starts_with("#EXT-X-") || !line.contains("URI=\"") {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + 64);
    let mut rest = line;
    while let Some(pos) = rest.find("URI=\"") {
        out.push_str(&rest[..pos + 5]);
        let after = &rest[pos + 5..];
        if let Some(end_quote) = after.find('"') {
            let raw_uri = &after[..end_quote];
            if raw_uri.is_empty() {
                out.push('"');
            } else {
                out.push_str(&rewrite_hls_reference(raw_uri, base, proxy_prefix));
                out.push('"');
            }
            rest = &after[end_quote + 1..];
        } else {
            out.push_str(after);
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

pub fn rewrite_hls_playlist(playlist: &str, base_url: &str, proxy_prefix: &str) -> String {
    let base = reqwest::Url::parse(base_url).ok();
    let mut out = Vec::new();
    for raw_line in playlist.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            out.push(String::new());
        } else if trimmed.starts_with('#') {
            out.push(rewrite_hls_tag_uris(trimmed, base.as_ref(), proxy_prefix));
        } else {
            out.push(rewrite_hls_reference(trimmed, base.as_ref(), proxy_prefix));
        }
    }
    let mut joined = out.join("\n");
    if playlist.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

fn extract_query_param<'a>(query: Option<&'a str>, name: &str) -> Option<&'a str> {
    query?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k == name {
            Some(v)
        } else {
            None
        }
    })
}

async fn handle_hls_proxy_request(
    socket: &mut TcpStream,
    method: &str,
    hls_rest: &str,
    raw_query: Option<&str>,
    host_header: Option<&str>,
    range_header: Option<&str>,
) {
    let Some((stream_id, action)) = hls_rest.split_once('/') else {
        write_simple_http_error(socket, 404, "Not Found").await;
        return;
    };
    if stream_id.is_empty() {
        write_simple_http_error(socket, 404, "Not Found").await;
        return;
    }

    let entry = {
        let reg = stream_registry().read().await;
        reg.get(stream_id).cloned()
    };
    let Some(entry) = entry else {
        write_simple_http_error(socket, 404, "Stream Expired").await;
        return;
    };

    let target_url = match action {
        "index.m3u8" => entry.url.clone(),
        "sub.m3u8" | "seg.ts" => {
            let Some(hex_u) = extract_query_param(raw_query, "u") else {
                write_simple_http_error(socket, 400, "Missing URL Parameter").await;
                return;
            };
            let Some(decoded) = hex_decode(hex_u) else {
                write_simple_http_error(socket, 400, "Invalid Hex URL").await;
                return;
            };
            let Ok(url_str) = String::from_utf8(decoded) else {
                write_simple_http_error(socket, 400, "Invalid UTF-8 URL").await;
                return;
            };
            url_str
        }
        _ => {
            write_simple_http_error(socket, 404, "Not Found").await;
            return;
        }
    };

    let client = proxy_http_client();
    if action == "index.m3u8" || action == "sub.m3u8" {
        let Ok(resp) = client
            .get(&target_url)
            .header("User-Agent", &entry.user_agent)
            .send()
            .await
        else {
            write_simple_http_error(socket, 502, "Bad Gateway").await;
            return;
        };

        let status = resp.status();
        if !status.is_success() {
            write_simple_http_error(
                socket,
                status.as_u16(),
                status.canonical_reason().unwrap_or("Upstream Error"),
            )
            .await;
            return;
        }

        let final_url = resp.url().to_string();
        let Ok(body_text) = resp.text().await else {
            write_simple_http_error(socket, 502, "Bad Gateway").await;
            return;
        };

        let proxy_prefix = if let Some(host) = host_header {
            format!("http://{host}/hls/{stream_id}")
        } else if let Some(&port) = PROXY_PORT.get() {
            let host = if entry.is_audio { "localhost" } else { "127.0.0.1" };
            format!("http://{host}:{port}/hls/{stream_id}")
        } else {
            format!("/hls/{stream_id}")
        };

        let rewritten = rewrite_hls_playlist(&body_text, &final_url, &proxy_prefix);
        let bytes = rewritten.as_bytes();
        let header_out = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            bytes.len()
        );
        if socket.write_all(header_out.as_bytes()).await.is_err() {
            return;
        }
        if !method.eq_ignore_ascii_case("HEAD") {
            let _ = socket.write_all(bytes).await;
        }
        return;
    }

    // `seg.ts` (video/audio segment, init map, or decryption key)
    let mut req = client
        .get(&target_url)
        .header("User-Agent", &entry.user_agent);
    if let Some(r) = range_header {
        req = req.header("Range", r);
    }
    let Ok(resp) = req.send().await else {
        write_simple_http_error(socket, 502, "Bad Gateway").await;
        return;
    };
    let content_type = extract_content_type(&resp, "video/mp2t");
    send_fallback_passthrough(resp, socket, &content_type).await;
}

fn iter_mp4_boxes(data: &[u8]) -> Vec<(&[u8; 4], &[u8])> {
    let mut boxes = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size32 = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let box_type: &[u8; 4] = <&[u8; 4]>::try_from(&data[pos + 4..pos + 8]).unwrap();
        let size: usize = if size32 == 1 {
            if pos + 16 > data.len() {
                break;
            }
            let sz64 = u64::from_be_bytes([
                data[pos + 8],
                data[pos + 9],
                data[pos + 10],
                data[pos + 11],
                data[pos + 12],
                data[pos + 13],
                data[pos + 14],
                data[pos + 15],
            ]);
            usize::try_from(sz64).unwrap_or(data.len())
        } else if size32 == 0 {
            data.len() - pos
        } else {
            size32 as usize
        };
        if size < 8 || pos + size > data.len() {
            break;
        }
        boxes.push((box_type, &data[pos..pos + size]));
        pos += size;
    }
    boxes
}

/// Extracts `[ftyp][moov]` initialization segment from a self-contained DASH fragment.
pub fn extract_mp4_init_segment(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for (box_type, slice) in iter_mp4_boxes(data) {
        if box_type == b"ftyp" || box_type == b"moov" {
            out.extend_from_slice(slice);
        } else if box_type == b"moof" || box_type == b"mdat" {
            break;
        }
    }
    if out.is_empty() {
        data.to_vec()
    } else {
        out
    }
}

/// Extracts media fragment boxes (`styp`/`sidx`/`moof`/`mdat`, stripping duplicate `ftyp`/`moov`/`emsg`)
/// so MSE/hls.js can append any DASH segment cleanly.
pub fn extract_mp4_media_segment(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut seen_moof = false;
    for (box_type, slice) in iter_mp4_boxes(data) {
        if box_type == b"ftyp" || box_type == b"moov" || box_type == b"emsg" {
            continue;
        }
        if box_type == b"moof" {
            seen_moof = true;
        }
        if seen_moof || box_type == b"styp" || box_type == b"sidx" || box_type == b"prft" {
            out.extend_from_slice(slice);
        }
    }
    if out.is_empty() {
        data.to_vec()
    } else {
        out
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SidxSegment {
    pub start_time: f64,
    pub duration: f64,
    pub byte_offset: u64,
    pub byte_size: u64,
}

/// Parses ISO-BMFF `ftyp` + `moov` init header and the `sidx` (Segment Index) table from the
/// leading bytes of an on-demand DASH MP4/M4A stream.
/// If `sidx` extends past `buf.len()`, returns `Some((init_bytes, Vec::new(), Some(needed_len)))`.
pub fn parse_mp4_init_and_sidx(buf: &[u8]) -> Option<(Vec<u8>, Vec<SidxSegment>, Option<usize>)> {
    let mut pos = 0usize;
    let mut init_bytes = Vec::new();

    while pos + 8 <= buf.len() {
        let sz32 = u32::from_be_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as usize;
        let tag = &buf[pos + 4..pos + 8];
        let (box_len, hdr_len) = if sz32 == 1 {
            if pos + 16 > buf.len() {
                break;
            }
            let sz64 = u64::from_be_bytes([
                buf[pos + 8],
                buf[pos + 9],
                buf[pos + 10],
                buf[pos + 11],
                buf[pos + 12],
                buf[pos + 13],
                buf[pos + 14],
                buf[pos + 15],
            ]) as usize;
            (sz64, 16usize)
        } else if sz32 == 0 {
            (buf.len() - pos, 8usize)
        } else {
            (sz32, 8usize)
        };

        if box_len < hdr_len {
            break;
        }

        if tag == b"ftyp" || tag == b"moov" {
            if pos + box_len > buf.len() {
                return Some((init_bytes, Vec::new(), Some(pos + box_len)));
            }
            init_bytes.extend_from_slice(&buf[pos..pos + box_len]);
        } else if tag == b"sidx" {
            if pos + box_len > buf.len() {
                return Some((init_bytes, Vec::new(), Some(pos + box_len)));
            }
            let sidx = &buf[pos..pos + box_len];
            if sidx.len() < hdr_len + 24 {
                return None;
            }
            let version = sidx[hdr_len];
            let timescale = u32::from_be_bytes([
                sidx[hdr_len + 8],
                sidx[hdr_len + 9],
                sidx[hdr_len + 10],
                sidx[hdr_len + 11],
            ]);
            if timescale == 0 {
                return None;
            }
            let (earliest_pts, first_offset, mut p) = if version == 0 {
                let ept = u32::from_be_bytes([
                    sidx[hdr_len + 12],
                    sidx[hdr_len + 13],
                    sidx[hdr_len + 14],
                    sidx[hdr_len + 15],
                ]) as u64;
                let foff = u32::from_be_bytes([
                    sidx[hdr_len + 16],
                    sidx[hdr_len + 17],
                    sidx[hdr_len + 18],
                    sidx[hdr_len + 19],
                ]) as u64;
                (ept, foff, hdr_len + 20)
            } else {
                if sidx.len() < hdr_len + 32 {
                    return None;
                }
                let ept = u64::from_be_bytes([
                    sidx[hdr_len + 12],
                    sidx[hdr_len + 13],
                    sidx[hdr_len + 14],
                    sidx[hdr_len + 15],
                    sidx[hdr_len + 16],
                    sidx[hdr_len + 17],
                    sidx[hdr_len + 18],
                    sidx[hdr_len + 19],
                ]);
                let foff = u64::from_be_bytes([
                    sidx[hdr_len + 20],
                    sidx[hdr_len + 21],
                    sidx[hdr_len + 22],
                    sidx[hdr_len + 23],
                    sidx[hdr_len + 24],
                    sidx[hdr_len + 25],
                    sidx[hdr_len + 26],
                    sidx[hdr_len + 27],
                ]);
                (ept, foff, hdr_len + 28)
            };

            if p + 4 > sidx.len() {
                return None;
            }
            let ref_count = u16::from_be_bytes([sidx[p + 2], sidx[p + 3]]) as usize;
            p += 4;

            let mut cur_off = (pos + box_len) as u64 + first_offset;
            let mut cur_t = earliest_pts as f64 / timescale as f64;
            let mut segs = Vec::with_capacity(ref_count);

            for _ in 0..ref_count {
                if p + 12 > sidx.len() {
                    break;
                }
                let w0 = u32::from_be_bytes([sidx[p], sidx[p + 1], sidx[p + 2], sidx[p + 3]]);
                let ref_size = (w0 & 0x7FFF_FFFF) as u64;
                let dur_ticks =
                    u32::from_be_bytes([sidx[p + 4], sidx[p + 5], sidx[p + 6], sidx[p + 7]]);
                let d_sec = dur_ticks as f64 / timescale as f64;
                if ref_size > 0 && d_sec > 0.0 {
                    segs.push(SidxSegment {
                        start_time: cur_t,
                        duration: d_sec,
                        byte_offset: cur_off,
                        byte_size: ref_size,
                    });
                }
                cur_t += d_sec;
                cur_off += ref_size;
                p += 12;
            }

            if init_bytes.is_empty() || segs.is_empty() {
                return None;
            }
            return Some((init_bytes, segs, None));
        } else if pos + box_len > buf.len() {
            break;
        }

        pos += box_len;
    }

    None
}

/// Builds a VOD fMP4 HLS playlist over a sequence of DASH fragment indices.
pub fn build_dash_hls_playlist(
    num_frags: usize,
    duration_secs: f64,
    proxy_prefix: &str,
) -> String {
    let safe_frags = num_frags.max(1);
    let total_dur = if duration_secs.is_finite() && duration_secs > 0.0 {
        duration_secs
    } else {
        safe_frags as f64 * 2.0
    };
    let frag_dur = (total_dur / safe_frags as f64).clamp(0.5, 10.0);
    let target_dur = (frag_dur.ceil() as u64).max(2);

    let mut out = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target_dur}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"{proxy_prefix}/init.mp4\"\n"
    );
    for idx in 0..safe_frags {
        out.push_str(&format!("#EXTINF:{frag_dur:.3},\n{proxy_prefix}/seg_{idx}.m4s\n"));
    }
    out.push_str("#EXT-X-ENDLIST\n");
    out
}

async fn send_binary_cors_response(
    socket: &mut TcpStream,
    method: &str,
    content_type: &str,
    bytes: &[u8],
) {
    let header_out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        bytes.len()
    );
    if socket.write_all(header_out.as_bytes()).await.is_err() {
        return;
    }
    if !method.eq_ignore_ascii_case("HEAD") {
        let _ = socket.write_all(bytes).await;
    }
}

async fn handle_dash_hls_proxy_request(
    socket: &mut TcpStream,
    method: &str,
    rest: &str,
    host_header: Option<&str>,
) {
    let Some((stream_id, action)) = rest.split_once('/') else {
        write_simple_http_error(socket, 404, "Not Found").await;
        return;
    };
    if stream_id.is_empty() {
        write_simple_http_error(socket, 404, "Not Found").await;
        return;
    }

    let entry = {
        let reg = dash_hls_registry().read().await;
        reg.get(stream_id).cloned()
    };
    let Some(entry) = entry else {
        write_simple_http_error(socket, 404, "Stream Expired").await;
        return;
    };

    if action == "index.m3u8" {
        let proxy_prefix = if let Some(host) = host_header {
            format!("http://{host}/dash-hls/{stream_id}")
        } else if let Some(&port) = PROXY_PORT.get() {
            let host = if entry.is_audio { "localhost" } else { "127.0.0.1" };
            format!("http://{host}:{port}/dash-hls/{stream_id}")
        } else {
            format!("/dash-hls/{stream_id}")
        };
        let playlist = build_dash_hls_playlist(
            entry.fragments.len(),
            entry.duration_secs,
            &proxy_prefix,
        );
        send_binary_cors_response(
            socket,
            method,
            "application/vnd.apple.mpegurl",
            playlist.as_bytes(),
        )
        .await;
        return;
    }

    let client = proxy_http_client();

    if action == "init.mp4" {
        if let Some(cached) = entry.init_bytes.get() {
            let ct = if entry.is_audio { "audio/mp4" } else { "video/mp4" };
            send_binary_cors_response(socket, method, ct, cached).await;
            return;
        }
        let Some(first_url) = entry.fragments.first() else {
            write_simple_http_error(socket, 404, "Empty Fragments").await;
            return;
        };
        let Ok(resp) = client
            .get(first_url)
            .header("User-Agent", &entry.user_agent)
            .send()
            .await
        else {
            write_simple_http_error(socket, 502, "Bad Gateway").await;
            return;
        };
        if !resp.status().is_success() {
            write_simple_http_error(socket, resp.status().as_u16(), "Upstream Error").await;
            return;
        }
        let Ok(raw) = resp.bytes().await else {
            write_simple_http_error(socket, 502, "Bad Gateway").await;
            return;
        };
        let init = Arc::new(extract_mp4_init_segment(&raw));
        let _ = entry.init_bytes.set(Arc::clone(&init));
        let ct = if entry.is_audio { "audio/mp4" } else { "video/mp4" };
        send_binary_cors_response(socket, method, ct, &init).await;
        return;
    }

    if let Some(idx_str) = action.strip_prefix("seg_").and_then(|s| s.strip_suffix(".m4s")) {
        let Ok(idx) = idx_str.parse::<usize>() else {
            write_simple_http_error(socket, 400, "Invalid Segment Index").await;
            return;
        };
        let Some(seg_url) = entry.fragments.get(idx) else {
            write_simple_http_error(socket, 404, "Segment Out of Range").await;
            return;
        };
        let Ok(resp) = client
            .get(seg_url)
            .header("User-Agent", &entry.user_agent)
            .send()
            .await
        else {
            write_simple_http_error(socket, 502, "Bad Gateway").await;
            return;
        };
        if !resp.status().is_success() {
            write_simple_http_error(socket, resp.status().as_u16(), "Upstream Error").await;
            return;
        }
        let Ok(raw) = resp.bytes().await else {
            write_simple_http_error(socket, 502, "Bad Gateway").await;
            return;
        };
        let media = extract_mp4_media_segment(&raw);
        let ct = if entry.is_audio {
            "audio/mp4"
        } else {
            "video/iso.segment"
        };
        send_binary_cors_response(socket, method, ct, &media).await;
        return;
    }

    write_simple_http_error(socket, 404, "Not Found").await;
}

async fn handle_proxy_connection(mut socket: TcpStream) {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 2048];

    loop {
        match socket.read(&mut tmp).await {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                    break;
                }
            }
            Err(_) => return,
        }
    }

    let req_text = String::from_utf8_lossy(&buf);
    let mut lines = req_text.lines();
    let request_line = match lines.next() {
        Some(l) => l.trim(),
        None => return,
    };

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("");

    if method.eq_ignore_ascii_case("OPTIONS") {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\nConnection: close\r\n\r\n";
        let _ = socket.write_all(resp.as_bytes()).await;
        return;
    }

    if !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("HEAD") {
        write_simple_http_error(&mut socket, 405, "Method Not Allowed").await;
        return;
    }

    let mut range_header: Option<String> = None;
    let mut host_header: Option<String> = None;
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            } else if k.trim().eq_ignore_ascii_case("host") {
                host_header = Some(v.trim().to_string());
            }
        }
    }

    let (clean_path, raw_query) = match raw_path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (raw_path, None),
    };

    if let Some(hls_rest) = clean_path.strip_prefix("/hls/") {
        handle_hls_proxy_request(
            &mut socket,
            method,
            hls_rest,
            raw_query,
            host_header.as_deref(),
            range_header.as_deref(),
        )
        .await;
        return;
    }

    if let Some(dash_rest) = clean_path.strip_prefix("/dash-hls/") {
        handle_dash_hls_proxy_request(
            &mut socket,
            method,
            dash_rest,
            host_header.as_deref(),
        )
        .await;
        return;
    }

    let stream_id = match clean_path.strip_prefix("/stream/") {
        Some(id) if !id.is_empty() => id,
        _ => {
            write_simple_http_error(&mut socket, 404, "Not Found").await;
            return;
        }
    };

    let entry = {
        let reg = stream_registry().read().await;
        reg.get(stream_id).cloned()
    };

    let entry = match entry {
        Some(e) => e,
        None => {
            write_simple_http_error(&mut socket, 404, "Stream Expired").await;
            return;
        }
    };

    spawn_stream_precache_once(&entry);

    if let Some(bytes) = entry.cached_bytes.get() {
        let total = bytes.len() as u64;
        if total > 0 {
            let (status_line, start, end) = if let Some(ref r) = range_header {
                if let Some((s, e)) = parse_byte_range(r, total) {
                    ("206 Partial Content", s, e)
                } else {
                    write_simple_http_error(&mut socket, 416, "Range Not Satisfiable").await;
                    return;
                }
            } else {
                ("200 OK", 0, total - 1)
            };
            let len = end - start + 1;
            let mut header_out = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {len}\r\n",
                entry.content_type
            );
            if range_header.is_some() {
                header_out.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
            }
            header_out.push_str("\r\n");
            if socket.write_all(header_out.as_bytes()).await.is_err() {
                return;
            }
            if !method.eq_ignore_ascii_case("HEAD") {
                if let Some(slice) = bytes.get(start as usize..=end as usize) {
                    let _ = socket.write_all(slice).await;
                }
            }
            return;
        }
    }

    let client = proxy_http_client();
    let (req_start, req_end, is_range_req) = parse_open_range(range_header.as_deref());

    if method.eq_ignore_ascii_case("HEAD") {
        if let Some(&total) = entry.total_size.get() {
            if total == 0 || req_start >= total {
                write_simple_http_error(&mut socket, 416, "Range Not Satisfiable").await;
                return;
            }
            let final_end = req_end.map(|e| e.min(total - 1)).unwrap_or(total - 1);
            let overall_len = final_end - req_start + 1;
            let header_out = build_range_response_headers(
                &entry.content_type,
                req_start,
                final_end,
                total,
                overall_len,
                is_range_req,
            );
            let _ = socket.write_all(header_out.as_bytes()).await;
            return;
        }

        let probe_res = client
            .get(&entry.url)
            .header("User-Agent", &entry.user_agent)
            .header("Range", format!("bytes={req_start}-{req_start}"))
            .send()
            .await;
        let Ok(resp) = probe_res else {
            write_simple_http_error(&mut socket, 502, "Bad Gateway").await;
            return;
        };
        let status = resp.status();
        let content_type = extract_content_type(&resp, &entry.content_type);
        let total_opt = extract_total_from_headers(&resp);
        if !status.is_success() {
            write_simple_http_error(
                &mut socket,
                status.as_u16(),
                status.canonical_reason().unwrap_or("Error"),
            )
            .await;
            return;
        }
        let header_out = if let Some(total) = total_opt {
            let _ = entry.total_size.set(total);
            if total == 0 || req_start >= total {
                write_simple_http_error(&mut socket, 416, "Range Not Satisfiable").await;
                return;
            }
            let final_end = req_end.map(|e| e.min(total - 1)).unwrap_or(total - 1);
            let overall_len = final_end - req_start + 1;
            build_range_response_headers(
                &content_type,
                req_start,
                final_end,
                total,
                overall_len,
                is_range_req,
            )
        } else {
            format!(
                "HTTP/1.1 {} {}\r\nContent-Type: {content_type}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                status.as_u16(),
                status.canonical_reason().unwrap_or("OK")
            )
        };
        let _ = socket.write_all(header_out.as_bytes()).await;
        return;
    }

    // Serve 4 MB chunks from RAM cache when available, or stream packet-by-packet from
    // YouTube CDN (at unthrottled speed) while saving complete aligned 4 MB chunks to RAM.
    let mut cur = req_start;
    let mut header_sent = false;
    let mut total_opt = entry.total_size.get().copied();
    let mut final_end = req_end.unwrap_or(u64::MAX);
    let mut content_type_out = entry.content_type.clone();

    if let Some(total) = total_opt {
        if total == 0 || req_start >= total {
            write_simple_http_error(&mut socket, 416, "Range Not Satisfiable").await;
            return;
        }
        final_end = req_end.map(|e| e.min(total - 1)).unwrap_or(total - 1);
    }

    let mut consecutive_failures: u32 = 0;

    while cur <= final_end {
        let chunk_idx = cur / MAX_PROXY_CHUNK;
        let chunk_start = chunk_idx * MAX_PROXY_CHUNK;
        let cached_hit = {
            let guard = entry.chunks.read().await;
            guard.get(&chunk_idx).cloned()
        };

        if let (Some(cached_chunk), Some(total)) = (cached_hit, total_opt) {
            if !header_sent {
                let overall_len = final_end - req_start + 1;
                let header_out = build_range_response_headers(
                    &content_type_out,
                    req_start,
                    final_end,
                    total,
                    overall_len,
                    is_range_req,
                );
                if socket.write_all(header_out.as_bytes()).await.is_err() {
                    return;
                }
                header_sent = true;
            }

            let offset_in_chunk = (cur - chunk_start) as usize;
            if offset_in_chunk >= cached_chunk.len() {
                break;
            }
            let remaining = (final_end + 1 - cur) as usize;
            let to_send = (cached_chunk.len() - offset_in_chunk).min(remaining);
            if socket
                .write_all(&cached_chunk[offset_in_chunk..offset_in_chunk + to_send])
                .await
                .is_err()
            {
                return;
            }
            consecutive_failures = 0;
            cur += to_send as u64;
            continue;
        }

        let chunk_limit = (chunk_start + MAX_PROXY_CHUNK - 1).min(final_end);
        let resp = match tokio::time::timeout(
            Duration::from_secs(12),
            client
                .get(&entry.url)
                .header("User-Agent", &entry.user_agent)
                .header("Range", format!("bytes={cur}-{chunk_limit}"))
                .send(),
        )
        .await
        {
            Ok(Ok(r)) => r,
            Ok(Err(_)) | Err(_) => {
                consecutive_failures += 1;
                if consecutive_failures <= 3 {
                    tokio::time::sleep(Duration::from_millis(150 * u64::from(consecutive_failures))).await;
                    continue;
                }
                if !header_sent {
                    write_simple_http_error(&mut socket, 502, "Bad Gateway").await;
                }
                return;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                consecutive_failures += 1;
                if consecutive_failures <= 3 {
                    tokio::time::sleep(Duration::from_millis(150 * u64::from(consecutive_failures))).await;
                    continue;
                }
            }
            if !header_sent {
                write_simple_http_error(
                    &mut socket,
                    status.as_u16(),
                    status.canonical_reason().unwrap_or("Upstream Error"),
                )
                .await;
            }
            return;
        }

        content_type_out = extract_content_type(&resp, &entry.content_type);

        if total_opt.is_none() {
            let discovered_total = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|cr| cr.rsplit('/').next())
                .and_then(|s| s.trim().parse::<u64>().ok());

            if let Some(t) = discovered_total {
                let _ = entry.total_size.set(t);
                if t == 0 || req_start >= t {
                    if !header_sent {
                        write_simple_http_error(&mut socket, 416, "Range Not Satisfiable").await;
                    }
                    return;
                }
                total_opt = Some(t);
                final_end = req_end.map(|e| e.min(t - 1)).unwrap_or(t - 1);
            }
        }

        let Some(total) = total_opt else {
            // Upstream omitted Content-Range total; fallback to single pass-through
            if !header_sent {
                send_fallback_passthrough(resp, &mut socket, &content_type_out).await;
            }
            return;
        };

        if !header_sent {
            let overall_len = final_end - req_start + 1;
            let header_out = build_range_response_headers(
                &content_type_out,
                req_start,
                final_end,
                total,
                overall_len,
                is_range_req,
            );
            if socket.write_all(header_out.as_bytes()).await.is_err() {
                return;
            }
            header_sent = true;
        }

        let before = cur;
        let collect_for_cache = cur == chunk_start;
        let mut chunk_buf: Vec<u8> = if collect_for_cache {
            Vec::with_capacity((chunk_limit - chunk_start + 1).min(MAX_PROXY_CHUNK) as usize)
        } else {
            Vec::new()
        };

        let mut stream = resp.bytes_stream();
        let mut stream_err = false;
        loop {
            let next_item = match tokio::time::timeout(Duration::from_secs(12), stream.next()).await {
                Ok(item) => item,
                Err(_) => {
                    stream_err = true;
                    break;
                }
            };
            let Some(chunk_res) = next_item else {
                break;
            };
            match chunk_res {
                Ok(chunk) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    let remaining = (final_end + 1).saturating_sub(cur);
                    if remaining == 0 {
                        break;
                    }
                    let to_send = chunk.len().min(remaining as usize);
                    if socket.write_all(&chunk[..to_send]).await.is_err() {
                        return;
                    }
                    if collect_for_cache && (chunk_buf.len() + to_send) as u64 <= MAX_PROXY_CHUNK {
                        chunk_buf.extend_from_slice(&chunk[..to_send]);
                    }
                    cur += to_send as u64;
                    consecutive_failures = 0;
                }
                Err(_) => {
                    stream_err = true;
                    break;
                }
            }
        }

        if !stream_err && collect_for_cache {
            let expected_len = (total.saturating_sub(chunk_start)).min(MAX_PROXY_CHUNK);
            if chunk_buf.len() as u64 == expected_len && expected_len > 0 {
                cache_chunk(&entry, chunk_idx, chunk_buf).await;
            }
        }

        if stream_err {
            if cur > before {
                consecutive_failures = 1;
            } else {
                consecutive_failures += 1;
            }
            if consecutive_failures <= 3 {
                tokio::time::sleep(Duration::from_millis(150 * u64::from(consecutive_failures))).await;
                continue;
            }
            break;
        }
        if cur == before {
            break;
        }
        consecutive_failures = 0;
    }
}

fn build_range_response_headers(
    content_type: &str,
    req_start: u64,
    final_end: u64,
    total: u64,
    overall_len: u64,
    is_range_req: bool,
) -> String {
    let status_header = if is_range_req {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let mut header_out = format!(
        "HTTP/1.1 {status_header}\r\nContent-Type: {content_type}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {overall_len}\r\n"
    );
    if is_range_req {
        header_out.push_str(&format!(
            "Content-Range: bytes {req_start}-{final_end}/{total}\r\n"
        ));
    }
    header_out.push_str("\r\n");
    header_out
}

async fn send_fallback_passthrough(
    resp: reqwest::Response,
    socket: &mut TcpStream,
    content_type: &str,
) {
    let status = resp.status();
    let status_code = status.as_u16();
    let status_reason = status.canonical_reason().unwrap_or("OK");
    let mut header_out = format!(
        "HTTP/1.1 {status_code} {status_reason}\r\nContent-Type: {content_type}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nCache-Control: no-store\r\nConnection: close\r\n"
    );
    if let Some(len) = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
    {
        header_out.push_str(&format!("Content-Length: {len}\r\n"));
    }
    if let Some(cr) = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        header_out.push_str(&format!("Content-Range: {cr}\r\n"));
    }
    header_out.push_str("\r\n");
    if socket.write_all(header_out.as_bytes()).await.is_err() || !status.is_success() {
        return;
    }
    let mut stream = resp.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        if socket.write_all(&chunk).await.is_err() {
            break;
        }
    }
}

async fn cache_chunk(entry: &StreamEntry, chunk_idx: u64, bytes: Vec<u8>) -> Arc<Vec<u8>> {
    let mut guard = entry.chunks.write().await;
    if !guard.contains_key(&chunk_idx) && guard.len() >= MAX_CACHED_CHUNKS_PER_STREAM {
        // Evict one distant non-zero chunk while preserving chunk 0 (container header/index).
        if let Some(evict_key) = guard
            .keys()
            .copied()
            .filter(|&k| k != 0)
            .max_by_key(|&k| k.abs_diff(chunk_idx))
        {
            guard.remove(&evict_key);
        }
    }
    let arc = Arc::new(bytes);
    guard.entry(chunk_idx).or_insert_with(|| arc.clone()).clone()
}

fn extract_content_type(resp: &reqwest::Response, fallback: &str) -> String {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|ct| !ct.is_empty() && !ct.eq_ignore_ascii_case("application/octet-stream"))
        .unwrap_or(fallback)
        .to_string()
}

fn extract_total_from_headers(resp: &reqwest::Response) -> Option<u64> {
    resp.headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cr| cr.rsplit('/').next())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .or_else(|| {
            if resp.status() == reqwest::StatusCode::OK {
                resp.content_length()
            } else {
                None
            }
        })
}

const MAX_PROXY_CHUNK: u64 = 4 * 1024 * 1024;

/// Rewrites `bytes=N-` or oversized `bytes=N-M` into a bounded chunk of at most
/// `MAX_PROXY_CHUNK` bytes. Multi-range and suffix ranges pass through untouched.
#[cfg(test)]
pub fn cap_range_header(range: &str) -> String {
    let spec = range.trim();
    if let Some(rest) = spec.strip_prefix("bytes=") {
        if !rest.contains(',') {
            if let Some((s, e)) = rest.split_once('-') {
                if let Ok(start) = s.trim().parse::<u64>() {
                    let cap_end = start + MAX_PROXY_CHUNK - 1;
                    let end = e
                        .trim()
                        .parse::<u64>()
                        .ok()
                        .map(|v| v.min(cap_end))
                        .unwrap_or(cap_end);
                    return format!("bytes={start}-{end}");
                }
            }
        }
    }
    spec.to_string()
}

/// Parses an HTTP single `Range: bytes=start-[end]` header into `(start, optional_end, is_range_request)`.
pub fn parse_open_range(range: Option<&str>) -> (u64, Option<u64>, bool) {
    let Some(raw) = range else {
        return (0, None, false);
    };
    let spec = raw.trim();
    if let Some(rest) = spec.strip_prefix("bytes=") {
        if !rest.contains(',') {
            if let Some((s, e)) = rest.split_once('-') {
                if let Ok(start) = s.trim().parse::<u64>() {
                    let end = e.trim().parse::<u64>().ok().filter(|&v| v >= start);
                    return (start, end, true);
                }
            }
        }
    }
    (0, None, false)
}

/// Parses an HTTP single `Range: bytes=...` header against a known total byte size.
pub fn parse_byte_range(range: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = range.trim();
    let rest = spec.strip_prefix("bytes=")?;
    if rest.contains(',') {
        return None;
    }
    let (s, e) = rest.split_once('-')?;
    let s = s.trim();
    let e = e.trim();
    if s.is_empty() {
        let suffix = e.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some((start, total - 1));
    }
    let start = s.parse::<u64>().ok()?;
    if start >= total {
        return None;
    }
    let end = if e.is_empty() {
        total - 1
    } else {
        e.parse::<u64>().ok()?.min(total - 1)
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

fn spawn_stream_precache_once(entry: &StreamEntry) {
    if !entry.precache_started.swap(true, Ordering::SeqCst) {
        spawn_stream_precache(entry.clone());
    }
}

async fn fetch_and_cache_chunk(entry: &StreamEntry, chunk_idx: u64) -> Option<(Arc<Vec<u8>>, u64)> {
    if let (Some(cached), Some(&total)) = (
        entry.chunks.read().await.get(&chunk_idx).cloned(),
        entry.total_size.get(),
    ) {
        return Some((cached, total));
    }

    let chunk_start = chunk_idx * MAX_PROXY_CHUNK;
    if let Some(&total) = entry.total_size.get() {
        if chunk_start >= total {
            return None;
        }
    }

    let chunk_end = match entry.total_size.get() {
        Some(&total) => (chunk_start + MAX_PROXY_CHUNK - 1).min(total - 1),
        None => chunk_start + MAX_PROXY_CHUNK - 1,
    };

    let resp = tokio::time::timeout(
        Duration::from_secs(10),
        proxy_http_client()
            .get(&entry.url)
            .header("User-Agent", &entry.user_agent)
            .header("Range", format!("bytes={chunk_start}-{chunk_end}"))
            .send(),
    )
    .await
    .ok()?
    .ok()?;

    let status = resp.status();
    if !status.is_success() {
        return None;
    }

    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let total = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|cr| cr.rsplit('/').next())
            .and_then(|s| s.trim().parse::<u64>().ok())?;
        let _ = entry.total_size.set(total);
        if chunk_start >= total {
            return None;
        }
        let expected_len = (total - chunk_start).min(MAX_PROXY_CHUNK) as usize;
        let bytes = tokio::time::timeout(Duration::from_secs(15), resp.bytes())
            .await
            .ok()?
            .ok()?
            .to_vec();
        if bytes.len() != expected_len || expected_len == 0 {
            return None;
        }
        let arc = cache_chunk(entry, chunk_idx, bytes).await;
        Some((arc, total))
    } else if chunk_start == 0 {
        let bytes = tokio::time::timeout(Duration::from_secs(15), resp.bytes())
            .await
            .ok()?
            .ok()?
            .to_vec();
        let total = bytes.len() as u64;
        if total == 0 || total > MAX_PROXY_CHUNK {
            return None;
        }
        let _ = entry.total_size.set(total);
        let arc = cache_chunk(entry, chunk_idx, bytes).await;
        Some((arc, total))
    } else {
        None
    }
}

fn spawn_stream_precache(entry: StreamEntry) {
    let gen = PRECACHE_GENERATION.load(Ordering::SeqCst);
    tokio::spawn(async move {
        if entry.is_audio {
            if entry.cached_bytes.get().is_some() {
                return;
            }
            let mut full_buf: Vec<u8> = Vec::new();
            let mut chunk_idx = 0u64;
            let mut full_total: Option<u64> = None;

            while chunk_idx * MAX_PROXY_CHUNK < MAX_AUDIO_CACHE {
                if PRECACHE_GENERATION.load(Ordering::SeqCst) != gen {
                    return;
                }
                let Some((chunk, total)) = fetch_and_cache_chunk(&entry, chunk_idx).await else {
                    return;
                };
                if PRECACHE_GENERATION.load(Ordering::SeqCst) != gen {
                    return;
                }
                if total > MAX_AUDIO_CACHE {
                    return;
                }
                full_total = Some(total);
                full_buf.extend_from_slice(&chunk);
                if (full_buf.len() as u64) >= total {
                    break;
                }
                chunk_idx += 1;
            }

            if let Some(t) = full_total {
                if t > 0 && (full_buf.len() as u64) == t {
                    let _ = entry.cached_bytes.set(Arc::new(full_buf));
                }
            }
        } else {
            // Skip chunk 0 so the player's initial GET 0- streams packet-by-packet immediately,
            // while pre-warming chunks 1..N (4 MB..64 MB) into RAM ahead of playback.
            let mut chunk_idx = 1u64;
            while chunk_idx * MAX_PROXY_CHUNK < MAX_VIDEO_PRECACHE {
                if PRECACHE_GENERATION.load(Ordering::SeqCst) != gen {
                    return;
                }
                let Some((_, total)) = fetch_and_cache_chunk(&entry, chunk_idx).await else {
                    break;
                };
                if (chunk_idx + 1) * MAX_PROXY_CHUNK >= total {
                    break;
                }
                chunk_idx += 1;
            }
        }
    });
}

async fn precache_stream_by_url(proxy_url: &str) {
    if let Some(id) = proxy_url.rsplit('/').next() {
        let entry = {
            let reg = stream_registry().read().await;
            reg.get(id).cloned()
        };
        if let Some(e) = entry {
            spawn_stream_precache_once(&e);
        }
    }
}

async fn probe_stream_ok(url: &str, user_agent: &str) -> bool {
    let client = proxy_http_client();
    let res = tokio::time::timeout(
        Duration::from_secs(4),
        client
            .get(url)
            .header("User-Agent", user_agent)
            .header("Range", "bytes=0-63")
            .send(),
    )
    .await;

    match res {
        Ok(Ok(resp)) => resp.status().is_success(),
        _ => false,
    }
}

async fn insert_proxy_stream(
    url: String,
    user_agent: String,
    content_type: String,
    is_audio: bool,
) -> String {
    let id = Uuid::new_v4().to_string();
    let entry = StreamEntry {
        url,
        user_agent,
        content_type,
        is_audio,
        precache_started: Arc::new(AtomicBool::new(false)),
        cached_bytes: Arc::new(OnceCell::new()),
        total_size: Arc::new(OnceCell::new()),
        chunks: Arc::new(RwLock::new(HashMap::new())),
    };
    {
        let mut reg = stream_registry().write().await;
        if reg.len() > 300 {
            reg.clear();
        }
        reg.insert(id.clone(), entry);
    }
    id
}

async fn register_proxy_stream(
    port: u16,
    url: String,
    user_agent: String,
    content_type: String,
    is_audio: bool,
) -> String {
    let id = insert_proxy_stream(url, user_agent, content_type, is_audio).await;
    // Use `localhost` for audio and `127.0.0.1` for video so Chromium allocates
    // two independent 6-connection HTTP/1.1 pools (zero connection contention).
    let host = if is_audio { "localhost" } else { "127.0.0.1" };
    format!("http://{host}:{port}/stream/{id}")
}

async fn register_hls_proxy_stream(
    port: u16,
    url: String,
    user_agent: String,
    is_audio: bool,
) -> String {
    let id = insert_proxy_stream(
        url,
        user_agent,
        "application/vnd.apple.mpegurl".to_string(),
        is_audio,
    )
    .await;
    let host = if is_audio { "localhost" } else { "127.0.0.1" };
    format!("http://{host}:{port}/hls/{id}/index.m3u8")
}

#[derive(Clone)]
struct DashHlsCandidate {
    score: u64,
    fragments: Vec<String>,
    ua: String,
    duration_secs: f64,
    height: Option<u32>,
}

async fn register_dash_hls_proxy_stream(
    port: u16,
    fragments: Vec<String>,
    user_agent: String,
    is_audio: bool,
    duration_secs: f64,
) -> String {
    let id = Uuid::new_v4().to_string();
    let entry = DashHlsEntry {
        fragments,
        user_agent,
        is_audio,
        duration_secs,
        init_bytes: Arc::new(OnceCell::new()),
    };
    {
        let mut reg = dash_hls_registry().write().await;
        if reg.len() > 200 {
            reg.clear();
        }
        reg.insert(id.clone(), entry);
    }
    let host = if is_audio { "localhost" } else { "127.0.0.1" };
    format!("http://{host}:{port}/dash-hls/{id}/index.m3u8")
}

async fn pick_and_register_dash_hls_stream(
    port: u16,
    mut cands: Vec<DashHlsCandidate>,
    is_audio: bool,
) -> Option<String> {
    if cands.is_empty() {
        return None;
    }
    cands.sort_by(|a, b| b.score.cmp(&a.score));
    let top_n = cands.len().min(3);
    let probe_futures = cands[..top_n].iter().map(|c| {
        let first_url = c.fragments.first().map(String::as_str).unwrap_or("");
        probe_stream_ok(first_url, &c.ua)
    });
    let results = futures_util::future::join_all(probe_futures).await;
    let chosen_idx = results.iter().position(|&ok| ok).unwrap_or(0);
    let chosen = cands.swap_remove(chosen_idx);
    Some(
        register_dash_hls_proxy_stream(
            port,
            chosen.fragments,
            chosen.ua,
            is_audio,
            chosen.duration_secs,
        )
        .await,
    )
}

/// Resolves all fragment URLs from a yt-dlp JSON format entry (`url` or `fragment_base_url` + `path`).
pub fn extract_format_fragment_urls(f: &Value) -> Vec<String> {
    let Some(frags) = f["fragments"].as_array() else {
        return Vec::new();
    };
    let base = f["fragment_base_url"].as_str().unwrap_or("");
    let base_parsed = if !base.is_empty() {
        reqwest::Url::parse(base).ok()
    } else {
        None
    };

    frags
        .iter()
        .filter_map(|frag| {
            if let Some(u) = frag["url"].as_str().filter(|s| !s.is_empty()) {
                return Some(u.to_string());
            }
            if let Some(p) = frag["path"].as_str().filter(|s| !s.is_empty()) {
                if let Some(ref b) = base_parsed {
                    if let Ok(joined) = b.join(p) {
                        return Some(joined.to_string());
                    }
                }
                if !base.is_empty() {
                    return Some(format!("{base}{p}"));
                }
            }
            None
        })
        .collect()
}

fn re_percent() -> &'static Regex {
    RE_PERCENT.get_or_init(|| Regex::new(r"([0-9]+(?:\.[0-9]+)?)%").unwrap())
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

fn re_ffmpeg_time() -> &'static Regex {
    RE_FFMPEG_TIME.get_or_init(|| Regex::new(r"time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)").unwrap())
}

fn re_ffmpeg_speed() -> &'static Regex {
    RE_FFMPEG_SPEED.get_or_init(|| Regex::new(r"speed=\s*([0-9]+(?:\.[0-9]+)?x)").unwrap())
}

pub fn parse_ffmpeg_time_secs(line: &str) -> Option<f64> {
    let caps = re_ffmpeg_time().captures(line)?;
    let h: f64 = caps.get(1)?.as_str().parse().ok()?;
    let m: f64 = caps.get(2)?.as_str().parse().ok()?;
    let s: f64 = caps.get(3)?.as_str().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

pub fn parse_ffmpeg_speed(line: &str) -> Option<String> {
    re_ffmpeg_speed()
        .captures(line)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Reads the next progress line split on either `\r` or `\n` so FFmpeg/yt-dlp
/// carriage-return updates stream in real time rather than buffering until EOF.
pub async fn read_next_progress_line<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    buf: &mut Vec<u8>,
) -> std::io::Result<Option<String>> {
    buf.clear();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if buf.is_empty() {
                return Ok(None);
            }
            return Ok(Some(String::from_utf8_lossy(buf).into_owned()));
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\r' || b == b'\n') {
            let delim = available[pos];
            buf.extend_from_slice(&available[..pos]);
            let consume_len = if delim == b'\r'
                && pos + 1 < available.len()
                && available[pos + 1] == b'\n'
            {
                pos + 2
            } else {
                pos + 1
            };
            reader.consume(consume_len);
            return Ok(Some(String::from_utf8_lossy(buf).into_owned()));
        } else {
            let len = available.len();
            buf.extend_from_slice(available);
            reader.consume(len);
            if buf.len() > 32 * 1024 {
                return Ok(Some(String::from_utf8_lossy(buf).into_owned()));
            }
        }
    }
}

pub fn ensure_ytdlp_ready() -> Result<std::path::PathBuf, String> {
    let ytdlp = ytdlp_binary_path();
    if !ytdlp.exists() {
        return Err(
            "yt-dlp aún no está instalado. Espera a que termine la descarga automática en la barra superior."
                .to_string(),
        );
    }
    let ffmpeg = ffmpeg_binary_path();
    if !ffmpeg.exists() {
        return Err(
            "FFmpeg aún no está instalado. Espera a que termine la descarga automática en la barra superior."
                .to_string(),
        );
    }
    Ok(ytdlp)
}

fn language_display_name(code: &str) -> String {
    let lower = code.trim().to_lowercase();
    match lower.as_str() {
        "es-419" | "es-mx" | "es-us" => "Español (Latinoamérica)".to_string(),
        "es-es" => "Español (España)".to_string(),
        "es" => "Español".to_string(),
        "en-us" => "Inglés (EE.UU.)".to_string(),
        "en-gb" => "Inglés (Reino Unido)".to_string(),
        "en" => "Inglés".to_string(),
        "pt-br" => "Portugués (Brasil)".to_string(),
        "pt" | "pt-pt" => "Portugués".to_string(),
        "fr" | "fr-fr" | "fr-ca" => "Francés".to_string(),
        "de" | "de-de" => "Alemán".to_string(),
        "it" | "it-it" => "Italiano".to_string(),
        "ja" | "jp" => "Japonés".to_string(),
        "ko" => "Coreano".to_string(),
        "ru" => "Ruso".to_string(),
        "zh" | "zh-cn" | "zh-hans" | "zh-tw" | "zh-hant" => "Chino".to_string(),
        "hi" => "Hindi".to_string(),
        "ar" => "Árabe".to_string(),
        "pl" => "Polaco".to_string(),
        "nl" => "Neerlandés".to_string(),
        "tr" => "Turco".to_string(),
        "id" => "Indonesio".to_string(),
        "vi" => "Vietnamita".to_string(),
        "th" => "Tailandés".to_string(),
        "default" | "" => "Pista por defecto".to_string(),
        _ if lower.starts_with("es-") => format!("Español ({})", code.to_uppercase()),
        _ if lower.starts_with("en-") => format!("Inglés ({})", code.to_uppercase()),
        _ if lower.starts_with("pt-") => format!("Portugués ({})", code.to_uppercase()),
        _ => code.to_uppercase(),
    }
}

pub fn append_format_and_option_args(args: &mut Vec<String>, options: &ManualDownloadOptions) {
    append_format_and_option_args_ext(args, options, false);
}

pub fn append_format_and_option_args_ext(
    args: &mut Vec<String>,
    options: &ManualDownloadOptions,
    is_clip_section: bool,
) {
    let bin_dir = get_binaries_dir();
    args.push("--ffmpeg-location".to_string());
    args.push(bin_dir.to_string_lossy().to_string());
    args.push("--no-playlist".to_string());
    args.push("--newline".to_string());
    args.push("--progress".to_string());
    args.push("--no-warnings".to_string());
    args.extend([
        "--encoding".to_string(),
        "utf-8".to_string(),
        "--concurrent-fragments".to_string(),
        "8".to_string(),
        "--buffer-size".to_string(),
        "64K".to_string(),
    ]);
    if !is_clip_section {
        args.extend(["--http-chunk-size".to_string(), "10M".to_string()]);
    }

    let selected_audio_id = options
        .audio_format_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let selected_audio_lang = options
        .audio_track_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "default");

    match options.mode.as_str() {
        "audio_only" => {
            let selector = match (selected_audio_id, selected_audio_lang) {
                (Some(aid), Some(lang)) => {
                    format!("{aid}/bestaudio[language={lang}]/bestaudio[language^={lang}]/bestaudio/best")
                }
                (Some(aid), None) => format!("{aid}/bestaudio/best"),
                (None, Some(lang)) => {
                    format!("bestaudio[language={lang}]/bestaudio[language^={lang}]/bestaudio/best")
                }
                (None, None) => "bestaudio/best".to_string(),
            };
            args.push("-f".to_string());
            args.push(selector);
            args.push("-x".to_string());
            args.push("--audio-format".to_string());
            args.push(options.audio_format.clone());
            args.push("--audio-quality".to_string());
            args.push(options.audio_bitrate.clone());
        }
        "video_only" => {
            let selector = match options.quality_preset.as_str() {
                "custom" => options
                    .custom_video_format_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("bestvideo")
                    .to_string(),
                "best" => "bestvideo".to_string(),
                res => format!("bestvideo[height<=?{res}]"),
            };
            args.push("-f".to_string());
            args.push(selector);
            args.push("--remux-video".to_string());
            args.push(options.container.clone());
        }
        _ => {
            let combine_with_audio = |v_expr: &str, fallback: &str| -> String {
                match (selected_audio_id, selected_audio_lang) {
                    (Some(aid), Some(lang)) => format!(
                        "{v_expr}+{aid}/{v_expr}+bestaudio[language={lang}]/{v_expr}+bestaudio[language^={lang}]/{fallback}"
                    ),
                    (Some(aid), None) => format!("{v_expr}+{aid}/{fallback}"),
                    (None, Some(lang)) => format!(
                        "{v_expr}+bestaudio[language={lang}]/{v_expr}+bestaudio[language^={lang}]/{fallback}"
                    ),
                    (None, None) => fallback.to_string(),
                }
            };

            let selector = match options.quality_preset.as_str() {
                "custom" => {
                    let v = options
                        .custom_video_format_id
                        .as_deref()
                        .filter(|s| !s.is_empty());
                    let a = options
                        .custom_audio_format_id
                        .as_deref()
                        .filter(|s| !s.is_empty());
                    match (v, a) {
                        (Some(vid), Some(aid)) => format!("{vid}+{aid}/best"),
                        (Some(vid), None) => {
                            combine_with_audio(vid, &format!("{vid}+bestaudio/best"))
                        }
                        (None, Some(aid)) => format!("bestvideo+{aid}/best"),
                        (None, None) => combine_with_audio("bestvideo", "bestvideo+bestaudio/best"),
                    }
                }
                "best" => combine_with_audio("bestvideo", "bestvideo+bestaudio/best"),
                res => combine_with_audio(
                    &format!("bestvideo[height<=?{res}]"),
                    &format!("bestvideo[height<=?{res}]+bestaudio/best[height<=?{res}]"),
                ),
            };
            args.push("-f".to_string());
            args.push(selector);
            args.push("--merge-output-format".to_string());
            args.push(options.container.clone());
        }
    }

    if options.mode != "audio_only" && options.quality_preset != "custom" {
        if let Some(fps) = options.target_fps.filter(|&f| f > 0) {
            args.push("-S".to_string());
            args.push(format!("res,fps:{fps}"));
        }
    }

    if options.embed_subtitles && options.mode != "audio_only" {
        let lang = if options.subtitle_lang.trim().is_empty() {
            "es,en".to_string()
        } else {
            options.subtitle_lang.trim().to_string()
        };
        args.push("--write-subs".to_string());
        args.push("--write-auto-subs".to_string());
        args.push("--sub-langs".to_string());
        args.push(lang);
        args.push("--embed-subs".to_string());
    }

    if options.embed_thumbnail && options.container != "wav" && options.audio_format != "wav" {
        args.push("--embed-thumbnail".to_string());
    }

    if options.embed_metadata {
        args.push("--embed-metadata".to_string());
        if !is_clip_section {
            args.push("--embed-chapters".to_string());
        }
    }

    if is_clip_section {
        args.push("--downloader-args".to_string());
        args.push("ffmpeg:-stats -stats_period 0.25".to_string());
    }

    if let Some(limit) = options.rate_limit.as_deref().map(str::trim) {
        if !limit.is_empty() {
            args.push("--limit-rate".to_string());
            args.push(limit.to_string());
        }
    }

    if let Some(custom) = options.custom_args.as_deref().map(str::trim) {
        if !custom.is_empty() {
            args.extend(split_shell_args(custom));
        }
    }
}

pub fn emit_job_event(app: &AppHandle, event: JobProgressEvent) {
    let _ = app.emit("job-progress", event);
}

pub struct JobCancelEntry {
    pub cancelled: Arc<AtomicBool>,
    pub tx: watch::Sender<bool>,
    pub pid: Option<u32>,
    pub title: String,
}

static ACTIVE_JOBS: OnceLock<Mutex<HashMap<String, JobCancelEntry>>> = OnceLock::new();

fn active_jobs() -> &'static Mutex<HashMap<String, JobCancelEntry>> {
    ACTIVE_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_job(job_id: &str, title: &str) -> (Arc<AtomicBool>, watch::Receiver<bool>) {
    let cancelled = Arc::new(AtomicBool::new(false));
    let (tx, rx) = watch::channel(false);
    if let Ok(mut map) = active_jobs().lock() {
        map.insert(
            job_id.to_string(),
            JobCancelEntry {
                cancelled: Arc::clone(&cancelled),
                tx,
                pid: None,
                title: title.to_string(),
            },
        );
    }
    (cancelled, rx)
}

pub fn subscribe_job_cancel(job_id: &str) -> Option<watch::Receiver<bool>> {
    active_jobs()
        .lock()
        .ok()
        .and_then(|map| map.get(job_id).map(|e| e.tx.subscribe()))
}

pub fn set_job_pid(job_id: &str, pid: Option<u32>) {
    if let Ok(mut map) = active_jobs().lock() {
        if let Some(entry) = map.get_mut(job_id) {
            entry.pid = pid;
        }
    }
}

pub fn is_job_cancelled(job_id: &str) -> bool {
    active_jobs()
        .lock()
        .ok()
        .and_then(|map| map.get(job_id).map(|e| e.cancelled.load(Ordering::SeqCst)))
        .unwrap_or(false)
}

pub fn unregister_job(job_id: &str) {
    if let Ok(mut map) = active_jobs().lock() {
        map.remove(job_id);
    }
}

pub fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = hidden_std_command(Path::new("taskkill"))
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hidden_std_command(Path::new("kill"))
            .args(["-9", &pid.to_string()])
            .output();
    }
}

pub async fn wait_for_cancel(cancel_rx: &mut Option<watch::Receiver<bool>>) {
    match cancel_rx.as_mut() {
        Some(crx) => {
            if crx.wait_for(|v| *v).await.is_err() {
                std::future::pending::<()>().await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

#[tauri::command]
pub async fn cancel_job(app: AppHandle, job_id: String) -> Result<(), String> {
    let (pid, title) = {
        let mut map = active_jobs()
            .lock()
            .map_err(|_| "No se pudo acceder al registro de trabajos activos.".to_string())?;
        let Some(entry) = map.get_mut(&job_id) else {
            return Ok(());
        };
        entry.cancelled.store(true, Ordering::SeqCst);
        let _ = entry.tx.send(true);
        (entry.pid.take(), entry.title.clone())
    };

    if let Some(p) = pid {
        kill_process_tree(p);
    }

    emit_job_event(
        &app,
        JobProgressEvent {
            job_id,
            title,
            status: "cancelled".to_string(),
            percent: 0.0,
            clip_percent: None,
            clip_index: None,
            clip_total: None,
            clip_name: None,
            speed: "--".to_string(),
            eta: "--".to_string(),
            current_step: "Descarga cancelada por el usuario".to_string(),
            output_files: vec![],
            log_line: Some("⛔ Descarga cancelada por el usuario.".to_string()),
        },
    );

    Ok(())
}

pub fn parse_ffprobe_fps(rate_str: &str) -> Option<f64> {
    let trimmed = rate_str.trim();
    if trimmed.is_empty() || trimmed == "N/A" || trimmed == "0/0" {
        return None;
    }
    if let Some((num_s, den_s)) = trimmed.split_once('/') {
        let num: f64 = num_s.trim().parse().ok()?;
        let den: f64 = den_s.trim().parse().ok()?;
        if den > 0.0 && num > 0.0 {
            return Some(num / den);
        }
        return None;
    }
    let val: f64 = trimmed.parse().ok()?;
    if val > 0.0 {
        Some(val)
    } else {
        None
    }
}

pub async fn ensure_file_target_fps(
    app: &AppHandle,
    job_id: &str,
    title: &str,
    file_path: &Path,
    target_fps: u32,
    base_percent: f64,
    percent_span: f64,
    clip_base_percent: f64,
    clip_percent_span: f64,
    clip_index: Option<usize>,
    clip_total: Option<usize>,
    clip_name: Option<&str>,
    duration_hint_secs: Option<f64>,
) -> Result<(), String> {
    if is_job_cancelled(job_id) {
        return Err("__CANCELLED__".to_string());
    }
    if !file_path.exists() {
        return Ok(());
    }

    let ffprobe = ffprobe_binary_path();
    let ffmpeg = ffmpeg_binary_path();
    if !ffmpeg.exists() {
        return Err("FFmpeg no está disponible para convertir los FPS.".to_string());
    }

    let mut detected_fps: Option<f64> = None;
    let mut probed_duration: Option<f64> = None;

    if ffprobe.exists() {
        if let Ok(out) = hidden_tokio_command(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=avg_frame_rate,r_frame_rate",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1",
                &file_path.to_string_lossy(),
            ])
            .output()
            .await
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let mut avg_fps = None;
                let mut r_fps = None;
                for line in text.lines() {
                    let line = line.trim();
                    if let Some(v) = line.strip_prefix("avg_frame_rate=") {
                        avg_fps = parse_ffprobe_fps(v);
                    } else if let Some(v) = line.strip_prefix("r_frame_rate=") {
                        r_fps = parse_ffprobe_fps(v);
                    } else if let Some(v) = line.strip_prefix("duration=") {
                        if let Ok(d) = v.trim().parse::<f64>() {
                            if d.is_finite() && d > 0.0 {
                                probed_duration = Some(d);
                            }
                        }
                    }
                }
                detected_fps = avg_fps.or(r_fps);
            }
        }
    }

    if let Some(fps_val) = detected_fps {
        if (fps_val - target_fps as f64).abs() <= 0.6 {
            let final_pct = base_percent + percent_span;
            let final_clip_pct = (clip_base_percent + clip_percent_span).clamp(0.0, 100.0);
            emit_job_event(
                app,
                JobProgressEvent {
                    job_id: job_id.to_string(),
                    title: title.to_string(),
                    status: "downloading".to_string(),
                    percent: final_pct,
                    clip_percent: Some(final_clip_pct),
                    clip_index,
                    clip_total,
                    clip_name: clip_name.map(str::to_string),
                    speed: "--".to_string(),
                    eta: "00:00".to_string(),
                    current_step: format!("FPS nativo ya coincide ({fps_val:.1} fps)"),
                    output_files: vec![],
                    log_line: Some(format!(
                        "⚡ Stream ya coincide con {target_fps} FPS ({fps_val:.2} fps), sin re-codificación necesaria."
                    )),
                },
            );
            return Ok(());
        }
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_lowercase();
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let tmp_path = parent.join(format!("{stem}.fps_tmp_{target_fps}.{ext}"));

    let initial_hw = if ext == "webm" {
        HwVideoEncoder::CpuSoftware
    } else {
        detect_hw_video_encoder()
    };
    let accel_label = if ext == "webm" {
        "VP9"
    } else {
        hw_encoder_display_name(initial_hw)
    };

    let step_msg = format!("Convirtiendo video a {target_fps} FPS con FFmpeg ({accel_label})...");
    emit_job_event(
        app,
        JobProgressEvent {
            job_id: job_id.to_string(),
            title: title.to_string(),
            status: "downloading".to_string(),
            percent: base_percent,
            clip_percent: Some(clip_base_percent),
            clip_index,
            clip_total,
            clip_name: clip_name.map(str::to_string),
            speed: "--".to_string(),
            eta: "--".to_string(),
            current_step: step_msg.clone(),
            output_files: vec![],
            log_line: Some(format!(
                "⚙ Convirtiendo a {target_fps} FPS con FFmpeg ({accel_label})..."
            )),
        },
    );

    let attempts: Vec<HwVideoEncoder> = if initial_hw != HwVideoEncoder::CpuSoftware {
        vec![initial_hw, HwVideoEncoder::CpuSoftware]
    } else {
        vec![HwVideoEncoder::CpuSoftware]
    };
    let mut last_err = String::new();

    for (attempt_idx, hw_enc) in attempts.into_iter().enumerate() {
        if attempt_idx > 0 {
            emit_job_event(
                app,
                JobProgressEvent {
                    job_id: job_id.to_string(),
                    title: title.to_string(),
                    status: "downloading".to_string(),
                    percent: base_percent,
                    clip_percent: Some(clip_base_percent),
                    clip_index,
                    clip_total,
                    clip_name: clip_name.map(str::to_string),
                    speed: "--".to_string(),
                    eta: "--".to_string(),
                    current_step: format!(
                        "Reintentando conversión a {target_fps} FPS en CPU (libx264)..."
                    ),
                    output_files: vec![],
                    log_line: Some(
                        "⚠ Aceleración GPU falló en este clip, cambiando a CPU (libx264)..."
                            .to_string(),
                    ),
                },
            );
        }

        let mut ff_args = vec![
            "-y".to_string(),
            "-stats_period".to_string(),
            "0.25".to_string(),
        ];
        if ext != "webm" && hw_enc != HwVideoEncoder::CpuSoftware {
            ff_args.extend(["-hwaccel".to_string(), "auto".to_string()]);
        }
        ff_args.extend([
            "-i".to_string(),
            file_path.to_string_lossy().to_string(),
            "-vf".to_string(),
            format!("fps={target_fps}"),
        ]);

        if ext == "webm" {
            ff_args.extend([
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
                "copy".to_string(),
            ]);
        } else {
            append_h264_encoder_args(&mut ff_args, hw_enc);
            ff_args.extend(["-c:a".to_string(), "copy".to_string()]);
            if ext == "mp4" || ext == "mov" {
                ff_args.extend(["-movflags".to_string(), "+faststart".to_string()]);
            }
        }
        ff_args.push(tmp_path.to_string_lossy().to_string());

        let mut cmd = hidden_tokio_command(&ffmpeg);
        cmd.args(&ff_args)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar FFmpeg para cambiar FPS: {e}"))?;
        set_job_pid(job_id, child.id());

        let stderr = child.stderr.take();
        let (tx, mut rx) = mpsc::channel::<String>(128);
        if let Some(err) = stderr {
            tokio::spawn(async move {
                let mut reader = BufReader::new(err);
                let mut buf = Vec::with_capacity(512);
                while let Ok(Some(line)) = read_next_progress_line(&mut reader, &mut buf).await {
                    if !line.trim().is_empty() {
                        let _ = tx.send(line).await;
                    }
                }
            });
        }

        let mut cancel_rx = subscribe_job_cancel(job_id);
        let total_dur = probed_duration.or(duration_hint_secs).unwrap_or(0.0);
        let started_at = Instant::now();
        let mut last_error_lines: Vec<String> = Vec::new();

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
                    let _ = std::fs::remove_file(&tmp_path);
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
                    if trimmed.contains("Error") || trimmed.contains("Invalid") {
                        last_error_lines.push(trimmed.to_string());
                    }
                    if let Some(elapsed) = parse_ffmpeg_time_secs(trimmed) {
                        let (local_frac, eta_str, detail) = if total_dur > 0.0 {
                            let frac = (elapsed / total_dur).clamp(0.0, 0.99);
                            let eta_secs = if frac > 0.02 {
                                let wall = started_at.elapsed().as_secs_f64();
                                ((wall / frac) - wall).max(0.0).round() as u64
                            } else {
                                0
                            };
                            let eta_fmt = if frac > 0.02 {
                                format!("{:02}:{:02}", eta_secs / 60, eta_secs % 60)
                            } else {
                                "--".to_string()
                            };
                            (
                                frac,
                                eta_fmt,
                                format!("Convirtiendo a {target_fps} FPS ({:.1}%)...", frac * 100.0),
                            )
                        } else {
                            (
                                0.5,
                                "--".to_string(),
                                format!("Convirtiendo a {target_fps} FPS ({elapsed:.1}s)..."),
                            )
                        };
                        let overall_pct = base_percent + local_frac * percent_span;
                        let clip_pct = (clip_base_percent + local_frac * clip_percent_span).clamp(0.0, 100.0);
                        let speed = parse_ffmpeg_speed(trimmed).unwrap_or_else(|| "--".to_string());
                        emit_job_event(
                            app,
                            JobProgressEvent {
                                job_id: job_id.to_string(),
                                title: title.to_string(),
                                status: "downloading".to_string(),
                                percent: overall_pct,
                                clip_percent: Some(clip_pct),
                                clip_index,
                                clip_total,
                                clip_name: clip_name.map(str::to_string),
                                speed,
                                eta: eta_str,
                                current_step: detail,
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
            .map_err(|e| format!("Error esperando FFmpeg FPS: {e}"))?;
        set_job_pid(job_id, None);

        if is_job_cancelled(job_id) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err("__CANCELLED__".to_string());
        }

        if status.success() && tmp_path.exists() {
            last_err.clear();
            break;
        }

        let _ = std::fs::remove_file(&tmp_path);
        last_err = if last_error_lines.is_empty() {
            format!("FFmpeg falló al convertir a {target_fps} FPS.")
        } else {
            last_error_lines.join(" | ")
        };
    }

    if !last_err.is_empty() {
        return Err(last_err);
    }

    if let Err(rename_err) = std::fs::rename(&tmp_path, file_path) {
        std::fs::copy(&tmp_path, file_path)
            .map_err(|e| format!("No se pudo guardar archivo con {target_fps} FPS ({rename_err}): {e}"))?;
        let _ = std::fs::remove_file(&tmp_path);
    }

    emit_job_event(
        app,
        JobProgressEvent {
            job_id: job_id.to_string(),
            title: title.to_string(),
            status: "downloading".to_string(),
            percent: base_percent + percent_span,
            clip_percent: Some((clip_base_percent + clip_percent_span).clamp(0.0, 100.0)),
            clip_index,
            clip_total,
            clip_name: clip_name.map(str::to_string),
            speed: "--".to_string(),
            eta: "00:00".to_string(),
            current_step: format!("Conversión a {target_fps} FPS completada"),
            output_files: vec![],
            log_line: Some(format!("✓ Video ajustado a {target_fps} FPS.")),
        },
    );

    Ok(())
}

pub struct YtdlpRunConfig<'a> {
    pub app: &'a AppHandle,
    pub job_id: &'a str,
    pub title: &'a str,
    pub args: Vec<String>,
    pub base_percent: f64,
    pub percent_span: f64,
    pub clip_percent_base: f64,
    pub clip_percent_span: f64,
    pub step_label: &'a str,
    pub clip_duration_secs: Option<f64>,
    pub clip_index: Option<usize>,
    pub clip_total: Option<usize>,
    pub clip_name: Option<&'a str>,
}

/// Runs `yt-dlp` and streams progress updates to the frontend, returning captured output file paths.
pub async fn run_ytdlp_with_progress(cfg: YtdlpRunConfig<'_>) -> Result<Vec<String>, String> {
    if is_job_cancelled(cfg.job_id) {
        return Err("__CANCELLED__".to_string());
    }

    let ytdlp = ensure_ytdlp_ready()?;

    let mut cmd = hidden_tokio_command(&ytdlp);
    cmd.args(crate::binary_manager::js_runtime_args())
        .args(&cfg.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo iniciar yt-dlp: {e}"))?;
    set_job_pid(cfg.job_id, child.id());

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx, mut rx) = mpsc::channel::<String>(256);

    if let Some(out) = stdout {
        let tx_out = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(out);
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
            let mut reader = BufReader::new(err);
            let mut buf = Vec::with_capacity(512);
            while let Ok(Some(line)) = read_next_progress_line(&mut reader, &mut buf).await {
                if !line.trim().is_empty() {
                    let _ = tx_err.send(line).await;
                }
            }
        });
    }

    drop(tx);

    let mut cancel_rx = subscribe_job_cancel(cfg.job_id);
    let mut output_files = Vec::new();
    let mut touched_paths: Vec<std::path::PathBuf> = Vec::new();
    let mut last_error_lines: Vec<String> = Vec::new();
    let mut current_speed = String::from("--");
    let mut current_eta = String::from("--");
    let mut current_step = cfg.step_label.to_string();
    let mut current_pct = cfg.base_percent;
    let mut current_clip_pct = cfg.clip_percent_base;
    let mut last_progress_log_pct: i32 = -1;

    loop {
        tokio::select! {
            biased;
            _ = wait_for_cancel(&mut cancel_rx) => {
                if let Some(pid) = child.id() {
                    kill_process_tree(pid);
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                set_job_pid(cfg.job_id, None);
                tokio::time::sleep(Duration::from_millis(120)).await;
                for p in &touched_paths {
                    let _ = std::fs::remove_file(p);
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        let part = p.with_file_name(format!("{name}.part"));
                        let ytdl = p.with_file_name(format!("{name}.ytdl"));
                        let _ = std::fs::remove_file(&part);
                        let _ = std::fs::remove_file(&ytdl);
                    }
                }
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

                // Filtro estricto: suprimir avisos de JS Runtime (Deno, QuickJS, EJS) que confunden al usuario
                if is_ignorable_ytdlp_warning(trimmed) {
                    continue;
                }

                if let Some(path_str) = trimmed.strip_prefix("__CLIPGEN_FILE__:") {
                    let cleaned = path_str.trim().to_string();
                    if !cleaned.is_empty() && !output_files.contains(&cleaned) {
                        output_files.push(cleaned);
                    }
                    continue;
                }

                if trimmed.contains("ERROR:") {
                    last_error_lines.push(trimmed.to_string());
                }

                let mut user_log_line: Option<String> = None;

                if trimmed.contains("[Merger]") {
                    current_step = "Combinando video y audio con FFmpeg...".to_string();
                    user_log_line = Some("⚙ Combinando video y audio con FFmpeg...".to_string());
                } else if trimmed.contains("[ExtractAudio]") {
                    current_step = "Extrayendo y convirtiendo pista de audio...".to_string();
                    user_log_line = Some("🎵 Extrayendo y convirtiendo audio...".to_string());
                } else if trimmed.contains("[EmbedThumbnail]") {
                    current_step = "Incrustando miniatura en el archivo...".to_string();
                    user_log_line = Some("🖼 Incrustando miniatura...".to_string());
                } else if trimmed.contains("[Metadata]") {
                    current_step = "Escribiendo metadatos y capítulos...".to_string();
                    user_log_line = Some("📝 Escribiendo metadatos y capítulos...".to_string());
                } else if let Some(dest_raw) = trimmed.strip_prefix("[download] Destination:") {
                    let dest_path_str = dest_raw.trim();
                    if !dest_path_str.is_empty() {
                        touched_paths.push(std::path::PathBuf::from(dest_path_str));
                    }
                    let base = dest_path_str.split(['/', '\\']).last().unwrap_or(dest_path_str);
                    current_step = format!("Descargando stream: {base}");
                    user_log_line = Some(format!("⬇ Descargando stream: {base}"));
                } else if trimmed.contains("has already been downloaded") {
                    current_step = "Stream ya descargado en caché local".to_string();
                    user_log_line = Some("⚡ Stream obtenido de caché".to_string());
                } else if let Some(caps) = re_percent().captures(trimmed) {
                    let mut pct_val = 0.0;
                    if let Ok(local_pct) = caps[1].parse::<f64>() {
                        pct_val = local_pct.clamp(0.0, 100.0);
                        current_clip_pct = (cfg.clip_percent_base + (pct_val / 100.0) * cfg.clip_percent_span).clamp(0.0, 100.0);
                        current_pct = cfg.base_percent + (pct_val / 100.0) * cfg.percent_span;
                    }
                    if let Some(scaps) = re_speed().captures(trimmed) {
                        current_speed = scaps[1].to_string();
                    }
                    if let Some(ecaps) = re_eta().captures(trimmed) {
                        current_eta = ecaps[1].to_string();
                    }

                    let size_str = re_size().captures(trimmed).map(|c| c[1].trim().to_string());
                    let frag_str = re_frag().captures(trimmed).map(|c| c[1].trim().to_string());

                    let mut detail = format!("Descarga: {pct_val:.1}%");
                    if let Some(ref sz) = size_str {
                        detail.push_str(&format!(" de {sz}"));
                    }
                    if let Some(ref fr) = frag_str {
                        detail.push_str(&format!(" (frag {fr})"));
                    }
                    if current_speed != "--" {
                        detail.push_str(&format!(" a {current_speed}"));
                    }
                    if current_eta != "--" {
                        detail.push_str(&format!(" • ETA {current_eta}"));
                    }
                    current_step = detail.clone();

                    // Emitir logs en hitos clave (inicio, cuartos y 100%) para mantener el historial limpio y ordenado
                    let rounded_quarter = ((pct_val / 25.0).floor() as i32) * 25;
                    if pct_val >= 99.9 {
                        if last_progress_log_pct != 100 {
                            last_progress_log_pct = 100;
                            user_log_line = Some(format!("⬇ {detail}"));
                        }
                    } else if rounded_quarter > last_progress_log_pct && rounded_quarter > 0 {
                        last_progress_log_pct = rounded_quarter;
                        user_log_line = Some(format!("⬇ {detail}"));
                    }
                } else if let Some(elapsed) = parse_ffmpeg_time_secs(trimmed) {
                    if let Some(sp) = parse_ffmpeg_speed(trimmed) {
                        current_speed = sp;
                    }
                    if let Some(dur) = cfg.clip_duration_secs {
                        if dur > 0.0 {
                            let local_pct = ((elapsed / dur) * 100.0).clamp(0.0, 99.0);
                            current_clip_pct = (cfg.clip_percent_base + (local_pct / 100.0) * cfg.clip_percent_span).clamp(0.0, 100.0);
                            current_pct = cfg.base_percent + (local_pct / 100.0) * cfg.percent_span;
                            current_step = format!("Ajustando corte con FFmpeg ({elapsed:.1}s / {dur:.1}s)...");
                            if let Some(speed_num) = current_speed
                                .strip_suffix('x')
                                .and_then(|s| s.parse::<f64>().ok())
                                .filter(|&x| x > 0.01)
                            {
                                let rem = ((dur - elapsed).max(0.0) / speed_num).round() as u64;
                                current_eta = format!("{:02}:{:02}", rem / 60, rem % 60);
                            }
                        } else {
                            current_step = format!("Procesando con FFmpeg ({elapsed:.1}s)...");
                        }
                    } else {
                        current_step = format!("Procesando con FFmpeg ({elapsed:.1}s)...");
                    }
                } else if trimmed.starts_with("ERROR:") {
                    user_log_line = Some(trimmed.to_string());
                } else if !trimmed.starts_with("[download]") && !trimmed.starts_with("frame=") {
                    user_log_line = Some(trimmed.to_string());
                }

                emit_job_event(
                    cfg.app,
                    JobProgressEvent {
                        job_id: cfg.job_id.to_string(),
                        title: cfg.title.to_string(),
                        status: "downloading".to_string(),
                        percent: current_pct,
                        clip_percent: Some(current_clip_pct),
                        clip_index: cfg.clip_index,
                        clip_total: cfg.clip_total,
                        clip_name: cfg.clip_name.map(str::to_string),
                        speed: current_speed.clone(),
                        eta: current_eta.clone(),
                        current_step: current_step.clone(),
                        output_files: output_files.clone(),
                        log_line: user_log_line,
                    },
                );
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Error esperando finalización de yt-dlp: {e}"))?;
    set_job_pid(cfg.job_id, None);

    if is_job_cancelled(cfg.job_id) {
        return Err("__CANCELLED__".to_string());
    }

    if !status.success() {
        let details = if last_error_lines.is_empty() {
            format!("yt-dlp finalizó con código {:?}", status.code())
        } else {
            last_error_lines.join(" | ")
        };
        return Err(details);
    }

    Ok(output_files)
}

#[derive(Clone)]
struct StreamCandidate {
    score: u64,
    url: String,
    ua: String,
    content_type: String,
    height: Option<u32>,
    is_hls: bool,
    is_av1: bool,
}

fn trim_url_wrappers(s: &str) -> &str {
    s.trim_matches(|c: char| {
        matches!(c, '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | ',' | ';')
    })
}

pub fn sanitize_input_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    for token in trimmed.split_whitespace() {
        let cleaned = trim_url_wrappers(token);
        if cleaned.starts_with("http://") || cleaned.starts_with("https://") {
            return cleaned.to_string();
        }
    }
    trim_url_wrappers(trimmed).to_string()
}

pub fn parse_ytdlp_json_stdout(stdout: &[u8]) -> Result<Value, String> {
    if let Ok(val) = serde_json::from_slice::<Value>(stdout) {
        if val.is_object() {
            return Ok(val);
        }
    }
    let text = String::from_utf8_lossy(stdout);
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                if val.is_object() {
                    return Ok(val);
                }
            }
        }
    }
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
        if end > start {
            if let Ok(val) = serde_json::from_str::<Value>(&text[start..=end]) {
                if val.is_object() {
                    return Ok(val);
                }
            }
        }
    }
    Err("Error leyendo metadatos JSON de yt-dlp: la respuesta no contiene un objeto JSON válido.".to_string())
}

pub fn extract_friendly_ytdlp_error(stderr: &str) -> String {
    let error_line = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && l.to_ascii_lowercase().starts_with("error:"))
        .or_else(|| {
            stderr.lines().rev().map(str::trim).find(|l| {
                !l.is_empty()
                    && !l.starts_with("Traceback")
                    && !l.starts_with("File \"")
                    && !l.starts_with("WARNING:")
            })
        })
        .unwrap_or("No se pudo analizar la URL.");

    let cleaned = error_line
        .strip_prefix("ERROR:")
        .or_else(|| error_line.strip_prefix("error:"))
        .unwrap_or(error_line)
        .trim();

    let lower = cleaned.to_ascii_lowercase();
    if lower.contains("sign in to confirm you") || lower.contains("not a bot") {
        return "YouTube solicitó verificación antibot/sesión para este video. Abre YouTube en tu navegador habitual para validar tu sesión o red, e inténtalo de nuevo.".to_string();
    }
    if lower.contains("private video") {
        return "Este video es privado y no puede cargarse sin acceso autorizado.".to_string();
    }
    if lower.contains("video unavailable") || lower.contains("has been removed") || lower.contains("no longer available") {
        return "El video no está disponible o fue eliminado de la plataforma.".to_string();
    }
    if lower.contains("age") && (lower.contains("sign in") || lower.contains("confirm your age")) {
        return "Este video tiene restricción de edad y requiere autenticación en la plataforma.".to_string();
    }
    if lower.contains("premieres in") || lower.contains("live event will begin") {
        return "Este estreno o directo programado aún no ha comenzado.".to_string();
    }
    if lower.contains("unsupported url") {
        return "La URL introducida no corresponde a un enlace de video compatible.".to_string();
    }
    if lower.contains("getaddrinfo") || lower.contains("timed out") || lower.contains("unable to download webpage") || lower.contains("connection") {
        return format!("Error de conexión al consultar el video ({cleaned}). Verifica tu internet e inténtalo de nuevo.");
    }
    if lower.contains("signature") || lower.contains("nsig") || lower.contains("unable to extract") || lower.contains("js challenge") {
        return format!("El extractor de yt-dlp necesita actualizarse para este video ({cleaned}). Abre Ajustes → Motores y pulsa Actualizar.");
    }

    cleaned.to_string()
}

fn select_best_resolution_candidates<'a>(
    mp4_cands: &'a [StreamCandidate],
    webm_cands: &'a [StreamCandidate],
    height: u32,
) -> (Option<&'a StreamCandidate>, Option<&'a StreamCandidate>) {
    // Primary playback stream preference for WebView2:
    // 1. Direct HTTPS MP4 non-AV1 (H.264 avc1 / VP9 in MP4)
    // 2. Direct HTTPS WebM VP9 (crucial for 1440p/2160p where MP4 only has AV1 or HLS)
    // 3. Direct HTTPS MP4 AV1
    // 4. HLS MP4
    let best_mp4 = mp4_cands
        .iter()
        .filter(|c| c.height == Some(height) && !c.is_hls && !c.is_av1)
        .max_by_key(|c| c.score)
        .or_else(|| {
            webm_cands
                .iter()
                .filter(|c| c.height == Some(height) && !c.is_hls && !c.is_av1)
                .max_by_key(|c| c.score)
        })
        .or_else(|| {
            mp4_cands
                .iter()
                .filter(|c| c.height == Some(height) && !c.is_hls)
                .max_by_key(|c| c.score)
        })
        .or_else(|| {
            mp4_cands
                .iter()
                .filter(|c| c.height == Some(height))
                .max_by_key(|c| (!c.is_av1, c.score))
        });

    let best_webm = webm_cands
        .iter()
        .filter(|c| c.height == Some(height) && !c.is_hls && !c.is_av1)
        .max_by_key(|c| c.score)
        .or_else(|| {
            webm_cands
                .iter()
                .filter(|c| c.height == Some(height) && !c.is_hls)
                .max_by_key(|c| c.score)
        })
        .or_else(|| {
            webm_cands
                .iter()
                .filter(|c| c.height == Some(height))
                .max_by_key(|c| (!c.is_av1, c.score))
        });

    (best_mp4, best_webm)
}

async fn register_candidate_stream(
    proxy_port: u16,
    cand: &StreamCandidate,
    is_audio: bool,
) -> String {
    if cand.is_hls {
        register_hls_proxy_stream(proxy_port, cand.url.clone(), cand.ua.clone(), is_audio).await
    } else {
        register_proxy_stream(
            proxy_port,
            cand.url.clone(),
            cand.ua.clone(),
            cand.content_type.clone(),
            is_audio,
        )
        .await
    }
}

fn compute_preview_video_score(
    ext: &str,
    vcodec: &str,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    tbr: Option<f64>,
) -> u64 {
    let h = height.unwrap_or(0);
    let short_side = match (width, height) {
        (Some(w), Some(hh)) if w > 0 && hh > 0 => w.min(hh) as u64,
        _ => h as u64,
    };

    let res_bonus = if short_side > 0 && short_side <= 720 {
        50_000 + short_side
    } else if short_side > 720 && short_side <= 1080 {
        20_000 + (1080 - short_side)
    } else {
        5_000
    };

    let smooth_bonus = if fps.unwrap_or(30.0) <= 35.0 && tbr.unwrap_or(500.0) <= 1200.0 {
        100
    } else {
        0
    };

    let codec_bonus = if ext == "mp4" {
        if vcodec.starts_with("avc1") {
            100_000
        } else {
            0
        }
    } else if vcodec.starts_with("vp9") || vcodec.starts_with("vp09") {
        100_000
    } else {
        0
    };

    codec_bonus + res_bonus + smooth_bonus
}

async fn pick_best_candidate(mut cands: Vec<StreamCandidate>) -> Option<StreamCandidate> {
    if cands.is_empty() {
        return None;
    }
    cands.sort_by(|a, b| b.score.cmp(&a.score));
    let top_n = cands.len().min(3);
    let probe_futures = cands[..top_n]
        .iter()
        .map(|c| probe_stream_ok(&c.url, &c.ua));
    let results = futures_util::future::join_all(probe_futures).await;
    let chosen_idx = results.iter().position(|&ok| ok).unwrap_or(0);
    Some(cands.swap_remove(chosen_idx))
}

async fn pick_and_register_stream(
    proxy_port: u16,
    cands: Vec<StreamCandidate>,
    is_audio: bool,
) -> Option<String> {
    let chosen = pick_best_candidate(cands).await?;
    Some(
        register_proxy_stream(
            proxy_port,
            chosen.url,
            chosen.ua,
            chosen.content_type,
            is_audio,
        )
        .await,
    )
}

async fn pick_and_register_hls_stream(
    proxy_port: u16,
    cands: Vec<StreamCandidate>,
    is_audio: bool,
) -> Option<String> {
    let chosen = pick_best_candidate(cands).await?;
    Some(register_hls_proxy_stream(proxy_port, chosen.url, chosen.ua, is_audio).await)
}

/// Normalizes track ID, display label, and DRC/original flags for an audio format entry.
pub fn classify_audio_track(
    format_id: &str,
    format_note: &str,
    language: Option<&str>,
    lang_pref: i64,
) -> (String, String, bool, bool) {
    let note_lower = format_note.to_lowercase();
    let is_drc = format_id.to_lowercase().contains("drc") || note_lower.contains("drc");
    let is_original = lang_pref >= 5 || note_lower.contains("original");

    let track_id = if let Some(lang) = language {
        lang.to_lowercase()
    } else if let Some((prefix, _)) = format_note.split_once(',') {
        let clean = prefix.trim().to_lowercase();
        if matches!(
            clean.as_str(),
            "" | "low" | "medium" | "high" | "ultralow" | "default" | "drc"
        ) {
            "default".to_string()
        } else {
            clean
        }
    } else {
        "default".to_string()
    };

    let base_name = language_display_name(language.unwrap_or(&track_id));
    let label = if is_original && track_id != "default" {
        format!("{base_name} (Original)")
    } else {
        base_name
    };
    (track_id, label, is_original, is_drc)
}

fn emit_video_load_progress(app: &AppHandle, percent: f64, message: &str) {
    let _ = app.emit(
        "video-load-progress",
        serde_json::json!({
            "percent": percent,
            "message": message,
        }),
    );
}

#[tauri::command]
pub async fn fetch_video_info(app: AppHandle, url: String) -> Result<VideoMetadata, String> {
    let trimmed_url = sanitize_input_url(&url);
    if trimmed_url.is_empty() {
        return Err("Introduce una URL de video válida.".to_string());
    }

    PRECACHE_GENERATION.fetch_add(1, Ordering::SeqCst);

    let ytdlp = ensure_ytdlp_ready()?;
    emit_video_load_progress(&app, 8.0, "Conectando con yt-dlp...");
    let output = hidden_tokio_command(&ytdlp)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .args(crate::binary_manager::js_runtime_args())
        .args([
            "--encoding",
            "utf-8",
            "--dump-single-json",
            "--no-playlist",
            "--no-warnings",
            "--skip-download",
            &trimmed_url,
        ])
        .output()
        .await
        .map_err(|e| format!("Error ejecutando yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(extract_friendly_ytdlp_error(&stderr));
    }

    let raw_json = parse_ytdlp_json_stdout(&output.stdout)?;
    let json: Value = if raw_json["formats"].as_array().is_none() {
        if let Some(first_entry) = raw_json["entries"]
            .as_array()
            .and_then(|arr| arr.iter().find(|item| !item.is_null()))
        {
            first_entry.clone()
        } else {
            raw_json
        }
    } else {
        raw_json
    };
    emit_video_load_progress(&app, 45.0, "Procesando formatos y capítulos...");

    let id = json["id"].as_str().unwrap_or("video").to_string();
    let title = json["title"].as_str().unwrap_or("Sin título").to_string();
    let uploader = json["uploader"]
        .as_str()
        .or_else(|| json["channel"].as_str())
        .unwrap_or("Desconocido")
        .to_string();
    let duration = json["duration"].as_f64().unwrap_or(0.0);
    let thumbnail = json["thumbnail"]
        .as_str()
        .map(String::from)
        .or_else(|| {
            json["thumbnails"]
                .as_array()
                .and_then(|arr| arr.last())
                .and_then(|t| t["url"].as_str())
                .map(String::from)
        })
        .unwrap_or_default();

    let view_count = json["view_count"].as_u64();
    let upload_date = json["upload_date"].as_str().map(String::from);
    let webpage_url = json["webpage_url"]
        .as_str()
        .unwrap_or(&trimmed_url)
        .to_string();

    cache_raw_video_json(
        &[trimmed_url.clone(), webpage_url.clone(), id.clone()],
        json.clone(),
    );

    let mut formats = Vec::new();
    const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

    struct AudioCandidate {
        track_id: String,
        language: Option<String>,
        label: String,
        is_original: bool,
        format_id: String,
        ext: String,
        acodec: String,
        tbr: Option<f64>,
        score: u64,
        url: String,
        ua: String,
        content_type: String,
    }

    let mut combined_cands: Vec<StreamCandidate> = Vec::new();
    let mut video_mp4_cands: Vec<StreamCandidate> = Vec::new();
    let mut video_webm_cands: Vec<StreamCandidate> = Vec::new();
    let mut video_alt_cands: Vec<StreamCandidate> = Vec::new();
    let mut fallback_audio_cands: Vec<StreamCandidate> = Vec::new();
    let mut hls_mp4_cands: Vec<StreamCandidate> = Vec::new();
    let mut hls_webm_cands: Vec<StreamCandidate> = Vec::new();
    let mut hls_audio_cands: Vec<StreamCandidate> = Vec::new();
    let mut dash_hls_mp4_cands: Vec<DashHlsCandidate> = Vec::new();
    let mut dash_hls_audio_cands: Vec<DashHlsCandidate> = Vec::new();
    let mut dash_audio_tracks: HashMap<String, (AudioCandidate, Vec<String>)> = HashMap::new();
    let mut audio_track_map: HashMap<String, AudioCandidate> = HashMap::new();

    if let Some(raw_formats) = json["formats"].as_array() {
        for f in raw_formats {
            let format_id = f["format_id"].as_str().unwrap_or("").to_string();
            let ext = f["ext"].as_str().unwrap_or("").to_string();
            let vcodec = f["vcodec"].as_str().unwrap_or("none").to_string();
            let acodec = f["acodec"].as_str().unwrap_or("none").to_string();

            if format_id.is_empty() || ext == "mhtml" {
                continue;
            }

            let protocol = f["protocol"].as_str().unwrap_or("");
            let is_direct_http = protocol == "https" || protocol == "http";
            let is_hls = protocol == "m3u8_native" || protocol == "m3u8";
            let is_dash_segments = protocol == "http_dash_segments";

            let has_video = vcodec != "none";
            let has_audio = acodec != "none"
                || (is_hls
                    && !has_video
                    && (format_id.starts_with("233") || format_id.starts_with("234")));
            if !has_video && !has_audio {
                continue;
            }

            let width = f["width"].as_u64().map(|v| v as u32);
            let height = f["height"].as_u64().map(|v| v as u32);
            let fps = f["fps"].as_f64();
            let filesize = f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64());
            let tbr = f["tbr"].as_f64();
            let format_note = f["format_note"].as_str().unwrap_or("").to_string();
            let language = f["language"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from);
            let lang_pref = f["language_preference"].as_i64().unwrap_or(-1);
            let stream_url = f["url"].as_str().unwrap_or("");
            let stream_ua = f["http_headers"]["User-Agent"]
                .as_str()
                .unwrap_or(DEFAULT_UA)
                .to_string();

            let resolution = if let Some(res) = f["resolution"].as_str() {
                res.to_string()
            } else if let (Some(w), Some(h)) = (width, height) {
                format!("{w}x{h}")
            } else if !has_video {
                "audio only".to_string()
            } else {
                "unknown".to_string()
            };

            if is_direct_http && !stream_url.is_empty() {
                let h_score = height.unwrap_or(0) as u64;
                let is_av1 = vcodec.starts_with("av01");
                if has_video && has_audio {
                    let ext_bonus = if ext == "mp4" { 10_000 } else { 0 };
                    combined_cands.push(StreamCandidate {
                        score: ext_bonus + h_score,
                        url: stream_url.to_string(),
                        ua: stream_ua,
                        content_type: if ext == "webm" {
                            "video/webm".to_string()
                        } else {
                            "video/mp4".to_string()
                        },
                        height,
                        is_hls: false,
                        is_av1,
                    });
                } else if has_video && !has_audio {
                    let score = compute_preview_video_score(
                        &ext, &vcodec, width, height, fps, tbr,
                    );
                    if ext == "mp4" {
                        video_mp4_cands.push(StreamCandidate {
                            score,
                            url: stream_url.to_string(),
                            ua: stream_ua.clone(),
                            content_type: "video/mp4".to_string(),
                            height,
                            is_hls: false,
                            is_av1,
                        });
                        let alt_short = match (width, height) {
                            (Some(w), Some(hh)) if w > 0 && hh > 0 => w.min(hh),
                            _ => height.unwrap_or(0),
                        };
                        if is_av1 || (vcodec.starts_with("avc1") && alt_short <= 480) {
                            let alt_bonus = if is_av1 { 100_000 } else { 0 };
                            video_alt_cands.push(StreamCandidate {
                                score: score + alt_bonus,
                                url: stream_url.to_string(),
                                ua: stream_ua,
                                content_type: "video/mp4".to_string(),
                                height,
                                is_hls: false,
                                is_av1,
                            });
                        }
                    } else if ext == "webm" {
                        video_webm_cands.push(StreamCandidate {
                            score,
                            url: stream_url.to_string(),
                            ua: stream_ua,
                            content_type: "video/webm".to_string(),
                            height,
                            is_hls: false,
                            is_av1,
                        });
                    }
                } else if has_audio && !has_video {
                    let tbr_score = tbr.unwrap_or(0.0).round() as u64;
                    if ext == "m4a" || ext == "mp4" {
                        fallback_audio_cands.push(StreamCandidate {
                            score: 100_000 + tbr_score,
                            url: stream_url.to_string(),
                            ua: stream_ua.clone(),
                            content_type: "audio/mp4".to_string(),
                            height: None,
                            is_hls: false,
                            is_av1: false,
                        });
                    } else if ext == "webm" || ext == "opus" {
                        fallback_audio_cands.push(StreamCandidate {
                            score: 50_000 + tbr_score,
                            url: stream_url.to_string(),
                            ua: stream_ua.clone(),
                            content_type: "audio/webm".to_string(),
                            height: None,
                            is_hls: false,
                            is_av1: false,
                        });
                    }

                    if ext == "m4a" || ext == "webm" || ext == "mp4" || ext == "opus" {
                        let (track_id, label, is_original, is_drc) = classify_audio_track(
                            &format_id,
                            &format_note,
                            language.as_deref(),
                            lang_pref,
                        );

                        let ext_bonus = match ext.as_str() {
                            "m4a" | "mp4" => 100_000,
                            "webm" | "opus" => 50_000,
                            _ => 10_000,
                        };
                        let drc_bonus = if is_drc { 0 } else { 10_000 };
                        let score = ext_bonus + drc_bonus + tbr_score;

                        let content_type = if ext == "webm" || ext == "opus" {
                            "audio/webm".to_string()
                        } else {
                            "audio/mp4".to_string()
                        };

                        let should_replace = audio_track_map
                            .get(&track_id)
                            .map_or(true, |prev| score > prev.score);
                        if should_replace {
                            audio_track_map.insert(
                                track_id.clone(),
                                AudioCandidate {
                                    track_id,
                                    language: language.clone(),
                                    label,
                                    is_original,
                                    format_id: format_id.clone(),
                                    ext: ext.clone(),
                                    acodec: acodec.clone(),
                                    tbr,
                                    score,
                                    url: stream_url.to_string(),
                                    ua: stream_ua,
                                    content_type,
                                },
                            );
                        }
                    }
                }
            } else if is_hls && !stream_url.is_empty() {
                let h_score = height.unwrap_or(0) as u64;
                let is_av1 = vcodec.starts_with("av01");
                if has_video && !has_audio {
                    let is_vp9 =
                        ext == "webm" || vcodec.starts_with("vp9") || vcodec.starts_with("vp09");
                    if is_vp9 {
                        let score = compute_preview_video_score(
                            "webm", &vcodec, width, height, fps, tbr,
                        );
                        hls_webm_cands.push(StreamCandidate {
                            score,
                            url: stream_url.to_string(),
                            ua: stream_ua,
                            content_type: "application/vnd.apple.mpegurl".to_string(),
                            height,
                            is_hls: true,
                            is_av1,
                        });
                    } else {
                        let score = compute_preview_video_score(
                            "mp4", &vcodec, width, height, fps, tbr,
                        );
                        hls_mp4_cands.push(StreamCandidate {
                            score,
                            url: stream_url.to_string(),
                            ua: stream_ua,
                            content_type: "application/vnd.apple.mpegurl".to_string(),
                            height,
                            is_hls: true,
                            is_av1,
                        });
                    }
                } else if has_video && has_audio {
                    hls_mp4_cands.push(StreamCandidate {
                        score: 5_000 + h_score,
                        url: stream_url.to_string(),
                        ua: stream_ua,
                        content_type: "application/vnd.apple.mpegurl".to_string(),
                        height,
                        is_hls: true,
                        is_av1,
                    });
                } else if has_audio && !has_video {
                    let note_lower = format_note.to_lowercase();
                    let is_original = lang_pref >= 5 || note_lower.contains("original");
                    let is_es = language
                        .as_deref()
                        .map(|l| {
                            let low = l.to_lowercase();
                            low == "es" || low.starts_with("es-")
                        })
                        .unwrap_or(false)
                        || note_lower.contains("spanish")
                        || note_lower.starts_with("es");
                    let lang_bonus = if is_original && is_es {
                        300_000
                    } else if is_original {
                        200_000
                    } else if is_es {
                        100_000
                    } else {
                        0
                    };
                    let quality_bonus = if format_id.starts_with("234") { 10_000 } else { 0 };
                    let tbr_score = tbr.unwrap_or(0.0).round() as u64;
                    hls_audio_cands.push(StreamCandidate {
                        score: lang_bonus + quality_bonus + tbr_score,
                        url: stream_url.to_string(),
                        ua: stream_ua,
                        content_type: "application/vnd.apple.mpegurl".to_string(),
                        height: None,
                        is_hls: true,
                        is_av1: false,
                    });
                }
            } else if is_dash_segments && (ext == "mp4" || ext == "m4a") {
                let frag_urls = extract_format_fragment_urls(f);
                if !frag_urls.is_empty() {
                    if has_video && !has_audio {
                        let score = compute_preview_video_score(
                            "mp4", &vcodec, width, height, fps, tbr,
                        );
                        dash_hls_mp4_cands.push(DashHlsCandidate {
                            score,
                            fragments: frag_urls,
                            ua: stream_ua,
                            duration_secs: duration,
                            height,
                        });
                    } else if has_audio && !has_video {
                        let tbr_score = tbr.unwrap_or(0.0).round() as u64;
                        let (track_id, label, is_original, is_drc) = classify_audio_track(
                            &format_id,
                            &format_note,
                            language.as_deref(),
                            lang_pref,
                        );
                        let drc_bonus = if is_drc { 0 } else { 10_000 };
                        let score = 100_000 + drc_bonus + tbr_score;

                        dash_hls_audio_cands.push(DashHlsCandidate {
                            score,
                            fragments: frag_urls.clone(),
                            ua: stream_ua.clone(),
                            duration_secs: duration,
                            height: None,
                        });

                        let should_replace = dash_audio_tracks
                            .get(&track_id)
                            .map_or(true, |(prev, _)| score > prev.score);
                        if should_replace {
                            dash_audio_tracks.insert(
                                track_id.clone(),
                                (
                                    AudioCandidate {
                                        track_id,
                                        language: language.clone(),
                                        label,
                                        is_original,
                                        format_id: format_id.clone(),
                                        ext: ext.clone(),
                                        acodec: acodec.clone(),
                                        tbr,
                                        score,
                                        url: stream_url.to_string(),
                                        ua: stream_ua,
                                        content_type: "application/vnd.apple.mpegurl".to_string(),
                                    },
                                    frag_urls,
                                ),
                            );
                        }
                    }
                }
            }

            formats.push(VideoFormatOption {
                format_id,
                ext,
                resolution,
                height,
                width,
                fps,
                vcodec,
                acodec,
                filesize,
                tbr,
                format_note,
                language,
                has_video,
                has_audio,
            });
        }
    }

    formats.sort_by(|a, b| {
        b.has_video
            .cmp(&a.has_video)
            .then_with(|| b.height.unwrap_or(0).cmp(&a.height.unwrap_or(0)))
            .then_with(|| {
                b.tbr
                    .unwrap_or(0.0)
                    .partial_cmp(&a.tbr.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let proxy_port = ensure_proxy_server().await?;

    // Sort candidate audio tracks: Original Spanish -> Original -> Spanish -> Others
    let mut sorted_audio_cands: Vec<AudioCandidate> = audio_track_map.into_values().collect();
    sorted_audio_cands.sort_by(|a, b| {
        let rank = |c: &AudioCandidate| -> u8 {
            let is_es = c.track_id == "es" || c.track_id.starts_with("es-");
            if c.is_original && is_es {
                0
            } else if c.is_original {
                1
            } else if is_es {
                2
            } else {
                3
            }
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| b.score.cmp(&a.score))
    });

    // Probe audio track candidates concurrently so multi-audio videos resolve quickly
    emit_video_load_progress(&app, 58.0, "Verificando pistas de audio...");
    let probe_futures = sorted_audio_cands
        .iter()
        .map(|cand| probe_stream_ok(&cand.url, &cand.ua));
    let probe_results = futures_util::future::join_all(probe_futures).await;

    let mut audio_tracks: Vec<AudioTrackOption> = Vec::new();
    let mut fallback_audio_track: Option<AudioCandidate> = None;
    for (cand, ok) in sorted_audio_cands.into_iter().zip(probe_results.into_iter()) {
        if ok {
            let proxy_url = register_proxy_stream(
                proxy_port,
                cand.url,
                cand.ua,
                cand.content_type,
                true,
            )
            .await;
            audio_tracks.push(AudioTrackOption {
                track_id: cand.track_id,
                language: cand.language,
                label: cand.label,
                is_original: cand.is_original,
                format_id: cand.format_id,
                ext: cand.ext,
                acodec: cand.acodec,
                tbr: cand.tbr,
                preview_url: proxy_url,
            });
        } else if fallback_audio_track.is_none() {
            fallback_audio_track = Some(cand);
        }
    }

    if audio_tracks.is_empty() {
        if let Some(cand) = fallback_audio_track {
            let proxy_url = register_proxy_stream(
                proxy_port,
                cand.url,
                cand.ua,
                cand.content_type,
                true,
            )
            .await;
            audio_tracks.push(AudioTrackOption {
                track_id: cand.track_id,
                language: cand.language,
                label: cand.label,
                is_original: cand.is_original,
                format_id: cand.format_id,
                ext: cand.ext,
                acodec: cand.acodec,
                tbr: cand.tbr,
                preview_url: proxy_url,
            });
        }
    }

    let mut mp4_for_resolutions = video_mp4_cands.clone();
    for cand in &combined_cands {
        if cand.content_type == "video/mp4" && !mp4_for_resolutions.iter().any(|c| c.url == cand.url) {
            mp4_for_resolutions.push(cand.clone());
        }
    }
    for cand in &hls_mp4_cands {
        if !mp4_for_resolutions.iter().any(|c| c.url == cand.url) {
            mp4_for_resolutions.push(cand.clone());
        }
    }

    let mut webm_for_resolutions = video_webm_cands.clone();
    for cand in &combined_cands {
        if cand.content_type == "video/webm" && !webm_for_resolutions.iter().any(|c| c.url == cand.url) {
            webm_for_resolutions.push(cand.clone());
        }
    }
    for cand in &hls_webm_cands {
        if !webm_for_resolutions.iter().any(|c| c.url == cand.url) {
            webm_for_resolutions.push(cand.clone());
        }
    }

    emit_video_load_progress(&app, 70.0, "Preparando vista previa...");
    let (preview_combined_url, mut preview_stream_url, mut preview_webm_url, preview_alt_url) =
        tokio::join!(
            pick_and_register_stream(proxy_port, combined_cands, false),
            pick_and_register_stream(proxy_port, video_mp4_cands, false),
            pick_and_register_stream(proxy_port, video_webm_cands, false),
            pick_and_register_stream(proxy_port, video_alt_cands, false),
        );

    if preview_stream_url.is_none() {
        preview_stream_url = preview_combined_url
            .clone()
            .or_else(|| preview_alt_url.clone())
            .or_else(|| preview_webm_url.clone());
    }
    if preview_webm_url.is_none() {
        preview_webm_url = preview_alt_url
            .clone()
            .or_else(|| preview_combined_url.clone())
            .or_else(|| preview_stream_url.clone());
    }

    let mut preview_audio_url: Option<String> = audio_tracks.first().map(|t| t.preview_url.clone());
    if preview_audio_url.is_none() {
        preview_audio_url = pick_and_register_stream(proxy_port, fallback_audio_cands, true).await;
    }

    if preview_stream_url.is_none() || preview_webm_url.is_none() {
        let (hls_mp4_url, hls_webm_url) = tokio::join!(
            pick_and_register_hls_stream(proxy_port, hls_mp4_cands, false),
            pick_and_register_hls_stream(proxy_port, hls_webm_cands, false),
        );
        if preview_stream_url.is_none() {
            preview_stream_url = hls_mp4_url.clone().or_else(|| hls_webm_url.clone());
        }
        if preview_webm_url.is_none() {
            preview_webm_url = hls_webm_url
                .or(hls_mp4_url)
                .or_else(|| preview_stream_url.clone());
        }
    }

    if preview_audio_url.is_none() {
        preview_audio_url = pick_and_register_hls_stream(proxy_port, hls_audio_cands, true).await;
    }

    // Fallback to synthesized VOD fMP4 HLS playlists for `http_dash_segments` videos
    // (such as Post-Live Manifestless broadcasts where direct HTTPS/M3U8 streams do not exist).
    let dash_hls_backup = if !dash_hls_mp4_cands.is_empty() {
        Some(dash_hls_mp4_cands.clone())
    } else {
        None
    };
    if preview_stream_url.is_none() && !dash_hls_mp4_cands.is_empty() {
        let dash_mp4_url = pick_and_register_dash_hls_stream(proxy_port, dash_hls_mp4_cands, false).await;
        if let Some(url) = dash_mp4_url {
            preview_stream_url = Some(url.clone());
            if preview_webm_url.is_none() {
                preview_webm_url = Some(url);
            }
        }
    }

    if audio_tracks.is_empty() && !dash_audio_tracks.is_empty() {
        let mut sorted_dash_audio: Vec<(AudioCandidate, Vec<String>)> =
            dash_audio_tracks.into_values().collect();
        sorted_dash_audio.sort_by(|(a, _), (b, _)| b.score.cmp(&a.score));
        for (cand, frags) in sorted_dash_audio {
            let proxy_url = register_dash_hls_proxy_stream(
                proxy_port,
                frags,
                cand.ua,
                true,
                duration,
            )
            .await;
            audio_tracks.push(AudioTrackOption {
                track_id: cand.track_id,
                language: cand.language,
                label: cand.label,
                is_original: cand.is_original,
                format_id: cand.format_id,
                ext: cand.ext,
                acodec: cand.acodec,
                tbr: cand.tbr,
                preview_url: proxy_url,
            });
        }
        if preview_audio_url.is_none() {
            preview_audio_url = audio_tracks.first().map(|t| t.preview_url.clone());
        }
    }

    if preview_audio_url.is_none() && !dash_hls_audio_cands.is_empty() {
        preview_audio_url = pick_and_register_dash_hls_stream(proxy_port, dash_hls_audio_cands, true).await;
    }

    let embed_url = if webpage_url.contains("youtube.com") || webpage_url.contains("youtu.be") {
        format!("https://www.youtube.com/embed/{id}?enablejsapi=1&rel=0")
    } else {
        webpage_url.clone()
    };

    let chapters = json["chapters"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let c_title = c["title"].as_str()?.to_string();
                    let start_time = c["start_time"].as_f64()?;
                    let end_time = c["end_time"].as_f64()?;
                    Some(VideoChapter {
                        title: c_title,
                        start_time,
                        end_time,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut sub_set = BTreeSet::new();
    if let Some(obj) = json["subtitles"].as_object() {
        for k in obj.keys() {
            if k != "live_chat" {
                sub_set.insert(k.clone());
            }
        }
    }
    if let Some(obj) = json["automatic_captions"].as_object() {
        for k in obj.keys() {
            if k == "es" || k == "en" || k == "pt" || k == "fr" {
                sub_set.insert(k.clone());
            }
        }
    }
    let subtitles: Vec<String> = sub_set.into_iter().collect();

    // Collect all distinct available video heights in ascending order
    let mut available_heights: BTreeSet<u32> = BTreeSet::new();
    for c in mp4_for_resolutions.iter().chain(webm_for_resolutions.iter()) {
        if let Some(h) = c.height {
            if h >= 144 {
                available_heights.insert(h);
            }
        }
    }

    let standard_targets: &[u32] = &[360, 480, 720, 1080, 1440, 2160];
    let mut selected_heights: BTreeSet<u32> = BTreeSet::new();

    for &std_h in standard_targets {
        if available_heights.contains(&std_h) {
            selected_heights.insert(std_h);
        } else if let Some(&closest) = available_heights
            .iter()
            .min_by_key(|&&h| (h as i32 - std_h as i32).abs())
        {
            if (closest as i32 - std_h as i32).abs() <= 120 {
                selected_heights.insert(closest);
            }
        }
    }

    if let Some(&max_h) = available_heights.iter().next_back() {
        selected_heights.insert(max_h);
    }

    let mut preview_resolutions: Vec<crate::models::PreviewResolutionEntry> = Vec::new();
    let max_height = selected_heights.iter().next_back().copied().unwrap_or(1080);
    let descending_heights: Vec<u32> = selected_heights.into_iter().rev().collect();
    let mut resolution_primary_cands: Vec<(usize, StreamCandidate)> = Vec::new();

    for h in descending_heights {
        let (best_mp4, best_webm) =
            select_best_resolution_candidates(&mp4_for_resolutions, &webm_for_resolutions, h);

        if best_mp4.is_none() && best_webm.is_none() {
            continue;
        }

        let mut mp4_url = if let Some(cand) = best_mp4 {
            Some(register_candidate_stream(proxy_port, cand, false).await)
        } else {
            None
        };

        let mut webm_url = if let Some(cand) = best_webm {
            Some(register_candidate_stream(proxy_port, cand, false).await)
        } else {
            None
        };

        if mp4_url.is_none() && webm_url.is_some() {
            mp4_url = webm_url.clone();
        } else if webm_url.is_none() && mp4_url.is_some() {
            webm_url = mp4_url.clone();
        }

        let label = if h == max_height {
            format!("{h}p (Máxima)")
        } else {
            format!("{h}p")
        };

        let entry_idx = preview_resolutions.len();
        if let Some(cand) = best_mp4.or(best_webm) {
            resolution_primary_cands.push((entry_idx, (*cand).clone()));
        }

        preview_resolutions.push(crate::models::PreviewResolutionEntry {
            label,
            height: h,
            mp4_url,
            webm_url,
        });
    }

    // Populate multi-resolution entries for `http_dash_segments` VODs if needed
    if preview_resolutions.is_empty() {
        if let Some(mut dash_cands) = dash_hls_backup {
            dash_cands.sort_by(|a, b| {
                b.height
                    .unwrap_or(0)
                    .cmp(&a.height.unwrap_or(0))
                    .then_with(|| b.score.cmp(&a.score))
            });
            let mut seen_h: BTreeSet<u32> = BTreeSet::new();
            let top_dash_h = dash_cands.iter().filter_map(|c| c.height).max().unwrap_or(1080);
            for cand in dash_cands {
                let h = cand.height.unwrap_or(1080);
                if !seen_h.insert(h) {
                    continue;
                }
                let u = register_dash_hls_proxy_stream(
                    proxy_port,
                    cand.fragments,
                    cand.ua,
                    false,
                    cand.duration_secs,
                )
                .await;
                let label = if h == top_dash_h {
                    format!("{h}p (Máxima)")
                } else {
                    format!("{h}p")
                };
                preview_resolutions.push(crate::models::PreviewResolutionEntry {
                    label,
                    height: h,
                    mp4_url: Some(u.clone()),
                    webm_url: Some(u),
                });
            }
        }
    }

    // Pick initial stream from top resolution, verifying direct candidate health via probe
    let mut chosen_top_idx: usize = resolution_primary_cands
        .first()
        .map(|&(idx, _)| idx)
        .unwrap_or(0);
    if resolution_primary_cands.len() > 1 {
        if let Some(&(_, ref cand0)) = resolution_primary_cands.first() {
            if !cand0.is_hls && !probe_stream_ok(&cand0.url, &cand0.ua).await {
                for &(idx_alt, ref cand_alt) in resolution_primary_cands.iter().skip(1).take(3) {
                    if cand_alt.is_hls || probe_stream_ok(&cand_alt.url, &cand_alt.ua).await {
                        chosen_top_idx = idx_alt;
                        break;
                    }
                }
            }
        }
    }

    if let Some(top) = preview_resolutions.get(chosen_top_idx).or_else(|| preview_resolutions.first()) {
        if let Some(ref u) = top.mp4_url {
            preview_stream_url = Some(u.clone());
        }
        if let Some(ref u) = top.webm_url {
            preview_webm_url = Some(u.clone());
        }
    }

    if preview_resolutions.is_empty() && (preview_stream_url.is_some() || preview_webm_url.is_some()) {
        preview_resolutions.push(crate::models::PreviewResolutionEntry {
            label: "Máxima".to_string(),
            height: 1080,
            mp4_url: preview_stream_url.clone(),
            webm_url: preview_webm_url.clone(),
        });
    }

    // Start background pre-caching AFTER final stream selection so we precache the actual active streams
    if let Some(ref audio_url) = preview_audio_url {
        if audio_url.contains("/stream/") {
            precache_stream_by_url(audio_url).await;
        }
    }
    if let Some(ref video_url) = preview_stream_url.as_ref().or(preview_webm_url.as_ref()) {
        if video_url.contains("/stream/") {
            precache_stream_by_url(video_url).await;
        }
    }

    emit_video_load_progress(&app, 80.0, "Iniciando reproductor...");

    Ok(VideoMetadata {
        id,
        title,
        uploader,
        duration,
        thumbnail,
        view_count,
        upload_date,
        webpage_url,
        preview_stream_url,
        preview_combined_url,
        preview_webm_url,
        preview_audio_url,
        preview_resolutions,
        embed_url,
        audio_tracks,
        formats,
        chapters,
        subtitles,
    })
}

#[tauri::command]
pub async fn start_full_download(
    app: AppHandle,
    url: String,
    video_title: String,
    options: ManualDownloadOptions,
) -> Result<String, String> {
    let _ = ensure_ytdlp_ready()?;

    let out_dir = Path::new(&options.output_dir);
    std::fs::create_dir_all(out_dir)
        .map_err(|e| format!("No se pudo crear la carpeta de salida: {e}"))?;

    let job_id = Uuid::new_v4().to_string();
    let job_id_clone = job_id.clone();
    let title_clone = if video_title.trim().is_empty() {
        "Descarga de Video".to_string()
    } else {
        video_title.clone()
    };

    register_job(&job_id, &title_clone);

    emit_job_event(
        &app,
        JobProgressEvent {
            job_id: job_id.clone(),
            title: title_clone.clone(),
            status: "queued".to_string(),
            percent: 0.0,
            clip_percent: Some(0.0),
            clip_index: Some(1),
            clip_total: Some(1),
            clip_name: Some(title_clone.clone()),
            speed: "--".to_string(),
            eta: "--".to_string(),
            current_step: "Preparando descarga con yt-dlp...".to_string(),
            output_files: vec![],
            log_line: None,
        },
    );

    tokio::spawn(async move {
        let target_fps = if options.mode != "audio_only" {
            options.target_fps.filter(|&f| f > 0)
        } else {
            None
        };
        let dl_span = if target_fps.is_some() { 75.0 } else { 100.0 };

        let mut args = Vec::new();
        append_format_and_option_args(&mut args, &options);

        let output_template = Path::new(&options.output_dir)
            .join("%(title)s [%(id)s].%(ext)s")
            .to_string_lossy()
            .to_string();
        args.push("-o".to_string());
        args.push(output_template);
        args.push("--print".to_string());
        args.push("after_move:__CLIPGEN_FILE__:%(filepath)s".to_string());
        args.push(url);

        match run_ytdlp_with_progress(YtdlpRunConfig {
            app: &app,
            job_id: &job_id_clone,
            title: &title_clone,
            args,
            base_percent: 0.0,
            percent_span: dl_span,
            clip_percent_base: 0.0,
            clip_percent_span: dl_span,
            step_label: "Descargando con yt-dlp...",
            clip_duration_secs: None,
            clip_index: Some(1),
            clip_total: Some(1),
            clip_name: Some(&title_clone),
        })
        .await
        {
            Ok(files) => {
                if let Some(fps) = target_fps {
                    let count = files.len().max(1);
                    let per_file_span = 25.0 / count as f64;
                    for (i, file_str) in files.iter().enumerate() {
                        let base = 75.0 + (i as f64) * per_file_span;
                        if let Err(err) = ensure_file_target_fps(
                            &app,
                            &job_id_clone,
                            &title_clone,
                            Path::new(file_str),
                            fps,
                            base,
                            per_file_span,
                            base,
                            per_file_span,
                            Some(1),
                            Some(1),
                            Some(&title_clone),
                            None,
                        )
                        .await
                        {
                            let cancelled = err == "__CANCELLED__" || is_job_cancelled(&job_id_clone);
                            emit_job_event(
                                &app,
                                JobProgressEvent {
                                    job_id: job_id_clone.clone(),
                                    title: title_clone.clone(),
                                    status: if cancelled { "cancelled" } else { "error" }.to_string(),
                                    percent: 0.0,
                                    clip_percent: None,
                                    clip_index: Some(1),
                                    clip_total: Some(1),
                                    clip_name: Some(title_clone.clone()),
                                    speed: "--".to_string(),
                                    eta: "--".to_string(),
                                    current_step: if cancelled {
                                        "Descarga cancelada por el usuario".to_string()
                                    } else {
                                        format!("Error convirtiendo FPS: {err}")
                                    },
                                    output_files: vec![],
                                    log_line: if cancelled {
                                        None
                                    } else {
                                        Some(format!("ERROR: {err}"))
                                    },
                                },
                            );
                            unregister_job(&job_id_clone);
                            return;
                        }
                    }
                }

                emit_job_event(
                    &app,
                    JobProgressEvent {
                        job_id: job_id_clone.clone(),
                        title: title_clone.clone(),
                        status: "completed".to_string(),
                        percent: 100.0,
                        clip_percent: Some(100.0),
                        clip_index: Some(1),
                        clip_total: Some(1),
                        clip_name: Some(title_clone),
                        speed: "--".to_string(),
                        eta: "00:00".to_string(),
                        current_step: "Descarga completada".to_string(),
                        output_files: files,
                        log_line: Some("Proceso finalizado correctamente.".to_string()),
                    },
                );
            }
            Err(err) => {
                let cancelled = err == "__CANCELLED__" || is_job_cancelled(&job_id_clone);
                emit_job_event(
                    &app,
                    JobProgressEvent {
                        job_id: job_id_clone.clone(),
                        title: title_clone.clone(),
                        status: if cancelled { "cancelled" } else { "error" }.to_string(),
                        percent: 0.0,
                        clip_percent: None,
                        clip_index: Some(1),
                        clip_total: Some(1),
                        clip_name: Some(title_clone),
                        speed: "--".to_string(),
                        eta: "--".to_string(),
                        current_step: if cancelled {
                            "Descarga cancelada por el usuario".to_string()
                        } else {
                            format!("Error: {err}")
                        },
                        output_files: vec![],
                        log_line: if cancelled {
                            None
                        } else {
                            Some(format!("ERROR: {err}"))
                        },
                    },
                );
            }
        }
        unregister_job(&job_id_clone);
    });

    Ok(job_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cap_range_header() {
        assert_eq!(cap_range_header("bytes=0-"), "bytes=0-4194303");
        assert_eq!(cap_range_header("bytes=100-200"), "bytes=100-200");
        assert_eq!(cap_range_header("bytes=10-99999999"), "bytes=10-4194313");
        assert_eq!(cap_range_header("bytes=-500"), "bytes=-500");
    }

    #[test]
    fn test_parse_byte_range() {
        assert_eq!(parse_byte_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_byte_range("bytes=100-199", 1000), Some((100, 199)));
        assert_eq!(parse_byte_range("bytes=100-5000", 1000), Some((100, 999)));
        assert_eq!(parse_byte_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_byte_range("bytes=1000-", 1000), None);
        assert_eq!(parse_byte_range("bytes=200-100", 1000), None);
        assert_eq!(parse_byte_range("bytes=0-10", 0), None);
    }

    #[test]
    fn test_parse_open_range() {
        assert_eq!(parse_open_range(None), (0, None, false));
        assert_eq!(parse_open_range(Some("bytes=0-")), (0, None, true));
        assert_eq!(parse_open_range(Some("bytes=500-999")), (500, Some(999), true));
        assert_eq!(parse_open_range(Some("bytes=1024-")), (1024, None, true));
        assert_eq!(parse_open_range(Some("bytes=500-100")), (500, None, true));
    }

    #[test]
    fn test_parse_ffmpeg_time_secs() {
        let line = "frame=  120 fps= 60 q=28.0 size= 1024KiB time=00:01:23.45 bitrate=1677.7kbits/s speed=2.5x";
        let secs = parse_ffmpeg_time_secs(line).unwrap();
        assert!((secs - 83.45).abs() < 0.001);
        assert!(parse_ffmpeg_time_secs("no timestamp here").is_none());
    }

    #[test]
    fn test_parse_ffprobe_fps() {
        assert_eq!(parse_ffprobe_fps("60/1"), Some(60.0));
        let ntsc = parse_ffprobe_fps("30000/1001").unwrap();
        assert!((ntsc - 29.97002997).abs() < 0.001);
        assert_eq!(parse_ffprobe_fps("24"), Some(24.0));
        assert_eq!(parse_ffprobe_fps("0/0"), None);
        assert_eq!(parse_ffprobe_fps("N/A"), None);
    }

    #[test]
    fn test_append_format_args_audio_only() {
        let opts = ManualDownloadOptions {
            mode: "audio_only".to_string(),
            quality_preset: "best".to_string(),
            custom_video_format_id: None,
            custom_audio_format_id: None,
            audio_track_id: None,
            audio_format_id: None,
            container: "mp4".to_string(),
            audio_format: "mp3".to_string(),
            audio_bitrate: "320K".to_string(),
            embed_subtitles: false,
            subtitle_lang: "es".to_string(),
            embed_thumbnail: true,
            embed_metadata: true,
            rate_limit: Some("5M".to_string()),
            custom_args: None,
            target_fps: Some(30),
            output_dir: ".".to_string(),
            filename_format: None,
            clip_start_index: None,
        };
        let mut args = Vec::new();
        append_format_and_option_args(&mut args, &opts);
        assert!(args.contains(&"--no-warnings".to_string()));
        assert!(args.contains(&"-x".to_string()));
        assert!(args.contains(&"mp3".to_string()));
        assert!(args.contains(&"320K".to_string()));
        assert!(args.contains(&"--limit-rate".to_string()));
        assert!(args.contains(&"5M".to_string()));
        assert!(!args.contains(&"-S".to_string()));
    }

    #[test]
    fn test_append_format_args_custom_video_audio() {
        let opts = ManualDownloadOptions {
            mode: "video_audio".to_string(),
            quality_preset: "custom".to_string(),
            custom_video_format_id: Some("137".to_string()),
            custom_audio_format_id: Some("140".to_string()),
            audio_track_id: None,
            audio_format_id: None,
            container: "mkv".to_string(),
            audio_format: "mp3".to_string(),
            audio_bitrate: "192K".to_string(),
            embed_subtitles: true,
            subtitle_lang: "es,en".to_string(),
            embed_thumbnail: false,
            embed_metadata: false,
            rate_limit: None,
            custom_args: Some("--no-mtime".to_string()),
            target_fps: None,
            output_dir: ".".to_string(),
            filename_format: None,
            clip_start_index: None,
        };
        let mut args = Vec::new();
        append_format_and_option_args(&mut args, &opts);
        assert!(args.contains(&"137+140/best".to_string()));
        assert!(args.contains(&"--merge-output-format".to_string()));
        assert!(args.contains(&"mkv".to_string()));
        assert!(args.contains(&"--embed-subs".to_string()));
        assert!(args.contains(&"--no-mtime".to_string()));
    }

    #[test]
    fn test_append_format_args_selected_audio_track() {
        let opts = ManualDownloadOptions {
            mode: "video_audio".to_string(),
            quality_preset: "1080".to_string(),
            custom_video_format_id: None,
            custom_audio_format_id: None,
            audio_track_id: Some("es-419".to_string()),
            audio_format_id: Some("140-1".to_string()),
            container: "mp4".to_string(),
            audio_format: "mp3".to_string(),
            audio_bitrate: "320K".to_string(),
            embed_subtitles: false,
            subtitle_lang: "es,en".to_string(),
            embed_thumbnail: false,
            embed_metadata: true,
            rate_limit: None,
            custom_args: None,
            target_fps: None,
            output_dir: ".".to_string(),
            filename_format: None,
            clip_start_index: None,
        };
        let mut args = Vec::new();
        append_format_and_option_args(&mut args, &opts);
        let f_pos = args.iter().position(|a| a == "-f").unwrap();
        let selector = &args[f_pos + 1];
        assert!(selector.contains("bestvideo[height<=?1080]+140-1"));
        assert!(selector.contains("bestaudio[language=es-419]"));
    }

    #[test]
    fn test_append_format_args_target_fps() {
        let opts = ManualDownloadOptions {
            mode: "video_audio".to_string(),
            quality_preset: "1080".to_string(),
            custom_video_format_id: None,
            custom_audio_format_id: None,
            audio_track_id: None,
            audio_format_id: None,
            container: "mp4".to_string(),
            audio_format: "mp3".to_string(),
            audio_bitrate: "320K".to_string(),
            embed_subtitles: false,
            subtitle_lang: "es,en".to_string(),
            embed_thumbnail: false,
            embed_metadata: true,
            rate_limit: None,
            custom_args: None,
            target_fps: Some(24),
            output_dir: ".".to_string(),
            filename_format: None,
            clip_start_index: None,
        };
        let mut args = Vec::new();
        append_format_and_option_args(&mut args, &opts);
        let s_pos = args.iter().position(|a| a == "-S").unwrap();
        assert_eq!(args[s_pos + 1], "res,fps:24");
    }

    #[test]
    fn test_job_cancel_registry() {
        let jid = format!("test-job-{}", Uuid::new_v4());
        let (flag, rx) = register_job(&jid, "Test Video");
        assert!(!is_job_cancelled(&jid));
        assert!(!*rx.borrow());

        set_job_pid(&jid, Some(12345));
        {
            let mut map = active_jobs().lock().unwrap();
            let entry = map.get_mut(&jid).unwrap();
            assert_eq!(entry.pid, Some(12345));
            entry.cancelled.store(true, Ordering::SeqCst);
            let _ = entry.tx.send(true);
        }

        assert!(flag.load(Ordering::SeqCst));
        assert!(is_job_cancelled(&jid));
        assert!(*rx.borrow());

        unregister_job(&jid);
        assert!(!is_job_cancelled(&jid));
    }

    #[test]
    fn test_compute_preview_video_score() {
        let vertical_720 = compute_preview_video_score(
            "mp4",
            "avc1.4d401f",
            Some(720),
            Some(1280),
            Some(30.0),
            Some(800.0),
        );
        let vertical_1080 = compute_preview_video_score(
            "mp4",
            "avc1.640028",
            Some(1080),
            Some(1920),
            Some(30.0),
            Some(1100.0),
        );
        let horiz_720_avc = compute_preview_video_score(
            "mp4",
            "avc1.4d401f",
            Some(1280),
            Some(720),
            Some(30.0),
            Some(900.0),
        );
        let horiz_1080_avc = compute_preview_video_score(
            "mp4",
            "avc1.640028",
            Some(1920),
            Some(1080),
            Some(30.0),
            Some(1500.0),
        );
        let horiz_360_avc = compute_preview_video_score(
            "mp4",
            "avc1.4d401e",
            Some(640),
            Some(360),
            Some(30.0),
            Some(400.0),
        );
        let horiz_720_av01 = compute_preview_video_score(
            "mp4",
            "av01.0.05M.08",
            Some(1280),
            Some(720),
            Some(30.0),
            Some(700.0),
        );
        let webm_720_vp9 = compute_preview_video_score(
            "webm",
            "vp9",
            Some(1280),
            Some(720),
            Some(30.0),
            Some(850.0),
        );
        let webm_1080_vp9 = compute_preview_video_score(
            "webm",
            "vp09.00.40.08",
            Some(1920),
            Some(1080),
            Some(30.0),
            Some(1400.0),
        );
        let webm_360_vp9 = compute_preview_video_score(
            "webm",
            "vp9",
            Some(640),
            Some(360),
            Some(30.0),
            Some(350.0),
        );
        let webm_720_av01 = compute_preview_video_score(
            "webm",
            "av01.0.05M.08",
            Some(1280),
            Some(720),
            Some(30.0),
            Some(700.0),
        );

        assert!(vertical_720 > 0);
        assert!(vertical_1080 > 0);
        assert!(horiz_1080_avc > 0);
        assert_eq!(vertical_720, horiz_720_avc);

        assert!(horiz_720_avc > horiz_1080_avc);
        assert!(horiz_720_avc > horiz_360_avc);
        assert!(horiz_720_avc > horiz_720_av01);

        assert!(webm_720_vp9 > webm_1080_vp9);
        assert!(webm_720_vp9 > webm_360_vp9);
        assert!(webm_720_vp9 > webm_720_av01);
    }

    #[test]
    fn test_hex_roundtrip() {
        let original = b"https://rr1---sn.googlevideo.com/videoplayback/id/123?a=1&b=2";
        let encoded = hex_encode(original);
        let decoded = hex_decode(&encoded).expect("hex decode should succeed");
        assert_eq!(decoded, original);
        assert!(hex_decode("abc").is_none());
        assert!(hex_decode("zzzz").is_none());
    }

    #[test]
    fn test_rewrite_hls_playlist() {
        let base_url = "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/123/index.m3u8";
        let yt_seg = "https://rr1---sn.googlevideo.com/videoplayback/id/abc/playlist/index.m3u8/govp/slices%3D0-739/gosq/0/file/seg.ts";
        let nested_m3u8 = "sub/media.m3u8?token=xyz";
        let init_map = "init.mp4";
        let playlist = format!(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MAP:URI=\"{init_map}\"\n#EXTINF:5.333,\n{yt_seg}\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n{nested_m3u8}\n"
        );

        let proxy_prefix = "http://127.0.0.1:9999/hls/test-id";
        let rewritten = rewrite_hls_playlist(&playlist, base_url, proxy_prefix);
        let lines: Vec<&str> = rewritten.lines().collect();

        assert_eq!(lines[0], "#EXTM3U");
        assert_eq!(lines[1], "#EXT-X-VERSION:3");

        let expected_init_hex = hex_encode(
            b"https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/123/init.mp4",
        );
        assert_eq!(
            lines[2],
            format!("#EXT-X-MAP:URI=\"{proxy_prefix}/seg.ts?u={expected_init_hex}\"")
        );

        let expected_yt_seg_hex = hex_encode(yt_seg.as_bytes());
        assert_eq!(
            lines[4],
            format!("{proxy_prefix}/seg.ts?u={expected_yt_seg_hex}")
        );

        let expected_nested_hex = hex_encode(
            b"https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/123/sub/media.m3u8?token=xyz",
        );
        assert_eq!(
            lines[6],
            format!("{proxy_prefix}/sub.m3u8?u={expected_nested_hex}")
        );
    }

    #[tokio::test]
    async fn test_read_next_progress_line_splits_cr_and_lf() {
        let input = b"frame=1 time=00:00:01.00 speed=1.5x\rframe=2 time=00:00:02.00 speed=2.0x\r\ndone\n";
        let mut reader = BufReader::new(&input[..]);
        let mut buf = Vec::new();
        let mut collected = Vec::new();
        while let Ok(Some(line)) = read_next_progress_line(&mut reader, &mut buf).await {
            collected.push(line);
        }
        assert_eq!(
            collected,
            vec![
                "frame=1 time=00:00:01.00 speed=1.5x",
                "frame=2 time=00:00:02.00 speed=2.0x",
                "done",
            ]
        );
    }

    #[test]
    fn test_parse_ffmpeg_speed() {
        assert_eq!(
            parse_ffmpeg_speed("frame=10 fps=60 time=00:00:01.00 bitrate=5000kbits/s speed= 3.45x"),
            Some("3.45x".to_string())
        );
        assert_eq!(parse_ffmpeg_speed("no speed field"), None);
    }

    #[test]
    fn test_extract_mp4_init_and_media_segments() {
        let mut blob = Vec::new();
        let make_box = |tag: &[u8; 4], payload: &[u8]| -> Vec<u8> {
            let sz = (8 + payload.len()) as u32;
            let mut b = Vec::with_capacity(sz as usize);
            b.extend_from_slice(&sz.to_be_bytes());
            b.extend_from_slice(tag);
            b.extend_from_slice(payload);
            b
        };
        let b_ftyp = make_box(b"ftyp", b"isom0000");
        let b_moov = make_box(b"moov", b"mvhd");
        let b_emsg = make_box(b"emsg", b"event");
        let b_moof = make_box(b"moof", b"mfhd");
        let b_mdat = make_box(b"mdat", b"samples");
        blob.extend_from_slice(&b_ftyp);
        blob.extend_from_slice(&b_moov);
        blob.extend_from_slice(&b_emsg);
        blob.extend_from_slice(&b_moof);
        blob.extend_from_slice(&b_mdat);

        let init = extract_mp4_init_segment(&blob);
        assert_eq!(init, [b_ftyp.as_slice(), b_moov.as_slice()].concat());

        let media = extract_mp4_media_segment(&blob);
        assert_eq!(media, [b_moof.as_slice(), b_mdat.as_slice()].concat());
    }

    #[test]
    fn test_build_dash_hls_playlist() {
        let m3u8 = build_dash_hls_playlist(3, 6.0, "http://127.0.0.1:8080/dash-hls/abc");
        assert!(m3u8.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(m3u8.contains("#EXT-X-MAP:URI=\"http://127.0.0.1:8080/dash-hls/abc/init.mp4\""));
        assert!(m3u8.contains("#EXTINF:2.000,\nhttp://127.0.0.1:8080/dash-hls/abc/seg_0.m4s"));
        assert!(m3u8.contains("http://127.0.0.1:8080/dash-hls/abc/seg_2.m4s"));
        assert!(m3u8.ends_with("#EXT-X-ENDLIST\n"));
    }

    #[test]
    fn test_append_h264_encoder_args_variants() {
        let mut nv_args = Vec::new();
        append_h264_encoder_args(&mut nv_args, HwVideoEncoder::NvidiaNvenc);
        assert!(nv_args.contains(&"h264_nvenc".to_string()));
        assert!(nv_args.contains(&"p4".to_string()));

        let mut amf_args = Vec::new();
        append_h264_encoder_args(&mut amf_args, HwVideoEncoder::AmdAmf);
        assert!(amf_args.contains(&"h264_amf".to_string()));
        assert!(amf_args.contains(&"balanced".to_string()));

        let mut cpu_args = Vec::new();
        append_h264_encoder_args(&mut cpu_args, HwVideoEncoder::CpuSoftware);
        assert!(cpu_args.contains(&"libx264".to_string()));
        assert!(cpu_args.contains(&"veryfast".to_string()));
    }

    #[test]
    fn test_append_format_args_includes_concurrency_flags() {
        let opts = ManualDownloadOptions {
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
            output_dir: ".".to_string(),
            filename_format: None,
            clip_start_index: None,
        };

        let mut full_args = Vec::new();
        append_format_and_option_args_ext(&mut full_args, &opts, false);
        assert!(full_args.contains(&"--encoding".to_string()));
        assert!(full_args.contains(&"utf-8".to_string()));
        assert!(full_args.contains(&"--concurrent-fragments".to_string()));
        assert!(full_args.contains(&"8".to_string()));
        assert!(full_args.contains(&"--http-chunk-size".to_string()));
        assert!(full_args.contains(&"10M".to_string()));

        let mut clip_args = Vec::new();
        append_format_and_option_args_ext(&mut clip_args, &opts, true);
        assert!(clip_args.contains(&"--encoding".to_string()));
        assert!(clip_args.contains(&"utf-8".to_string()));
        assert!(clip_args.contains(&"--concurrent-fragments".to_string()));
        assert!(clip_args.contains(&"8".to_string()));
        assert!(!clip_args.contains(&"--http-chunk-size".to_string()));
    }

    #[test]
    fn test_parse_mp4_init_and_sidx_v0() {
        let mut buf = Vec::new();
        // ftyp (12 bytes: 4 size + 4 tag + 4 payload)
        buf.extend_from_slice(&12u32.to_be_bytes());
        buf.extend_from_slice(b"ftypisom");
        // moov (12 bytes: 4 size + 4 tag + 4 payload)
        buf.extend_from_slice(&12u32.to_be_bytes());
        buf.extend_from_slice(b"moovmvhd");
        // sidx v0 with 2 entries: header(8) + ver/flags(4) + ref_id(4) + timescale(4) + ept(4) + first_offset(4) + reserved/count(4) + 2*12(24) = 56 bytes
        buf.extend_from_slice(&56u32.to_be_bytes());
        buf.extend_from_slice(b"sidx");
        buf.extend_from_slice(&0u32.to_be_bytes()); // version 0, flags 0
        buf.extend_from_slice(&1u32.to_be_bytes()); // reference_ID
        buf.extend_from_slice(&1000u32.to_be_bytes()); // timescale = 1000
        buf.extend_from_slice(&0u32.to_be_bytes()); // earliest_presentation_time = 0
        buf.extend_from_slice(&0u32.to_be_bytes()); // first_offset = 0
        buf.extend_from_slice(&0u16.to_be_bytes()); // reserved
        buf.extend_from_slice(&2u16.to_be_bytes()); // reference_count = 2
        // entry 0: size=50000, dur=5000 (5.0s), sap=0x90000000
        buf.extend_from_slice(&50000u32.to_be_bytes());
        buf.extend_from_slice(&5000u32.to_be_bytes());
        buf.extend_from_slice(&0x9000_0000u32.to_be_bytes());
        // entry 1: size=60000, dur=5000 (5.0s), sap=0x90000000
        buf.extend_from_slice(&60000u32.to_be_bytes());
        buf.extend_from_slice(&5000u32.to_be_bytes());
        buf.extend_from_slice(&0x9000_0000u32.to_be_bytes());

        let (init, segs, more) = parse_mp4_init_and_sidx(&buf).expect("should parse sidx");
        assert!(more.is_none());
        assert_eq!(init.len(), 24);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].byte_offset, 80);
        assert_eq!(segs[0].byte_size, 50000);
        assert!((segs[0].duration - 5.0).abs() < 1e-6);
        assert_eq!(segs[1].byte_offset, 50080);
        assert_eq!(segs[1].byte_size, 60000);
        assert!((segs[1].start_time - 5.0).abs() < 1e-6);
    }

    #[test]
    fn test_raw_video_json_cache_roundtrip() {
        let url = format!("https://example.com/watch?v={}", Uuid::new_v4());
        let payload = serde_json::json!({"id": "abc123", "title": "Test"});
        cache_raw_video_json(&[url.clone(), "abc123".to_string()], payload.clone());
        let hit = get_cached_raw_video_json(&url).expect("cache should hit");
        assert_eq!(hit["title"].as_str(), Some("Test"));
        invalidate_cached_raw_video_json(&url);
        assert!(get_cached_raw_video_json(&url).is_none());
    }

    #[test]
    fn test_sanitize_input_url() {
        assert_eq!(
            sanitize_input_url("  \"https://www.youtube.com/watch?v=r6TZVz8Z1kM\"  "),
            "https://www.youtube.com/watch?v=r6TZVz8Z1kM"
        );
        assert_eq!(
            sanitize_input_url("Mira este video <https://youtu.be/dQw4w9WgXcQ?t=12> genial"),
            "https://youtu.be/dQw4w9WgXcQ?t=12"
        );
        assert_eq!(sanitize_input_url("   "), "");
    }

    #[test]
    fn test_parse_ytdlp_json_stdout_handles_preamble() {
        let raw = b"WARNING: [youtube] Something non-fatal\n{\"id\":\"vid1\",\"title\":\"Ok\",\"formats\":[]}\n";
        let val = parse_ytdlp_json_stdout(raw).expect("should parse trailing JSON object");
        assert_eq!(val["id"].as_str(), Some("vid1"));
        assert_eq!(val["title"].as_str(), Some("Ok"));
    }

    #[test]
    fn test_extract_friendly_ytdlp_error() {
        let bot_err = "WARNING: something\nERROR: [youtube] abc: Sign in to confirm you’re not a bot.\n";
        let friendly = extract_friendly_ytdlp_error(bot_err);
        assert!(friendly.contains("verificación antibot/sesión"));

        let priv_err = "ERROR: [youtube] xyz: Private video. Sign in if you've been granted access";
        assert!(extract_friendly_ytdlp_error(priv_err).contains("privado"));

        let generic = "Traceback (most recent call last):\nERROR: [generic] Custom upstream failure";
        assert_eq!(
            extract_friendly_ytdlp_error(generic),
            "[generic] Custom upstream failure"
        );
    }

    #[test]
    fn test_select_best_resolution_prefers_direct_non_av1_over_hls() {
        let direct_h264 = StreamCandidate {
            score: 120_000,
            url: "https://direct/h264.mp4".to_string(),
            ua: "ua".to_string(),
            content_type: "video/mp4".to_string(),
            height: Some(1080),
            is_hls: false,
            is_av1: false,
        };
        let hls_h264 = StreamCandidate {
            score: 120_000,
            url: "https://hls/playlist.m3u8".to_string(),
            ua: "ua".to_string(),
            content_type: "application/vnd.apple.mpegurl".to_string(),
            height: Some(1080),
            is_hls: true,
            is_av1: false,
        };
        let direct_av1_1440 = StreamCandidate {
            score: 5_000,
            url: "https://direct/1440_av1.mp4".to_string(),
            ua: "ua".to_string(),
            content_type: "video/mp4".to_string(),
            height: Some(1440),
            is_hls: false,
            is_av1: true,
        };
        let direct_vp9_1440 = StreamCandidate {
            score: 105_000,
            url: "https://direct/1440_vp9.webm".to_string(),
            ua: "ua".to_string(),
            content_type: "video/webm".to_string(),
            height: Some(1440),
            is_hls: false,
            is_av1: false,
        };
        let hls_mp4_1440 = StreamCandidate {
            score: 5_000,
            url: "https://hls/1440.m3u8".to_string(),
            ua: "ua".to_string(),
            content_type: "application/vnd.apple.mpegurl".to_string(),
            height: Some(1440),
            is_hls: true,
            is_av1: false,
        };

        let mp4s = vec![direct_h264, hls_h264, direct_av1_1440, hls_mp4_1440];
        let webms = vec![direct_vp9_1440];

        let (best_1080, _) = select_best_resolution_candidates(&mp4s, &webms, 1080);
        assert_eq!(best_1080.unwrap().url, "https://direct/h264.mp4");

        let (best_1440, _) = select_best_resolution_candidates(&mp4s, &webms, 1440);
        assert_eq!(best_1440.unwrap().url, "https://direct/1440_vp9.webm");
    }
}

