# AGENTS.md — ClipGen Studio Architecture & Fast-Navigation Map

> **Mandatory workflow rule:** Do **NOT** re-scan the repository or read unrelated files at the start of a task. Jump directly to the file and symbol listed in this map, read only the relevant slice, make the edit, and verify with the build/test commands below. Whenever you add, rename, move, or remove a command, component, event, or key behavior, update this file in the same turn.

---

## 1. Build, Test & Packaging (Windows PowerShell)

Working directory: repo root (`clipgen_ui_redesign/`). Always use **`npm.cmd`** (not `npm`) in PowerShell.

| Check | Command | Notes |
|---|---|---|
| Frontend typecheck + bundle | `npm.cmd run build` | Runs `tsc && vite build` → `dist/` |
| Rust unit tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --skip e2e_verify` | Runs offline lib tests (`models`, `clipper`, `ytdlp`, `binary_manager`) |
| Full Tauri release installers | `npm.cmd run tauri build` | Builds `src-tauri/target/release/clipgen-studio.exe`, NSIS `.exe` (`src-tauri/target/release/bundle/nsis/ClipGen Studio_<version>_x64-setup.exe`), and MSI `.msi` (`src-tauri/target/release/bundle/msi/ClipGen Studio_<version>_x64_en-US.msi`) |

### Versioning & GitHub Release Workflow (Mandatory)
- **Every change or fix bumps version sequentially:** Synchronize the semver string (currently `0.2.1`) across `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and version badges in `TitleBar.tsx` / `SettingsModal.tsx`.
- **Always push & publish to GitHub Releases:** Verify with `npm.cmd run build` + `cargo test`, compile release installers with `npm.cmd run tauri build`, commit and push to `origin clipgen_ui_redesign:main`, and publish a matching tagged release (`gh release create vX.Y.Z ...` with the `.exe` and `.msi` assets).

### Platform & Runtime Gotchas
- **File dialogs in Tauri WebView2:** `<a download>` on `blob:` URLs fails silently inside WebView2. Always use `rfd::AsyncFileDialog` from Rust (`pick_download_folder`, `save_transcription_txt`).
- **Python UTF-8 on Windows:** Spawn Python with `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` (`src-tauri/src/transcription.rs`) so emoji/Unicode in transcripts or progress JSON never raises `cp1252` `UnicodeEncodeError`.
- **Subprocess stdio/console windows:** Spawn `yt-dlp`, `ffmpeg`, and `python` via `hidden_std_command` / `hidden_tokio_command` (`src-tauri/src/binary_manager.rs`) so no console windows flash.
- **Tauri embed vs active script:** `src-tauri/scripts/transcribe_audio.py` is embedded into Rust at compile time via `include_str!("../scripts/transcribe_audio.py")`, so changes to the Python script require rebuilding Rust (`tauri build` / `cargo build`).

---

## 2. Frontend Map (`src/`)

Active application tree (`index.html` → `src/main.tsx` → `src/App.tsx`):

| File | Responsibility & Key Symbols |
|---|---|
| `src/index.css` & `src/assets/fonts/` | Global dark-studio styling and bundled variable Google Sans `.ttf` fonts (`GoogleSans-Variable.ttf` normal & `GoogleSans-Italic-Variable.ttf` italic) registered via `@font-face` and Tailwind v4 `@theme` (`--font-sans`, `--font-serif`, `--font-mono`). |
| `src/App.tsx` | Root coordinator & state (`url`, `metadata`, `activeStart`/`activeEnd`, `savedClips`, `selectedClipIds`, `clipStartIndex`, `options`, `jobs`). Key helpers: `matchesMetadataVideo`, `isUrlMatchingMetadata`, `buildBatchRequests`, `handleAnalyze`, `handleAddClip(name, start, end, insertAtNumber?)`, `handleMoveClip`, `handleMoveClipToNumber`, `handleExportSelected`, `handleDismissJob`, `handleExportQualityPresetChange`, `handlePickFolder`, `handleImportJson`, `handleDirectPasteJson`, `AI_PROMPT_TEMPLATE`. LocalStorage keys: `clipgen_output_dir`, `clipgen_start_index`. |
| `src/components/Tooltip.tsx` | Reusable React Portal (`document.body`) Framer Motion tooltip with viewport edge clamping and zero `overflow-hidden` clipping across all panels and modals. |
| `src/components/TitleBar.tsx` | Custom frameless window bar (`app_minimize`, `app_toggle_maximize`, `app_is_maximized`, `app_close`, `app_start_dragging`), version badge (`v0.2.1`), URL input + **Pegar** + **Cargar**, **Transcribir** (`onOpenTranscription`), **Prompt IA** (with copy confirmation), and unified **Ajustes** button with live engine status dot. |
| `src/components/VisorPanel.tsx` | Left panel (70%): `hls.js` + `<video>` + `<audio>` sync (`syncMediaSettings`, `playbackRateRef`, stall-recovery watchdog) + YouTube embed fallback; top HUD (`MP4 / WebM / Embed` + audio tracks); bottom transport bar with `selectedResolution` switcher; 3-zone NLE timeline with window-level drag & `Alt` fine-tuning; compact zoom/pan toolbar (`Centrar`, `Seguir`, `Ajustar`); `#clip-position-input`, `#clip-name-input`, `[ I ]` / `[ O ]` / `Añadir`, keyboard shortcuts. |
| `src/components/ClipQueuePanel.tsx` | Right panel (30%): `viewScope` (`"current"` / `"all"`), collapsible `Lote y Márgenes` accordion (`clipStartIndex`, `marginBefore`, `marginAfter`), clickable `#displayNum` badge (`onMoveClipToNumber`), per-clip expandable quick time adjustments (`expandedAdjustId`), compact footer (resolution preset, `Limpio / Con Título`, folder picker/opener), and dismissible export status banner (`onDismissJob`) stacked above the always-ready `Exportar Seleccionados` CTA. |
| `src/components/TranscriptionModal.tsx` | Transcription UI: editable `targetUrl` + **Pegar** + `Otra URL`, scope (`full` vs `range` when `targetMatchesLoaded`), language (`es`/`auto`/`en`), Whisper model (`small`/`medium`), emotion toggle, live progress + log stream, **Cancelar**, completed metadata card (`Título:` + `URL:`), **Guardar .txt** (`save_transcription_txt`), **Copiar Texto**, **Copiar para IA** (`--clipgen\nTítulo: ...\nURL: ...\n\n<formatted_text>`). |
| `src/components/SettingsModal.tsx` | Engine update UI + manual `ManualDownloadOptions` settings modal. |
| `src/components/ImportJsonModal.tsx` | Manual JSON file/paste importer modal. |
| `src/components/PasteConfirmModal.tsx` | Confirmation dialog after `handleDirectPasteJson`. |
| `src/types.ts` | TS interfaces mirroring Rust DTOs (`BinaryStatus`, `VideoMetadata`, `PreviewResolutionOption`, `AudioTrackOption`, `ClipSegment`, `SavedClipEntry`, `ManualDownloadOptions`, `ClipExportRequest`, `JobProgressEvent`, `JobState`). |
| `src/utils/time.ts` | `formatTimecode`, `formatTimeShort`, `parseTimecode`, `parseFlexibleTimestamp`, `cleanClipTitle` (strips leading numbering so numbering stays decoupled from title). |
| `src/utils/jsonParser.ts` | `parseClipGenJson` for importing AI-generated JSON clip blocks. |

### Unused Legacy Files (Do NOT Read Unless Refactoring/Removing)
- `src/components/ClipListManager.tsx`
- `src/components/DownloadOptionsPanel.tsx`
- `src/components/HeaderStatus.tsx`
- `src/components/JobQueueDrawer.tsx`
- `src/components/UrlAnalyzer.tsx`
- `src/components/VideoPreviewStudio.tsx`

---

## 3. Backend Map (`src-tauri/src/` & `src-tauri/scripts/`)

| File | Responsibility & Exports |
|---|---|
| `src-tauri/src/lib.rs` | App builder, `tauri::generate_handler![...]` registry, and window commands (`app_minimize`, `app_toggle_maximize`, `app_is_maximized`, `app_close`, `app_start_dragging`). |
| `src-tauri/src/models.rs` | Shared serde models (`ManualDownloadOptions`, `ClipExportRequest`, `SavedClipEntry`, `TranscriptionSegment`, `TranscriptionResult`, `TranscriptionProgressEvent`, etc.) + `format_timestamp`, `sanitize_filename`, `split_shell_args`. |
| `src-tauri/src/binary_manager.rs` | Binary paths (`get_binaries_dir`, `ytdlp_binary_path`, `ffmpeg_binary_path`), `hidden_std_command`, `hidden_tokio_command`. Commands: `check_binaries_status`, `ensure_and_update_binaries`. Event: `binary-update-progress`. |
| `src-tauri/src/ytdlp.rs` | Metadata extraction, format selection, local preview HTTP `/stream/` proxy (`proxy_http_client`, 12s upstream/stream chunk timeouts & byte-range retries), raw JSON cache (`get_cached_raw_video_json`, `invalidate_cached_raw_video_json`), progress parsers (`read_next_progress_line`, `parse_ffmpeg_time_secs`, `parse_ffmpeg_speed`). Commands: `fetch_video_info`, `start_full_download`, `cancel_job`. Helpers: `sanitize_input_url`, `parse_ytdlp_json_stdout`, `extract_friendly_ytdlp_error`, `register_candidate_stream`. Events: `job-progress`, `video-load-progress`. |
| `src-tauri/src/clipper.rs` | Clip download/cut/merge pipeline & persistence (`persistent_clips_path` → `<binaries_parent>/saved_clips.json`). Commands: `export_clips`, `export_clips_batch`, `load_persistent_clips`, `save_persistent_clips`, `get_persistent_clips_file_path`, `get_default_download_dir`, `open_output_folder`, `pick_download_folder`. |
| `src-tauri/src/transcription.rs` | Audio acquisition (FFmpeg fast-path range extraction or `yt-dlp` direct HTTPS audio selector with `--no-simulate --print before_dl:__CLIPGEN_TITLE__:%(title)s`), Python runner, native `.txt` save dialog. Commands: `start_transcription`, `cancel_transcription`, `save_transcription_txt`. Event: `transcription-progress`. |
| `src-tauri/scripts/transcribe_audio.py` | Local transcription & paralinguistic pipeline: Faster-Whisper (`BatchedInferencePipeline`), RMS dBFS `[PICO DE AUDIO]`, `sherpa-onnx` CED-Mini vocal events (`[RISA]`, `[SUSPIRO]`, `[GRITO]`, etc.), `emotion2vec_plus_large.onnx` SER (`[RABIA]`, `[ALEGRÍA]`, etc.). |

---

## 4. Feature-to-File Quick Lookup

| Need to change... | Go straight to... |
|---|---|
| Timeline NLE lanes / snapping / stalls / speed sync | `src/components/VisorPanel.tsx` (`beginTimelineDrag`, `syncMediaSettings`, stall watchdog), `src-tauri/src/ytdlp.rs` (`proxy_http_client`, `/stream/` chunk retry) |
| Custom clip insertion `#` or renumbering offset | `src/components/VisorPanel.tsx` (`clipNumberInput`, `handleAddCurrentClip`), `src/components/ClipQueuePanel.tsx` (`clipStartIndex`, `movingNumberId`), `src/App.tsx` (`handleAddClip`, `handleMoveClipToNumber`), `src-tauri/src/clipper.rs` (`clip_start_index` export naming) |
| Persistent clip queue & "Video Actual / Todos en cola" scope | `src/components/ClipQueuePanel.tsx` (`viewScope`, `hasLoadedVideo`, `visibleClips`), `src/App.tsx` (`clipsLoaded`, `handleSelectAll`, `currentVideoUrl`), `src-tauri/src/clipper.rs` (`load_persistent_clips`, `save_persistent_clips`) |
| Export resolution or quality presets | `src/components/ClipQueuePanel.tsx` (`qualityPreset`), `src/App.tsx` (`handleExportQualityPresetChange`, `buildBatchRequests`), `src-tauri/src/ytdlp.rs` / `src-tauri/src/clipper.rs` |
| Folder selector / default download dir | `src/App.tsx` (`handlePickFolder`, `handleOpenFolder`), `src-tauri/src/clipper.rs` (`pick_download_folder`, `get_default_download_dir`, `open_output_folder`) |
| Transcription URL selection, `.txt` export, `--clipgen` copy | `src/components/TranscriptionModal.tsx` (`targetUrl`, `buildTxtContent`, `buildAiCopyContent`, `handleSaveTxt`), `src/App.tsx` (`isUrlMatchingMetadata`), `src-tauri/src/transcription.rs` (`save_transcription_txt`, `start_transcription`) |
| Transcription audio download speed, progress, or emotions | `src-tauri/src/transcription.rs`, `src-tauri/scripts/transcribe_audio.py` |
| Persistent project memory / decisions (`@ura-dev/memorybank`) | `.agents/plugins/clipgen-memorybank/` (MCP `clipgen-memorybank`), `.memorybank/clipgen-studio/` |

---

## 5. Persistent Cross-Session Memory (`ura-tools/memorybank`)

- **Workspace MCP Plugin:** `.agents/plugins/clipgen-memorybank/` (`plugin.json`, `mcp_config.json`, `mcp-server.cjs`, `cli.cjs`, `rules/AGENTS.md`) exposes the `clipgen-memorybank` MCP server (`memory_recall`, `memory_list`, `memory_search`, `memory_get`, `memory_store`, `memory_update`, `memory_delete`, `memory_stats`).
- **Local Storage:** `.memorybank/clipgen-studio/` (`index.json` + Markdown memories with YAML frontmatter).
- **CLI Usage:** `npm.cmd run memorybank -- <stats|list|recall|search|store>` (defaults `--namespace=clipgen-studio`).
