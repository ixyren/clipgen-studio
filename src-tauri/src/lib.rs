mod binary_manager;
mod clipper;
mod models;
mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("Error ejecutando ClipGen Studio");
}
