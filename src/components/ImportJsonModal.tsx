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

  if (!isOpen) return null;

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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm select-none">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="relative flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-white/10 bg-[#111114] shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 bg-[#18181C]/70 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
                <FileJson className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">
                  Importar Clips desde Archivo JSON
                </h3>
                <p className="text-[11px] text-slate-400">
                  Carga un archivo .json o pega el texto para revisar y editar
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar text-xs">
            {/* Quick action bar */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 cursor-pointer rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium text-slate-200 hover:bg-white/10 transition">
                  <Upload className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Subir archivo .json</span>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={handlePasteClipboard}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium text-slate-200 hover:bg-white/10 transition"
                >
                  <ClipboardPaste className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Pegar portapapeles</span>
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopyPrompt}
                title="Copiar prompt maestro para ChatGPT, Claude o Gemini"
                className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1.5 font-medium text-indigo-300 hover:bg-indigo-500/20 transition shrink-0"
              >
                <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                <span>{copiedPrompt ? "¡Prompt Copiado!" : "Copiar prompt IA"}</span>
              </button>
            </div>

            {/* JSON Textarea */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Estructura JSON:</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {"{ stream_url?: string, clips: [...] }"}
                </span>
              </div>
              <textarea
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                placeholder={`{\n  "stream_url": "https://www.youtube.com/watch?v=...",\n  "clips": [\n    {\n      "title": "Intro épica",\n      "start": 120,\n      "end": 185\n    }\n  ]\n}`}
                className="h-56 w-full rounded-xl border border-white/10 bg-[#09090B] p-3 font-mono text-[11px] text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500/60 transition resize-none custom-scrollbar"
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

            {/* Mode selection toggle: Replace vs Append */}
            <div className="flex items-center gap-3 pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(e) => setReplaceExisting(e.target.checked)}
                  className="rounded border-white/20 bg-white/5 text-indigo-600 focus:ring-0"
                />
                <span className="text-slate-300">
                  Reemplazar los clips existentes en la lista
                </span>
              </label>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-white/10 bg-[#18181C]/70 px-5 py-3.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 font-medium text-slate-300 hover:bg-white/10 hover:text-white transition"
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={handleValidateAndImport}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white shadow-lg shadow-indigo-500/25 hover:bg-indigo-500 transition"
            >
              <Check className="h-4 w-4" />
              <span>Importar Clips</span>
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
