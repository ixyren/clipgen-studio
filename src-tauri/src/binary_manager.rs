use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::models::{BinaryStatus, BinaryUpdateProgress};

const YTDLP_RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const FFMPEG_RELEASE_API: &str =
    "https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest";

const YTDLP_FALLBACK_URL: &str = if cfg!(target_os = "windows") {
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
} else if cfg!(target_os = "macos") {
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
} else {
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
};

const FFMPEG_FALLBACK_URL: &str = if cfg!(target_os = "windows") {
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
} else if cfg!(target_os = "macos") {
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz"
} else {
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz"
};

static UPDATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn update_mutex() -> &'static Mutex<()> {
    UPDATE_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct VersionsManifest {
    ytdlp_tag: Option<String>,
    ffmpeg_tag: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

/// Returns a `tokio::process::Command` configured to hide console windows on Windows.
pub fn hidden_tokio_command(program: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Returns a `std::process::Command` configured to hide console windows on Windows.
pub fn hidden_std_command(program: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn get_binaries_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let bin_dir = base.join("ClipGen").join("bin");
    let _ = fs::create_dir_all(&bin_dir);
    bin_dir
}

pub fn ytdlp_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    get_binaries_dir().join(name)
}

pub fn ffmpeg_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    get_binaries_dir().join(name)
}

pub fn ffprobe_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    get_binaries_dir().join(name)
}

fn manifest_path() -> PathBuf {
    get_binaries_dir().join("versions.json")
}

fn load_manifest() -> VersionsManifest {
    let path = manifest_path();
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_manifest(manifest: &VersionsManifest) {
    if let Ok(json) = serde_json::to_string_pretty(manifest) {
        let _ = fs::write(manifest_path(), json);
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("ClipGen-Studio/0.1.0")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))
}

async fn read_installed_ytdlp_version(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let out = hidden_tokio_command(path).arg("--version").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

async fn read_installed_ffmpeg_version(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let out = hidden_tokio_command(path).arg("-version").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first_line = text.lines().next()?.trim();
    // Example: "ffmpeg version N-123456-gabc123-20261110 Copyright ..."
    if let Some(rest) = first_line.strip_prefix("ffmpeg version ") {
        let token = rest.split_whitespace().next().unwrap_or(rest);
        Some(token.to_string())
    } else if !first_line.is_empty() {
        Some(first_line.to_string())
    } else {
        None
    }
}

fn extract_release_tag(release: &GithubRelease) -> String {
    if release.tag_name != "latest" {
        return release.tag_name.clone();
    }
    if let Some(published) = &release.published_at {
        // Use YYYY-MM-DD from ISO timestamp for stable comparison
        let date_part: String = published.chars().take(10).collect();
        if !date_part.is_empty() {
            return format!("autobuild-{date_part}");
        }
    }
    release
        .name
        .clone()
        .unwrap_or_else(|| release.tag_name.clone())
}

/// Infers `autobuild-YYYY-MM-DD` from an FFmpeg version token like `N-128911-gbcbc183264-20261114`.
fn infer_ffmpeg_autobuild_tag(version: &str) -> Option<String> {
    let last_segment = version.rsplit('-').next()?;
    if last_segment.len() == 8 && last_segment.chars().all(|c| c.is_ascii_digit()) {
        let y = &last_segment[0..4];
        let m = &last_segment[4..6];
        let d = &last_segment[6..8];
        return Some(format!("autobuild-{y}-{m}-{d}"));
    }
    None
}

async fn fetch_release(client: &reqwest::Client, url: &str) -> Result<GithubRelease, String> {
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Error consultando GitHub API ({url}): {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API devolvió estado {}", resp.status()));
    }

    resp.json::<GithubRelease>()
        .await
        .map_err(|e| format!("Error parseando respuesta de GitHub: {e}"))
}

fn emit_progress(app: &AppHandle, binary: &str, stage: &str, percent: f64, message: impl Into<String>) {
    let _ = app.emit(
        "binary-update-progress",
        BinaryUpdateProgress {
            binary: binary.to_string(),
            stage: stage.to_string(),
            percent,
            message: message.into(),
        },
    );
}

async fn download_with_progress(
    client: &reqwest::Client,
    app: &AppHandle,
    binary_label: &str,
    url: &str,
    dest_path: &Path,
    stage_msg: &str,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Error iniciando descarga de {binary_label}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Descarga fallida para {binary_label}: HTTP {}",
            resp.status()
        ));
    }

    let total = resp.content_length().unwrap_or(0);
    let tmp_path = dest_path.with_extension("part");

    let mut file = fs::File::create(&tmp_path)
        .map_err(|e| format!("No se pudo crear archivo temporal {}: {e}", tmp_path.display()))?;

    let mut downloaded: u64 = 0;
    let mut last_reported_pct: i32 = -1;
    let mut stream = resp.bytes_stream();

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Error leyendo stream de {binary_label}: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Error escribiendo {binary_label}: {e}"))?;
        downloaded += chunk.len() as u64;

        let pct = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let pct_int = pct.round() as i32;
        if pct_int >= last_reported_pct + 2 || (total == 0 && downloaded % (512 * 1024) == 0) {
            last_reported_pct = pct_int;
            let mb_done = downloaded as f64 / (1024.0 * 1024.0);
            let msg = if total > 0 {
                let mb_total = total as f64 / (1024.0 * 1024.0);
                format!("{stage_msg} ({mb_done:.1} / {mb_total:.1} MB)")
            } else {
                format!("{stage_msg} ({mb_done:.1} MB)")
            };
            emit_progress(app, binary_label, "downloading", pct, msg);
        }
    }

    file.flush()
        .map_err(|e| format!("Error finalizando escritura de {binary_label}: {e}"))?;
    drop(file);

    if dest_path.exists() {
        let _ = fs::remove_file(dest_path);
    }
    fs::rename(&tmp_path, dest_path)
        .map_err(|e| format!("No se pudo mover {} a {}: {e}", tmp_path.display(), dest_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(dest_path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(dest_path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn install_or_update_ytdlp(
    client: &reqwest::Client,
    app: &AppHandle,
    manifest: &mut VersionsManifest,
    force: bool,
) -> Result<(), String> {
    let dest = ytdlp_binary_path();
    let installed_ver = read_installed_ytdlp_version(&dest).await;
    emit_progress(app, "yt-dlp", "checking", 5.0, "Comprobando última versión de yt-dlp en GitHub...");

    let release_res = fetch_release(client, YTDLP_RELEASE_API).await;
    let (latest_tag, download_url) = match release_res {
        Ok(rel) => {
            let tag = extract_release_tag(&rel);
            let target_asset_name = if cfg!(target_os = "windows") {
                "yt-dlp.exe"
            } else if cfg!(target_os = "macos") {
                "yt-dlp_macos"
            } else {
                "yt-dlp"
            };
            let asset_url = rel
                .assets
                .into_iter()
                .find(|a| a.name == target_asset_name)
                .map(|a| a.browser_download_url)
                .unwrap_or_else(|| YTDLP_FALLBACK_URL.to_string());
            (Some(tag), asset_url)
        }
        Err(_) => (None, YTDLP_FALLBACK_URL.to_string()),
    };

    let needs_download = if !dest.exists() || installed_ver.is_none() {
        true
    } else if let Some(ref latest) = latest_tag {
        force || installed_ver.as_deref() != Some(latest.as_str())
    } else {
        force
    };

    if !needs_download {
        if let Some(ver) = &installed_ver {
            manifest.ytdlp_tag = Some(ver.clone());
        }
        emit_progress(
            app,
            "yt-dlp",
            "up_to_date",
            100.0,
            format!(
                "Tienes la última versión instalada de yt-dlp ({})",
                installed_ver.unwrap_or_default()
            ),
        );
        return Ok(());
    }

    emit_progress(
        app,
        "yt-dlp",
        "downloading",
        10.0,
        format!(
            "Descargando yt-dlp {}...",
            latest_tag.as_deref().unwrap_or("latest")
        ),
    );

    download_with_progress(
        client,
        app,
        "yt-dlp",
        &download_url,
        &dest,
        "Descargando yt-dlp",
    )
    .await?;

    let verified_ver = read_installed_ytdlp_version(&dest).await.or(latest_tag);
    manifest.ytdlp_tag = verified_ver.clone();
    emit_progress(
        app,
        "yt-dlp",
        "ready",
        100.0,
        format!("yt-dlp listo ({})", verified_ver.unwrap_or_else(|| "latest".into())),
    );

    Ok(())
}

fn extract_ffmpeg_zip_blocking(zip_path: &Path, bin_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("No se pudo abrir archivo ZIP de FFmpeg: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("ZIP de FFmpeg inválido: {e}"))?;

    let target_ffmpeg = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let target_ffprobe = if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };

    let mut found_ffmpeg = false;
    let mut found_ffprobe = false;

    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("Error leyendo entrada ZIP: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let entry_name = entry.name().replace('\\', "/");
        let file_name = entry_name.rsplit('/').next().unwrap_or("");

        let dest_name = if file_name.eq_ignore_ascii_case(target_ffmpeg) {
            found_ffmpeg = true;
            Some(target_ffmpeg)
        } else if file_name.eq_ignore_ascii_case(target_ffprobe) {
            found_ffprobe = true;
            Some(target_ffprobe)
        } else {
            None
        };

        if let Some(target_name) = dest_name {
            let final_path = bin_dir.join(target_name);
            let tmp_extract = bin_dir.join(format!("{target_name}.extracting"));
            let mut out = fs::File::create(&tmp_extract)
                .map_err(|e| format!("Error creando {}: {e}", tmp_extract.display()))?;

            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = entry
                    .read(&mut buf)
                    .map_err(|e| format!("Error descomprimiendo {target_name}: {e}"))?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])
                    .map_err(|e| format!("Error escribiendo {target_name}: {e}"))?;
            }
            out.flush().map_err(|e| e.to_string())?;
            drop(out);

            if final_path.exists() {
                let _ = fs::remove_file(&final_path);
            }
            fs::rename(&tmp_extract, &final_path)
                .map_err(|e| format!("Error moviendo {target_name}: {e}"))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&final_path)
                    .map_err(|e| e.to_string())?
                    .permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&final_path, perms).map_err(|e| e.to_string())?;
            }
        }
    }

    if !found_ffmpeg || !found_ffprobe {
        return Err("El paquete de FFmpeg descargado no contenía ffmpeg y ffprobe.".to_string());
    }

    Ok(())
}

async fn install_or_update_ffmpeg(
    client: &reqwest::Client,
    app: &AppHandle,
    manifest: &mut VersionsManifest,
    force: bool,
) -> Result<(), String> {
    let ffmpeg_dest = ffmpeg_binary_path();
    let ffprobe_dest = ffprobe_binary_path();
    let installed_ok = ffmpeg_dest.exists() && ffprobe_dest.exists();

    emit_progress(
        app,
        "ffmpeg",
        "checking",
        5.0,
        "Comprobando última versión de FFmpeg en GitHub...",
    );

    let release_res = fetch_release(client, FFMPEG_RELEASE_API).await;
    let (latest_tag, download_url) = match release_res {
        Ok(rel) => {
            let tag = extract_release_tag(&rel);
            let preferred_asset = if cfg!(target_os = "windows") {
                "ffmpeg-master-latest-win64-gpl.zip"
            } else {
                "ffmpeg-master-latest-linux64-gpl.tar.xz"
            };
            let asset_url = rel
                .assets
                .into_iter()
                .find(|a| a.name == preferred_asset)
                .map(|a| a.browser_download_url)
                .unwrap_or_else(|| FFMPEG_FALLBACK_URL.to_string());
            (Some(tag), asset_url)
        }
        Err(_) => (None, FFMPEG_FALLBACK_URL.to_string()),
    };

    let installed_ver = if installed_ok {
        read_installed_ffmpeg_version(&ffmpeg_dest).await
    } else {
        None
    };
    let effective_tag = manifest
        .ffmpeg_tag
        .clone()
        .or_else(|| installed_ver.as_deref().and_then(infer_ffmpeg_autobuild_tag));

    let needs_download = if !installed_ok {
        true
    } else if let Some(ref latest) = latest_tag {
        force || effective_tag.as_deref() != Some(latest.as_str())
    } else {
        force
    };

    if !needs_download {
        if manifest.ffmpeg_tag.is_none() {
            manifest.ffmpeg_tag = effective_tag;
        }
        emit_progress(
            app,
            "ffmpeg",
            "up_to_date",
            100.0,
            format!(
                "Tienes la última versión instalada de FFmpeg ({})",
                installed_ver.unwrap_or_default()
            ),
        );
        return Ok(());
    }

    let bin_dir = get_binaries_dir();
    let zip_path = bin_dir.join("ffmpeg-download.zip");

    emit_progress(
        app,
        "ffmpeg",
        "downloading",
        10.0,
        "Descargando paquete FFmpeg + FFprobe...",
    );

    download_with_progress(
        client,
        app,
        "ffmpeg",
        &download_url,
        &zip_path,
        "Descargando FFmpeg",
    )
    .await?;

    emit_progress(
        app,
        "ffmpeg",
        "extracting",
        92.0,
        "Extrayendo ffmpeg.exe y ffprobe.exe...",
    );

    let zip_clone = zip_path.clone();
    let bin_clone = bin_dir.clone();
    tokio::task::spawn_blocking(move || extract_ffmpeg_zip_blocking(&zip_clone, &bin_clone))
        .await
        .map_err(|e| format!("Fallo en tarea de extracción: {e}"))??;

    let _ = fs::remove_file(&zip_path);

    manifest.ffmpeg_tag = latest_tag.or_else(|| read_installed_ffmpeg_version_sync(&ffmpeg_dest));
    let ver = read_installed_ffmpeg_version(&ffmpeg_dest).await;

    emit_progress(
        app,
        "ffmpeg",
        "ready",
        100.0,
        format!("FFmpeg listo ({})", ver.unwrap_or_else(|| "latest".into())),
    );

    Ok(())
}

fn read_installed_ffmpeg_version_sync(path: &Path) -> Option<String> {
    let out = hidden_std_command(path).arg("-version").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    line.strip_prefix("ffmpeg version ")
        .and_then(|r| r.split_whitespace().next())
        .map(String::from)
}

#[tauri::command]
pub async fn check_binaries_status() -> Result<BinaryStatus, String> {
    let ytdlp_path = ytdlp_binary_path();
    let ffmpeg_path = ffmpeg_binary_path();
    let ffprobe_path = ffprobe_binary_path();

    let ytdlp_installed = ytdlp_path.exists();
    let ffmpeg_installed = ffmpeg_path.exists() && ffprobe_path.exists();

    let ytdlp_version = read_installed_ytdlp_version(&ytdlp_path).await;
    let ffmpeg_version = read_installed_ffmpeg_version(&ffmpeg_path).await;
    let mut manifest = load_manifest();
    let mut manifest_dirty = false;

    if manifest.ytdlp_tag.is_none() {
        if let Some(ref ver) = ytdlp_version {
            manifest.ytdlp_tag = Some(ver.clone());
            manifest_dirty = true;
        }
    }

    let effective_ffmpeg_tag = manifest
        .ffmpeg_tag
        .clone()
        .or_else(|| ffmpeg_version.as_deref().and_then(infer_ffmpeg_autobuild_tag));
    if manifest.ffmpeg_tag.is_none() {
        if let Some(ref tag) = effective_ffmpeg_tag {
            manifest.ffmpeg_tag = Some(tag.clone());
            manifest_dirty = true;
        }
    }
    if manifest_dirty {
        save_manifest(&manifest);
    }

    let client = build_http_client()?;
    let (ytdlp_rel, ffmpeg_rel) = tokio::join!(
        fetch_release(&client, YTDLP_RELEASE_API),
        fetch_release(&client, FFMPEG_RELEASE_API)
    );

    let ytdlp_latest = ytdlp_rel.ok().map(|r| extract_release_tag(&r));
    let ffmpeg_latest = ffmpeg_rel.ok().map(|r| extract_release_tag(&r));

    let ytdlp_update_available = if !ytdlp_installed || ytdlp_version.is_none() {
        true
    } else {
        match (&ytdlp_version, &ytdlp_latest) {
            (Some(cur), Some(lat)) => cur != lat,
            _ => false,
        }
    };

    let ffmpeg_update_available = if !ffmpeg_installed {
        true
    } else {
        match (&effective_ffmpeg_tag, &ffmpeg_latest) {
            (Some(cur), Some(lat)) => cur != lat,
            (None, Some(_)) => true,
            _ => false,
        }
    };

    Ok(BinaryStatus {
        ytdlp_installed,
        ytdlp_version,
        ytdlp_latest,
        ytdlp_update_available,
        ytdlp_path: ytdlp_path.to_string_lossy().to_string(),
        ffmpeg_installed,
        ffmpeg_version,
        ffmpeg_latest,
        ffmpeg_update_available,
        ffmpeg_path: ffmpeg_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn ensure_and_update_binaries(
    app: AppHandle,
    force: bool,
) -> Result<BinaryStatus, String> {
    let _guard = update_mutex().lock().await;
    let client = build_http_client()?;
    let mut manifest = load_manifest();

    if let Err(err) = install_or_update_ytdlp(&client, &app, &mut manifest, force).await {
        emit_progress(&app, "yt-dlp", "error", 0.0, err.clone());
        if !ytdlp_binary_path().exists() {
            save_manifest(&manifest);
            return Err(err);
        }
    }

    if let Err(err) = install_or_update_ffmpeg(&client, &app, &mut manifest, force).await {
        emit_progress(&app, "ffmpeg", "error", 0.0, err.clone());
        if !ffmpeg_binary_path().exists() {
            save_manifest(&manifest);
            return Err(err);
        }
    }

    save_manifest(&manifest);
    check_binaries_status().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_release_tag() {
        let ytdlp_rel = GithubRelease {
            tag_name: "2026.11.10".to_string(),
            name: Some("yt-dlp 2026.11.10".to_string()),
            published_at: Some("2026-11-10T10:00:00Z".to_string()),
            assets: vec![],
        };
        assert_eq!(extract_release_tag(&ytdlp_rel), "2026.11.10");

        let ffmpeg_rel = GithubRelease {
            tag_name: "latest".to_string(),
            name: Some("Auto-Build 2026-11-12".to_string()),
            published_at: Some("2026-11-12T04:12:00Z".to_string()),
            assets: vec![],
        };
        assert_eq!(extract_release_tag(&ffmpeg_rel), "autobuild-2026-11-12");
        assert_eq!(
            infer_ffmpeg_autobuild_tag("N-128911-gbcbc183264-20261114"),
            Some("autobuild-2026-11-14".to_string())
        );
        assert_eq!(infer_ffmpeg_autobuild_tag("7.1"), None);
    }
}

