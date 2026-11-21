---
id: dc19cfdb20ef
name: windows-tauri-gotchas-and-preferences
type: feedback
description: Platform-specific Windows/WebView2/Tauri constraints and user workflow preferences verified in ClipGen Studio.
created: 2026-11-21T19:47:57.024Z
updated: 2026-11-21T19:49:04.710Z
tags: [windows, tauri, gotchas, preferences]
---

# Windows, Tauri & User Workflow Gotchas

- Always use `npm.cmd` (never bare `npm`) in Windows PowerShell.
- WebView2 ignores `<a download>` on `blob:` URLs; always use `rfd::AsyncFileDialog` in Rust (`pick_download_folder`, `save_transcription_txt`).
- On Windows Python defaults to `cp1252`; always pass `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` when spawning Python subprocesses so emoji/UTF-8 logs never fail with `UnicodeEncodeError`.
- Spawn external CLI tools (`yt-dlp`, `ffmpeg`, `python`) via `hidden_std_command` / `hidden_tokio_command` (`CREATE_NO_WINDOW`) in `src-tauri/src/binary_manager.rs` so terminal windows never flash.
- Root `package.json` uses `"type": "module"`, so custom CommonJS helper/MCP scripts inside the repo must end in `.cjs`.
- User preference: never rescan the whole repository when grounded context already exists; consult `AGENTS.md` and `clipgen-memorybank` first, go straight to the target symbol, and reply concisely in Spanish with clickable `file://` links.