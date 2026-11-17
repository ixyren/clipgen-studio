# ClipGen Studio 🎬⚡

ClipGen Studio es una aplicación de escritorio de alto rendimiento diseñada para extraer, procesar y gestionar clips de videos de YouTube con máxima velocidad y calidad, construida con **Tauri 2**, **Rust**, **React** y **TypeScript**.

---

## ✨ Características Principales

- **Descargas Ultra-Rápidas**:
  - Motor de descarga directa DASH/SIDX con peticiones HTTP Range en paralelo (bloques de 4MB, alta concurrencia).
  - Extrae únicamente los fragmentos necesarios del video sin descargar archivos completos innecesariamente.
- **Aceleración por Hardware (GPU)**:
  - Compatibilidad nativa con **NVIDIA NVENC** (`h264_nvenc`).
  - Compatibilidad nativa con **AMD AMF** (`h264_amf`).
  - Fallback automático e inteligente a CPU (`libx264`) si la GPU no está disponible.
- **Modo Stream Copy (`-c copy`)**:
  - Cuando el corte preciso está desactivado y se mantienen los FPS nativos, la extracción se realiza sin recodificar en milisegundos y con cero pérdida de calidad.
- **Gestión y Persistencia de Clips**:
  - Cola de trabajo persistente en disco (`saved_clips.json`). Puedes agregar clips de múltiples videos a lo largo del tiempo y exportarlos todos en lote en cualquier momento.
- **Gestión Automática de Binarios**:
  - Descarga e instalación autónoma de las versiones más recientes de `yt-dlp` y `ffmpeg` en el directorio de datos de la aplicación.
- **Estudio de Previsualización**:
  - Reproductor interactivo con control de volumen, selección de rangos con precisión milimétrica, selector de resolución (1080p, 720p, 480p, etc.) y selector de FPS (60, 30, nativo).

---

## 🛠️ Tecnologías

- **Frontend**: React 19, TypeScript, Tailwind CSS, Lucide Icons, Vite.
- **Backend**: Rust, Tauri v2.
- **Herramientas de Video**: `yt-dlp`, `ffmpeg`, `ffprobe`.

---

## 🚀 Instalación y Desarrollo

### Requisitos Previos

1. [Node.js](https://nodejs.org/) (v18 o superior).
2. [Rust](https://rustup.rs/) (v1.75 o superior con `cargo`).
3. Herramientas de compilación de C++ (Visual Studio Build Tools en Windows con soporte de C++).

### Pasos

1. Clonar el repositorio:
   ```bash
   git clone https://github.com/TU_USUARIO/clipgen-studio.git
   cd clipgen-studio
   ```

2. Instalar dependencias de frontend:
   ```bash
   npm install
   ```

3. Ejecutar en modo desarrollo:
   ```bash
   npm run tauri dev
   ```

4. Compilar instalador para producción:
   ```bash
   npm run tauri build
   ```
   El instalador ejecutable (`.exe`) se generará en `src-tauri/target/release/bundle/nsis/`.

---

## 📄 Licencia

Este proyecto está bajo la licencia MIT.
