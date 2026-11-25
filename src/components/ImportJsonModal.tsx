import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileJson,
  Upload,
  ClipboardPaste,
  Check,
  AlertCircle,
  X,
  Sparkles,
} from "lucide-react";
import { parseClipGenJson, type ParsedClip } from "../utils/jsonParser";
import { Tooltip } from "./Tooltip";

interface ImportJsonModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (
    streamUrl: string | null,
    clips: ParsedClip[],
    replace: boolean
  ) => void;
  onCopyAiPrompt: () => void;
}

export const ImportJsonModal: React.FC<ImportJsonModalProps> = ({
  isOpen,
  onClose,
  onImport,
  onCopyAiPrompt,
}) => {
  const [jsonText, setJsonText] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setJsonText(content);
        setValidationError(null);
      }
    };
    reader.onerror = () => {
      setValidationError("No se pudo leer el archivo seleccionado.");
    };
    reader.readAsText(file);
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setJsonText(text.trim());
        setValidationError(null);
      }
    } catch {
      setValidationError("No se pudo acceder al portapapeles. Pega el texto manualmente.");
    }
  };

  const handleCopyPrompt = () => {
    onCopyAiPrompt();
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const handleValidateAndImport = () => {
    const res = parseClipGenJson(jsonText);
    if (!res.success) {
      setValidationError(res.error || "Error al procesar el JSON.");
      return;
    }

    onImport(res.streamUrl, res.clips, replaceExisting);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 select-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="relative z-10 flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-white/10 bg-[#111114] shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#18181C]/70 px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
                  <FileJson className="h-4 w-4" />
                </div>
                <h3 className="text-sm font-bold text-white">Importar JSON</h3>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white smooth-btn"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3.5 custom-scrollbar text-xs">
              {/* Quick action bar */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Tooltip content="Cargar clips desde un archivo .json local">
                    <label className="flex items-center gap-1.5 cursor-pointer rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium text-slate-200 hover:bg-white/10 smooth-btn">
                      <Upload className="h-3.5 w-3.5 text-indigo-400" />
                      <span>Archivo .json</span>
                      <input
                        type="file"
                        accept=".json"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                  </Tooltip>

                  <Tooltip content="Pegar bloque JSON desde el portapapeles">
                    <button
                      type="button"
                      onClick={handlePasteClipboard}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium text-slate-200 hover:bg-white/10 smooth-btn"
                    >
                      <ClipboardPaste className="h-3.5 w-3.5 text-indigo-400" />
                      <span>Pegar</span>
                    </button>
                  </Tooltip>
                </div>

                <Tooltip content="Copiar plantilla de prompt para ChatGPT, Claude o Gemini">
                  <button
                    type="button"
                    onClick={handleCopyPrompt}
                    className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1.5 font-medium text-indigo-300 hover:bg-indigo-500/20 smooth-btn shrink-0"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                    <span>{copiedPrompt ? "¡Copiado!" : "Prompt IA"}</span>
                  </button>
                </Tooltip>
              </div>

              {/* JSON Textarea */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>Contenido JSON</span>
                  <span className="font-mono text-[10px] text-slate-500">
                    {"{ stream_url?, clips: [...] }"}
                  </span>
                </div>
                <textarea
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    if (validationError) setValidationError(null);
                  }}
                  placeholder={`{\n  "stream_url": "https://www.youtube.com/watch?v=...",\n  "clips": [\n    {\n      "title": "Intro épica",\n      "start": 120,\n      "end": 185\n    }\n  ]\n}`}
                  className="h-52 w-full rounded-xl border border-white/10 bg-[#09090B] p-3 font-mono text-[11px] text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500/60 transition resize-none custom-scrollbar select-text"
                />
              </div>

              {/* Validation Error Banner */}
              {validationError && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-rose-300"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
                  <span className="text-[11px] leading-relaxed">
                    {validationError}
                  </span>
                </motion.div>
              )}

              {/* Mode selection toggle */}
              <Tooltip content="Si se activa, borra la cola actual antes de importar">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={replaceExisting}
                    onChange={(e) => setReplaceExisting(e.target.checked)}
                    className="accent-indigo-500 rounded border-white/20 bg-white/5"
                  />
                  <span className="text-slate-300">Reemplazar cola actual</span>
                </label>
              </Tooltip>
            </div>

            {/* Footer Actions */}
            <div className="flex items-center justify-end gap-2 border-t border-white/10 bg-[#18181C]/70 px-5 py-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-1.5 font-medium text-slate-300 hover:bg-white/10 hover:text-white smooth-btn"
              >
                Cancelar
              </button>

              <button
                type="button"
                onClick={handleValidateAndImport}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 font-semibold text-white shadow-lg shadow-indigo-500/25 hover:bg-indigo-500 smooth-btn"
              >
                <Check className="h-4 w-4" />
                <span>Importar</span>
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
