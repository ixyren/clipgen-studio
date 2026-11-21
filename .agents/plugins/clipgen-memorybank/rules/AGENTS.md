# ClipGen Studio MemoryBank Protocol

This project maintains a persistent, structured knowledge map in `.memorybank/clipgen-studio/` exposed via the `clipgen-memorybank` MCP server (`memory_recall`, `memory_list`, `memory_search`, `memory_get`, `memory_store`, `memory_update`, `memory_delete`, `memory_stats`).

1. **Recall first:** When starting work on an unfamiliar subsystem or architectural question, call `memory_recall` or `memory_list` (namespace `clipgen-studio`) before scanning files across the repository.
2. **Keep memory current:** Whenever you add, rename, move, or remove a Tauri command, React component, event name, workflow rule, or learn a new user preference/platform gotcha, update the corresponding entry with `memory_update` (or add one via `memory_store`) in namespace `clipgen-studio`, and keep root `AGENTS.md` synchronized.
