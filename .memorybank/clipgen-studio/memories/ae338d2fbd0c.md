---
id: ae338d2fbd0c
name: architecture-overview
type: project
description: High-level tech stack, directory structure, entry chain, and runtime architecture of ClipGen Studio.
created: 2026-11-21T19:47:57.017Z
updated: 2026-11-21T19:49:04.702Z
tags: [architecture, stack, overview]
---

# ClipGen Studio Architecture Overview

- Stack: Tauri 2 desktop app (`src-tauri/`) + React 19 + TypeScript + Vite 6 + Tailwind CSS v4 + Framer Motion + hls.js + lucide-react (`src/`).
- External runtime engines managed in binaries dir: `yt-dlp`, `ffmpeg`/`ffprobe`, plus local Python 3.11 AI pipeline (`src-tauri/scripts/transcribe_audio.py`).
- Frontend entry chain: `index.html` -> `src/main.tsx` -> `src/App.tsx`.
- Main layout: Custom frameless `TitleBar` (top) -> 70% `VisorPanel` (left preview + NLE timeline) / 30% `ClipQueuePanel` (right clip list + export).
- Modals: `TranscriptionModal`, `SettingsModal`, `ImportJsonModal`, `PasteConfirmModal`.
- Rust entry: `src-tauri/src/main.rs` -> `src-tauri/src/lib.rs` (command registry in `tauri::generate_handler![]`).
- Rust crate deps (`src-tauri/Cargo.toml`): `tauri 2`, `tokio` (full), `reqwest 0.12` (rustls-tls, json, stream), `serde`/`serde_json`, `rfd 0.15`, `dirs 5`, `zip 2.2`, `regex 1`, `uuid`.
- Persistent app data: clip queue in `<binaries_parent>/saved_clips.json` (`clipper::persistent_clips_path`), `output_dir` in `localStorage("clipgen_output_dir")`, start numbering index in `localStorage("clipgen_start_index")`.