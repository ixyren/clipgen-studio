mod binary_manager;
mod clipper;
mod models;
mod transcription;
mod ytdlp;

#[tauri::command]
fn app_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn app_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn app_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
fn app_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn app_start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_minimize,
            app_toggle_maximize,
            app_is_maximized,
            app_close,
            app_start_dragging,
            binary_manager::check_binaries_status,
            binary_manager::ensure_and_update_binaries,
            ytdlp::fetch_video_info,
            ytdlp::start_full_download,
            ytdlp::cancel_job,
            clipper::export_clips,
            clipper::export_clips_batch,
            clipper::load_persistent_clips,
            clipper::save_persistent_clips,
            clipper::get_persistent_clips_file_path,
            clipper::get_default_download_dir,
            clipper::open_output_folder,
            clipper::pick_download_folder,
            transcription::start_transcription,
            transcription::cancel_transcription,
            transcription::save_transcription_txt,
        ])
        .run(tauri::generate_context!())
        .expect("Error ejecutando ClipGen Studio");
}
